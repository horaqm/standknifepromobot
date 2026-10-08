'use strict';
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const PORT        = process.env.PORT || 3000;
const BOT_TOKEN   = process.env.BOT_TOKEN || '';
const ADMIN_ID    = String(process.env.ADMIN_ID || '');
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
const GAME_NAME   = process.env.GAME_NAME || 'Standknife';

const rnd  = (min,max)=>Math.floor(Math.random()*(max-min+1))+min;
const pick = a => a[Math.floor(Math.random()*a.length)];
const uid  = () => crypto.randomBytes(6).toString('hex');

// ---------- БАЗА ----------
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { allowed: [], users: {}, promos: [] };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
db.allowed = db.allowed || [];
db.users   = db.users   || {};
db.promos  = db.promos  || [];
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function isAllowed(id) {
  const s = String(id);
  return s === ADMIN_ID || db.allowed.includes(s);
}
function getUser(id) {
  if (!db.users[id]) db.users[id] = { channel: null, awaiting: null };
  return db.users[id];
}

// ---------- SSE (живые обновления) ----------
const sseClients = new Set();
function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ---------- КАПЧА ----------
const captchas = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of captchas) if (v.expires < now) captchas.delete(k);
}, 60_000).unref();

function makeCaptcha() {
  const t = rnd(0, 2);
  let q, answer, display;
  if (t === 0) { const a=rnd(3,19), b=rnd(2,12); q=`Сколько будет ${a} + ${b}?`; answer=String(a+b); }
  else if (t === 1) { const a=rnd(12,30), b=rnd(2,9); q=`Сколько будет ${a} − ${b}?`; answer=String(a-b); }
  else { const e=pick(['🍎','⭐','🎁','🍋','🚀','🔔','🍀','💎','🎯','🔥']); const n=rnd(2,6); q='Сколько здесь символов?'; display=Array(n).fill(e).join(' '); answer=String(n); }
  const id = uid();
  captchas.set(id, { answer, expires: Date.now()+5*60_000, attempts: 0 });
  return { id, q, display };
}

// ---------- EXPRESS ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const ipHits = new Map();
function rateLimit(max) {
  return (req, res, next) => {
    const ip = req.ip || '?';
    const now = Date.now();
    const arr = (ipHits.get(ip) || []).filter(t => now - t < 60000);
    if (arr.length >= max) return res.status(429).json({ error: 'rate_limited' });
    arr.push(now); ipHits.set(ip, arr);
    next();
  };
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// список промокодов
app.get('/api/promos', (_req, res) => {
  const promos = db.promos
    .slice()
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .map(p => ({ id: p.id, game: p.game, channel: p.channel, addedAt: p.addedAt }));
  res.json({ game: GAME_NAME, promos });
});

// SSE — живые обновления
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // начальное приветствие
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);

  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

app.post('/api/captcha', rateLimit(300), (_req, res) => res.json(makeCaptcha()));

app.post('/api/reveal', rateLimit(300), (req, res) => {
  const { captchaId, answer, promoId } = req.body || {};
  if (typeof captchaId !== 'string' || typeof answer !== 'string' || typeof promoId !== 'string')
    return res.status(400).json({ error: 'bad_request' });

  const c = captchas.get(captchaId);
  if (!c || c.expires < Date.now()) { captchas.delete(captchaId); return res.status(400).json({ error: 'captcha_expired' }); }

  c.attempts++;
  if (c.attempts > 3) { captchas.delete(captchaId); return res.status(429).json({ error: 'too_many_attempts' }); }
  if (answer.trim() !== c.answer) return res.status(400).json({ error: 'wrong_answer' });

  captchas.delete(captchaId);
  const promo = db.promos.find(p => p.id === promoId);
  if (!promo) return res.status(404).json({ error: 'not_found' });

  res.json({ code: promo.code, game: promo.game, channel: promo.channel });
});

