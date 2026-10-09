'use strict';
require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const PORT        = process.env.PORT || 3000;
const BOT_TOKEN   = process.env.BOT_TOKEN || '';
const ADMIN_ID    = String(process.env.ADMIN_ID || '');
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
const GAME_NAME   = process.env.GAME_NAME || 'Standknife';
const SITE_URL    = WEBHOOK_URL || '';
const TG_NOTIFY   = String(process.env.TG_NOTIFY || 'false').toLowerCase() === 'true';

const rnd  = (min,max) => Math.floor(Math.random()*(max-min+1))+min;
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

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), err => {
      if (err) console.error('save error:', err.message);
    });
  }, 150);
}
process.on('SIGTERM', flushSave);
process.on('SIGINT',  flushSave);
function flushSave() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch {}
  process.exit(0);
}

function isAllowed(id) {
  const s = String(id);
  return s === ADMIN_ID || db.allowed.includes(s);
}
function getUser(id) {
  if (!db.users[id]) db.users[id] = { channel: null, awaiting: null, subscribed: true };
  const u = db.users[id];
  if (typeof u.subscribed !== 'boolean') u.subscribed = true;
  if (typeof u.channel   === 'undefined') u.channel   = null;
  if (typeof u.awaiting  === 'undefined') u.awaiting  = null;
  return u;
}

// ---------- SSE ----------
const sseClients = new Set();
const SSE_MAX = 150;

function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ---------- СЛАЙДЕР-ТОКЕНЫ (замена математической капчи) ----------
// Карта: token -> { expires }
// Токен одноразовый, живёт 3 минуты
const sliderTokens = new Map();
const TOKENS_MAX = 5000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sliderTokens) if (v.expires < now) sliderTokens.delete(k);
  if (sliderTokens.size > TOKENS_MAX) {
    const arr = [...sliderTokens.entries()].sort((a,b) => a[1].expires - b[1].expires);
    for (const [k] of arr.slice(0, sliderTokens.size - TOKENS_MAX)) sliderTokens.delete(k);
  }
}, 60_000).unref();

/**
 * Проверка данных слайдера на сервере.
 * Клиент присылает: duration (мс), eventCount (кол-во mousemove/touchmove событий), variance (дисперсия скорости).
 * Бот: очень быстро, мало событий, идеально равномерное движение.
 */
function verifySlider({ duration, eventCount, variance }) {
  if (typeof duration   !== 'number') return false;
  if (typeof eventCount !== 'number') return false;
  if (typeof variance   !== 'number') return false;
  // Слишком быстро — бот
  if (duration < 280) return false;
  // Слишком долго — подозрительно (> 60 сек)
  if (duration > 60_000) return false;
  // Мало событий — бот симулировал только mousedown + mouseup без промежуточных событий
  if (eventCount < 5) return false;
  // Идеально равномерное движение — бот
  // Дисперсия < 0.08 означает, что все шаги одинаковой длины
  if (variance < 0.08) return false;
  return true;
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
    const ip  = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '?';
    const now = Date.now();
    const arr = (ipHits.get(ip) || []).filter(t => now - t < 60000);
    if (arr.length >= max) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'rate_limited' });
    }
    arr.push(now);
    ipHits.set(ip, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipHits) {
    const fresh = arr.filter(t => now - t < 60000);
    if (fresh.length) ipHits.set(ip, fresh);
    else ipHits.delete(ip);
  }
}, 5 * 60_000).unref();

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Список промокодов (без кодов!)
app.get('/api/promos', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const promos = db.promos
    .slice()
    .sort((a,b) => new Date(b.addedAt) - new Date(a.addedAt))
    .map(p => ({ id: p.id, game: p.game, channel: p.channel, addedAt: p.addedAt }));
  res.json({ game: GAME_NAME, promos });
});

