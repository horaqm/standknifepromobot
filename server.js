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
const TG_NOTIFY   = String(process.env.TG_NOTIFY || 'false').toLowerCase() === 'true';

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

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => {
      if (err) console.error('save error:', err.message);
    });
  }, 150);
}
process.on('SIGTERM', flushSave);
process.on('SIGINT', flushSave);
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
  if (typeof u.channel === 'undefined') u.channel = null;
  if (typeof u.awaiting === 'undefined') u.awaiting = null;
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

// ---------- ТОКЕНЫ КАПЧИ ----------
const sliderTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sliderTokens) if (v.expires < now) sliderTokens.delete(k);
}, 30_000).unref();

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
    if (arr.length >= max) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'rate_limited' });
    }
    arr.push(now); ipHits.set(ip, arr);
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

app.get('/api/promos', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const promos = db.promos
    .slice()
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .map(p => ({ id: p.id, game: p.game, channel: p.channel, addedAt: p.addedAt }));
  res.json({ game: GAME_NAME, promos });
});

app.get('/api/events', (req, res) => {
  if (sseClients.size >= SSE_MAX) return res.status(503).end();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders();

  res.write(`retry: 5000\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  if (typeof res.flush === 'function') try { res.flush(); } catch {}

  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }, 20000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ===== ПРОВЕРКА СЛАЙДЕРА (мягкая) =====
app.post('/api/verify-slider', rateLimit(60), (req, res) => {
  const { duration, eventCount, variance, maxJump, totalDist } = req.body || {};

  const d  = Number(duration) || 0;
  const ec = Number(eventCount) || 0;
  const v  = Number(variance) || 0;

  if (d < 80)    return res.status(400).json({ error: 'too_fast' });
  if (ec < 3)    return res.status(400).json({ error: 'too_few_events' });
  if (d > 12000) return res.status(400).json({ error: 'too_slow' });

  if (maxJump !== undefined && totalDist !== undefined && totalDist > 0) {
    const jumpRatio = maxJump / totalDist;
    if (jumpRatio > 0.9 && ec < 6) return res.status(400).json({ error: 'teleport' });
  }

  if (v > 0 && v < 0.005 && ec >= 10) return res.status(400).json({ error: 'too_smooth' });

  const token = uid();
  sliderTokens.set(token, { expires: Date.now() + 60_000 });
  res.json({ token });
});

app.post('/api/reveal', rateLimit(120), (req, res) => {
  const { token, promoId } = req.body || {};
  if (typeof token !== 'string' || typeof promoId !== 'string')
    return res.status(400).json({ error: 'bad_request' });

  const t = sliderTokens.get(token);
  if (!t || t.expires < Date.now()) {
    sliderTokens.delete(token);
    return res.status(400).json({ error: 'captcha_expired' });
  }
  sliderTokens.delete(token);

  const promo = db.promos.find(p => p.id === promoId);
  if (!promo) return res.status(404).json({ error: 'not_found' });

  res.json({ code: promo.code, game: promo.game, channel: promo.channel });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- BOT ----------
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: !WEBHOOK_URL });

  // Если есть WEBHOOK_URL — сначала СТИРАЕМ старый webhook, потом ставим новый.
  // Это убирает 409 Conflict от предыдущих деплоев.
  if (WEBHOOK_URL) {
    (async () => {
      try {
        await bot.deleteWebHook({ drop_pending_updates: true });
        console.log('🧹 Старый webhook удалён');
      } catch (e) {
        console.log('deleteWebHook:', e.message);
      }
      // Небольшая пауза, чтобы Telegram обработал удаление
      await new Promise(r => setTimeout(r, 1500));
      try {
        await bot.setWebHook(`${WEBHOOK_URL}/api/telegram/webhook`, {
          drop_pending_updates: true,
          allowed_updates: ['message', 'callback_query']
        });
        console.log('✅ Webhook установлен:', WEBHOOK_URL);
      } catch (e) {
        console.error('setWebHook:', e.message);
      }
    })();

    app.post('/api/telegram/webhook', (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
  }

  const send = (chatId, text, opts) => bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts }).catch(() => {});

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

  const CANCEL_KB = {
    reply_markup: {
      keyboard: [[{ text: '❌ Отмена' }]],
      resize_keyboard: true,
      is_persistent: true
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
      id: uid(),
      code,
      game: GAME_NAME,
      channel,
      addedBy: fromId,
      addedAt: new Date().toISOString()
    };
    db.promos.push(promo);
    save();

    broadcast('promo-added', {
      id: promo.id, game: promo.game, channel: promo.channel, addedAt: promo.addedAt
    });

    if (TG_NOTIFY) notifyUsers(promo, fromId);
    return promo;
  }

  async function notifyUsers(promo, excludeId) {
    const ids = new Set();
    if (ADMIN_ID) ids.add(ADMIN_ID);
    for (const id of db.allowed) ids.add(String(id));

    const siteLine = WEBHOOK_URL ? `\n\n🌐 ${WEBHOOK_URL}` : '';
    const text =
      `🔔 <b>Новый промокод!</b>\n\n` +
      `🎮 Игра: <b>${promo.game}</b>\n` +
      `📢 Канал: <b>${promo.channel}</b>` +
      siteLine;

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

    if (text === '❌ Отмена') {
      u.awaiting = null; save();
      return showMenu(chatId, fromId, '❌ Отменено');
    }

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
        `Отправь новое имя канала (например, <code>@new_channel</code>)`,
        CANCEL_KB
      );
    }

    if (text === '📝 Добавить промокод' || text === '/addpromo') {
      if (!u.channel) {
        u.awaiting = 'channel'; save();
        return send(chatId, `⚠️ Сначала задай канал.\n\nОтправь имя канала:`, CANCEL_KB);
      }
      u.awaiting = 'promo'; save();
      return send(chatId,
        `📝 <b>Добавление промокода</b>\n\nКанал: <b>${u.channel}</b>\n\n` +
        `Отправь промокод для игры <b>${GAME_NAME}</b>:`,
        CANCEL_KB
      );
    }

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
        `🌐 SSE: ${sseClients.size}/${SSE_MAX}\n` +
        `🔐 Токенов капчи: ${sliderTokens.size}\n` +
        `🎮 Промокодов: ${db.promos.length}\n` +
        `👥 Пользователей: ${Object.keys(db.users).length}\n` +
        `⏱ Uptime: ${Math.floor(process.uptime()/60)} мин\n` +
        `💾 RAM: ${Math.round(process.memoryUsage().rss/1024/1024)} МБ`
      );
    }

    if (!text) return;

    if (u.awaiting === 'channel' || !u.channel) {
      if (text.length > 100) return send(chatId, '❌ Слишком длинное имя (макс 100)', CANCEL_KB);
      const looksLikePromo = /^[A-Z0-9_\-]{5,}$/.test(text) && !text.startsWith('@');
      if (looksLikePromo && !u.channel) {
        return send(chatId,
          `🤔 Похоже, это <b>промокод</b>, а не имя канала.\n\n` +
          `Сначала задай имя канала (например, <code>@mychannel</code>) — потом сможешь добавлять промокоды.`,
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

    if (u.awaiting === 'promo') {
      if (text.length > 200) return send(chatId, '❌ Слишком длинный код (макс 200)', CANCEL_KB);
      const promo = addPromo(fromId, text, u.channel);
      u.awaiting = null; save();
      return send(chatId,
        `✅ <b>Промокод добавлен!</b>\n\n` +
        `🔑 <code>${text}</code>\n` +
        `📢 ${u.channel}\n` +
        `🆔 <code>${promo.id}</code>`,
        MAIN_KB
      );
    }

    if (u.channel && /^[A-Z0-9_\-]{4,}$/.test(text)) {
      if (text.length > 200) return send(chatId, '❌ Слишком длинный код', MAIN_KB);
      const promo = addPromo(fromId, text, u.channel);
      return send(chatId,
        `✅ <b>Промокод добавлен!</b>\n\n🔑 <code>${text}</code>\n🆔 <code>${promo.id}</code>`,
        MAIN_KB
      );
    }

    return showMenu(chatId, fromId, 'Выбери действие на клавиатуре 👇');
  });

  bot.on('polling_error', e => {
    if (!e.message.includes('409')) console.error('polling_error:', e.message);
  });
  console.log('🤖 Telegram bot запущен');
}

app.listen(PORT, () => console.log(`🚀 Сайт: http://localhost:${PORT}`));