// ---------- BOT ----------
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: !WEBHOOK_URL });

  if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/api/telegram/webhook`).catch(e => console.error('setWebHook:', e.message));
    app.post('/api/telegram/webhook', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  }

  const send = (chatId, text, opts) => bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts }).catch(() => {});

  // главное меню
  const MAIN_KB = {
    reply_markup: {
      keyboard: [
        [{ text: '📝 Добавить промокод' }],
        [{ text: '📢 Сменить канал' }, { text: '📋 Мои промокоды' }],
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  };

  // клавиатура "отмена" (когда ждём ввод)
  const CANCEL_KB = {
    reply_markup: {
      keyboard: [[{ text: '❌ Отмена' }]],
      resize_keyboard: true,
      is_persistent: true
    }
  };

  function statusLine(u) {
    if (!u.channel) return '📢 Канал: <i>не задан</i>';
    return `📢 Канал: <b>${u.channel}</b>`;
  }

  async function showMenu(chatId, fromId, extra = '') {
    const u = getUser(fromId);
    const text =
      `🏠 <b>Главное меню</b>\n\n${statusLine(u)}\n\n` +
      `Что будешь делать?` + (extra ? `\n\n${extra}` : '');
    return send(chatId, text, MAIN_KB);
  }

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const fromId = String(msg.from?.id || '');
    const text   = (msg.text || '').trim();

    // /start
    if (text === '/start' || text === '/help') {
      if (!isAllowed(fromId)) {
        return send(chatId,
          `⛔ <b>Нет доступа.</b>\n\nТвой ID: <code>${fromId}</code>\n` +
          `Передай его админу, чтобы он добавил тебя командой:\n<code>/add ${fromId}</code>`
        );
      }
      const u = getUser(fromId);
      u.awaiting = null;
      save();

      if (!u.channel) {
        u.awaiting = 'channel';
        save();
        return send(chatId,
          `👋 Привет!\n\nСначала задай <b>имя канала</b> — под ним на сайте будут публиковаться твои промокоды.\n\n` +
          `Например: <code>@mychannel</code> или <code>Мой канал</code>`,
          CANCEL_KB
        );
      }
      return showMenu(chatId, fromId);
    }

    if (!isAllowed(fromId)) return send(chatId, '⛔ Нет доступа.');

    const u = getUser(fromId);

    // --- общие кнопки ---
    if (text === '❌ Отмена') {
      u.awaiting = null; save();
      return showMenu(chatId, fromId, '❌ Отменено');
    }

    if (text === '📋 Мои промокоды' || text === '/list') {
      const mine = db.promos.filter(p => p.addedBy === fromId);
      if (!mine.length) return send(chatId, '📭 У тебя пока нет промокодов', MAIN_KB);
      return send(chatId, '📋 <b>Твои промокоды:</b>\n\n' + mine.map(p =>
        `🔑 <code>${p.code}</code>\n   id: <code>${p.id}</code>\n   ${new Date(p.addedAt).toLocaleString('ru')}`
      ).join('\n\n'), MAIN_KB);
    }

    if (text === '📢 Сменить канал' || text === '/channel') {
      u.awaiting = 'channel'; save();
      return send(chatId,
        `📢 <b>Смена канала</b>\n\nСейчас: ${u.channel ? `<b>${u.channel}</b>` : '<i>не задан</i>'}\n\n` +
        `Отправь новое имя канала (например, <code>@new_channel</code>)`,
        CANCEL_KB
      );
    }

    if (text === '📝 Добавить промокод' || text === '/addpromo') {
      if (!u.channel) {
        u.awaiting = 'channel'; save();
        return send(chatId,
          `⚠️ Сначала нужно задать канал.\n\nОтправь имя канала:`,
          CANCEL_KB
        );
      }
      u.awaiting = 'promo'; save();
      return send(chatId,
        `📝 <b>Добавление промокода</b>\n\nКанал: <b>${u.channel}</b>\n\n` +
        `Отправь промокод для игры <b>${GAME_NAME}</b>:`,
        CANCEL_KB
      );
    }

    // --- админ-команды ---
    if (fromId === ADMIN_ID && text.startsWith('/add ')) {
      const id = text.slice(5).trim();
      if (!/^\d+$/.test(id)) return send(chatId, '❌ Формат: <code>/add 123456789</code>');
      if (db.allowed.includes(id)) return send(chatId, '✅ Уже добавлен');
      db.allowed.push(id); save();
      return send(chatId, `✅ Добавлен: <code>${id}</code>`);
    }
    if (fromId === ADMIN_ID && text.startsWith('/remove ')) {
      const id = text.slice(8).trim();
      const i = db.allowed.indexOf(id);
      if (i === -1) return send(chatId, '❌ Не найден');
      db.allowed.splice(i, 1); save();
      return send(chatId, `🗑 Удалён: <code>${id}</code>`);
    }
    if (fromId === ADMIN_ID && text === '/users') {
      if (!db.allowed.length) return send(chatId, '📭 Список пуст');
      return send(chatId, '👥 <b>Разрешённые:</b>\n\n' + db.allowed.map(id => {
        const usr = db.users[id];
        return `<code>${id}</code> — ${usr && usr.channel ? usr.channel : '<i>не зареган</i>'}`;
      }).join('\n'));
    }
    if (fromId === ADMIN_ID && text.startsWith('/del ')) {
      const id = text.slice(5).trim();
      const i = db.promos.findIndex(p => p.id === id);
      if (i === -1) return send(chatId, '❌ Не найден');
      db.promos.splice(i, 1); save();
      broadcast('promo-removed', { id });
      return send(chatId, '🗑 Удалён');
    }

    if (!text) return;

    // --- состояние: ожидание имени канала ---
    if (u.awaiting === 'channel' || !u.channel) {
      if (text.length > 100) return send(chatId, '❌ Слишком длинное имя (макс 100)', CANCEL_KB);

      // эвристика: если очень похоже на промокод (заглавные+цифры+подчёркивания и без @),
      // переспросим, чтобы не записать промокод как имя канала
      const looksLikePromo = /^[A-Z0-9_\-]{5,}$/.test(text) && !text.startsWith('@');
      if (looksLikePromo && !u.channel) {
        return send(chatId,
          `🤔 Похоже, это <b>промокод</b>, а не имя канала.\n\n` +
          `Сначала задай имя канала (например, <code>@mychannel</code>) — потом сможешь добавлять промокоды.\n\n` +
          `Если это всё-таки имя канала — отправь ещё раз.`,
          CANCEL_KB
        );
      }

      u.channel = text;
      u.awaiting = null;
      save();
      broadcast('user-updated', { userId: fromId, channel: u.channel });
      return send(chatId,
        `✅ Канал сохранён: <b>${text}</b>\n\nТеперь можешь добавлять промокоды.`,
        MAIN_KB
      );
    }

    // --- состояние: ожидание промокода ---
    if (u.awaiting === 'promo') {
      if (text.length > 200) return send(chatId, '❌ Слишком длинный код (макс 200)', CANCEL_KB);
      const promo = {
        id: uid(),
        code: text,
        game: GAME_NAME,
        channel: u.channel,
        addedBy: fromId,
        addedAt: new Date().toISOString()
      };
      db.promos.push(promo);
      save();
      u.awaiting = null; save();

      // мгновенно оповещаем браузеры
      broadcast('promo-added', {
        id: promo.id, game: promo.game, channel: promo.channel, addedAt: promo.addedAt
      });

      return send(chatId,
        `✅ <b>Промокод добавлен!</b>\n\n` +
        `🔑 <code>${text}</code>\n` +
        `📢 ${u.channel}\n` +
        `🆔 <code>${promo.id}</code>\n\n` +
        `Уже на сайте.`,
        MAIN_KB
      );
    }

    // --- свободный текст (не в режиме) ---
    // если это похоже на промокод и канал есть — добавляем сразу
    if (u.channel && /^[A-Z0-9_\-]{4,}$/.test(text)) {
      const promo = {
        id: uid(),
        code: text,
        game: GAME_NAME,
        channel: u.channel,
        addedBy: fromId,
        addedAt: new Date().toISOString()
      };
      db.promos.push(promo); save();
      broadcast('promo-added', {
        id: promo.id, game: promo.game, channel: promo.channel, addedAt: promo.addedAt
      });
      return send(chatId,
        `✅ <b>Промокод добавлен!</b>\n\n🔑 <code>${text}</code>\n🆔 <code>${promo.id}</code>`,
        MAIN_KB
      );
    }

    return showMenu(chatId, fromId, 'Выбери действие на клавиатуре 👇');
  });

  bot.on('polling_error', e => console.error('polling_error:', e.message));
  console.log('🤖 Telegram bot запущен');
}

app.listen(PORT, () => console.log(`🚀 Сайт: http://localhost:${PORT}`));