// SSE — реалтайм обновления
app.get('/api/events', (req, res) => {
  if (sseClients.size >= SSE_MAX) return res.status(503).end();
  res.setHeader('Content-Type',   'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',  'no-cache, no-store, no-transform');
  res.setHeader('Connection',     'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding',  'identity');
  res.flushHeaders();
  res.write(`retry: 5000\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  if (typeof res.flush === 'function') try { res.flush(); } catch {}
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); if (typeof res.flush === 'function') res.flush(); } catch {}
  }, 20000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ★ Верификация слайдера — клиент присылает timing-данные
// Лимит: 30 запросов в минуту с IP (не надо больше)
app.post('/api/verify-slider', rateLimit(30), (req, res) => {
  const { duration, eventCount, variance } = req.body || {};

  if (!verifySlider({ duration, eventCount, variance })) {
    return res.status(400).json({ error: 'bot_detected' });
  }

  const token = uid();
  sliderTokens.set(token, { expires: Date.now() + 3 * 60_000 });
  res.json({ token });
});

// ★ Раскрытие промокода по токену слайдера
// Лимит: 20 запросов в минуту с IP
app.post('/api/reveal', rateLimit(20), (req, res) => {
  const { token, promoId } = req.body || {};
  if (typeof token   !== 'string' || !token.trim())   return res.status(400).json({ error: 'bad_request' });
  if (typeof promoId !== 'string' || !promoId.trim()) return res.status(400).json({ error: 'bad_request' });

  const t = sliderTokens.get(token);
  if (!t || t.expires < Date.now()) {
    sliderTokens.delete(token);
    return res.status(400).json({ error: 'token_expired' });
  }
  sliderTokens.delete(token); // одноразовый токен

  const promo = db.promos.find(p => p.id === promoId);
  if (!promo) return res.status(404).json({ error: 'not_found' });

  res.json({ code: promo.code, game: promo.game, channel: promo.channel });
});

// Health-check (для UptimeRobot)
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- BOT ----------
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: !WEBHOOK_URL });

  if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/api/telegram/webhook`).catch(e => console.error('setWebHook:', e.message));
    app.post('/api/telegram/webhook', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  }

  const send = (chatId, text, opts) => bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts }).catch(() => {});

  const MAIN_KB = {
    reply_markup: {
      keyboard: [
        [{ text: '📝 Добавить промокод' }],
        [{ text: '📢 Сменить канал' }, { text: '📋 Мои промокоды' }],
      ],
      resize_keyboard: true, is_persistent: true
    }
  };
  const CANCEL_KB = {
    reply_markup: {
      keyboard: [[{ text: '❌ Отмена' }]],
      resize_keyboard: true, is_persistent: true
    }
  };

  function statusLine(u) {
    const ch = u.channel ? `<b>${u.channel}</b>` : '<i>не задан</i>';
    return `📢 Канал: ${ch}`;
  }

  async function showMenu(chatId, fromId, extra = '') {
    const u = getUser(fromId);
    const text =
      `🏠 <b>Главное меню</b>\n\n${statusLine(u)}\n\n` +
      `Что будешь делать?` + (extra ? `\n\n${extra}` : '');
    return send(chatId, text, MAIN_KB);
  }

  function addPromo(fromId, code, channel) {
    const promo = {
      id: uid(), code, game: GAME_NAME, channel,
      addedBy: fromId, addedAt: new Date().toISOString()
    };
    db.promos.push(promo);
    save();
    broadcast('promo-added', { id: promo.id, game: promo.game, channel: promo.channel, addedAt: promo.addedAt });
    if (TG_NOTIFY) notifyUsers(promo, fromId);
    return promo;
  }

  async function notifyUsers(promo, excludeId) {
    const ids = new Set();
    if (ADMIN_ID) ids.add(ADMIN_ID);
    for (const id of db.allowed) ids.add(String(id));
    const siteLine = SITE_URL ? `\n\n🌐 ${SITE_URL}` : '';
    const text =
      `🔔 <b>Новый промокод!</b>\n\n🎮 Игра: <b>${promo.game}</b>\n📢 Канал: <b>${promo.channel}</b>` + siteLine;
    for (const id of ids) {
      if (String(id) === String(excludeId)) continue;
      const u = db.users[id];
      if (u && u.subscribed === false) continue;
      await send(id, text, MAIN_KB);
      await new Promise(r => setTimeout(r, 80));
    }
  }

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const fromId = String(msg.from?.id || '');
    const text   = (msg.text || '').trim();

    if (text === '/start' || text === '/help') {
      if (!isAllowed(fromId)) {
        return send(chatId,
          `⛔ <b>Нет доступа.</b>\n\nТвой ID: <code>${fromId}</code>\n` +
          `Передай его админу, чтобы он добавил тебя командой:\n<code>/add ${fromId}</code>`);
      }
      const u = getUser(fromId);
      u.awaiting = null; save();
      if (!u.channel) {
        u.awaiting = 'channel'; save();
        return send(chatId,
          `👋 Привет!\n\nСначала задай <b>имя канала</b> — под ним на сайте будут публиковаться твои промокоды.\n\n` +
          `Например: <code>@mychannel</code> или <code>Мой канал</code>`, CANCEL_KB);
      }
      return showMenu(chatId, fromId);
    }

    if (!isAllowed(fromId)) return send(chatId, '⛔ Нет доступа.');

    const u = getUser(fromId);

    if (text === '❌ Отмена') { u.awaiting = null; save(); return showMenu(chatId, fromId, '❌ Отменено'); }

    if (text === '📋 Мои промокоды' || text === '/list') {
      const mine = db.promos.filter(p => p.addedBy === fromId);
      if (!mine.length) return send(chatId, '📭 У тебя пока нет промокодов', MAIN_KB);
      return send(chatId, '📋 <b>Твои промокоды:</b>\n\n' + mine.slice(-20).map(p =>
        `🔑 <code>${p.code}</code>\n   id: <code>${p.id}</code>\n   ${new Date(p.addedAt).toLocaleString('ru')}`
      ).join('\n\n'), MAIN_KB);
    }

    if (text === '📢 Сменить канал' || text === '/channel') {
      u.awaiting = 'channel'; save();
      return send(chatId,
        `📢 <b>Смена канала</b>\n\nСейчас: ${u.channel ? `<b>${u.channel}</b>` : '<i>не задан</i>'}\n\n` +
        `Отправь новое имя канала (например, <code>@new_channel</code>)`, CANCEL_KB);
    }

    if (text === '📝 Добавить промокод' || text === '/addpromo') {
      if (!u.channel) {
        u.awaiting = 'channel'; save();
        return send(chatId, `⚠️ Сначала нужно задать канал.\n\nОтправь имя канала:`, CANCEL_KB);
      }
      u.awaiting = 'promo'; save();
      return send(chatId,
        `📝 <b>Добавление промокода</b>\n\nКанал: <b>${u.channel}</b>\n\n` +
        `Отправь промокод для игры <b>${GAME_NAME}</b>:`, CANCEL_KB);
    }

    // Команды только для админа
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
    if (fromId === ADMIN_ID && text === '/stats') {
      return send(chatId,
        `📊 <b>Статистика</b>\n\n` +
        `🌐 SSE-соединений: ${sseClients.size}/${SSE_MAX}\n` +
        `🔐 Токенов в памяти: ${sliderTokens.size}\n` +
        `🎮 Промокодов: ${db.promos.length}\n` +
        `👥 Пользователей: ${Object.keys(db.users).length}\n` +
        `⏱ Uptime: ${Math.floor(process.uptime()/60)} мин\n` +
        `💾 RAM: ${Math.round(process.memoryUsage().rss/1024/1024)} МБ`);
    }

    if (!text) return;

    if (u.awaiting === 'channel' || !u.channel) {
      if (text.length > 100) return send(chatId, '❌ Слишком длинное имя (макс 100)', CANCEL_KB);
      const looksLikePromo = /^[A-Z0-9_\-]{5,}$/.test(text) && !text.startsWith('@');
      if (looksLikePromo && !u.channel) {
        return send(chatId,
          `🤔 Похоже, это <b>промокод</b>, а не имя канала.\n\n` +
          `Сначала задай имя канала (например, <code>@mychannel</code>) — потом сможешь добавлять промокоды.`, CANCEL_KB);
      }
      u.channel = text; u.awaiting = null; save();
      broadcast('user-updated', { userId: fromId, channel: u.channel });
      return send(chatId, `✅ Канал сохранён: <b>${text}</b>\n\nТеперь можешь добавлять промокоды.`, MAIN_KB);
    }

    if (u.awaiting === 'promo') {
      if (text.length > 200) return send(chatId, '❌ Слишком длинный код (макс 200)', CANCEL_KB);
      const promo = addPromo(fromId, text, u.channel);
      u.awaiting = null; save();
      return send(chatId,
        `✅ <b>Промокод добавлен!</b>\n\n🔑 <code>${text}</code>\n📢 ${u.channel}\n🆔 <code>${promo.id}</code>`, MAIN_KB);
    }

    if (u.channel && /^[A-Z0-9_\-]{4,}$/.test(text)) {
      if (text.length > 200) return send(chatId, '❌ Слишком длинный код', MAIN_KB);
      const promo = addPromo(fromId, text, u.channel);
      return send(chatId,
        `✅ <b>Промокод добавлен!</b>\n\n🔑 <code>${text}</code>\n🆔 <code>${promo.id}</code>`, MAIN_KB);
    }

    return showMenu(chatId, fromId, 'Выбери действие на клавиатуре 👇');
  });

  bot.on('polling_error', e => console.error('polling_error:', e.message));
  console.log('🤖 Telegram bot запущен');
}

app.listen(PORT, () => console.log(`🚀 Сайт: http://localhost:${PORT}`));
