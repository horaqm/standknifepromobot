'use strict';
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const PORT      = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID  = String(process.env.ADMIN_ID || '');
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');
const GAME_NAME = process.env.GAME_NAME || 'Standknife';

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- ХРАНИЛИЩЕ ----------
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'promo.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ game: GAME_NAME, code: null, updatedAt: null }, null, 2));
}
function readPromo() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { game: GAME_NAME, code: null, updatedAt: null }; }
}
function writePromo(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---------- КАПЧА ----------
const captchas = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of captchas) if (c.expires < now) captchas.delete(id);
}, 60 * 1000).unref();

function makeCaptcha() {
  const type = rnd(0, 2);
  let q, answer, display;

  if (type === 0) {
    const a = rnd(3, 19), b = rnd(2, 12);
    q = `Сколько будет ${a} + ${b}?`;
    answer = String(a + b);
  } else if (type === 1) {
    const a = rnd(12, 30), b = rnd(2, 9);
    q = `Сколько будет ${a} − ${b}?`;
    answer = String(a - b);
  } else {
    const emoji = pick(['🍎','⭐','🎁','🍋','🚀','🔔','🍀','💎','🎯','🔥']);
    const n = rnd(2, 6);
    q = 'Сколько здесь символов?';
    display = Array(n).fill(emoji).join(' ');
    answer = String(n);
  }

  const id = crypto.randomBytes(16).toString('hex');
  captchas.set(id, { answer, expires: Date.now() + CAPTCHA_TTL, attempts: 0 });
  return { id, q, display };
}

// ---------- EXPRESS ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const ipHits = new Map();
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let arr = ipHits.get(ip) || [];
    arr = arr.filter((t) => now - t < 60_000);
    if (arr.length >= maxPerMin) return res.status(429).json({ error: 'rate_limited' });
    arr.push(now);
    ipHits.set(ip, arr);
    next();
  };
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/api/status', (_req, res) => {
  const p = readPromo();
  res.json({ game: p.game, available: !!p.code, updatedAt: p.updatedAt });
});

app.post('/api/captcha', rateLimit(15), (_req, res) => {
  res.json(makeCaptcha());
});

app.post('/api/reveal', rateLimit(30), (req, res) => {
  const { id, answer } = req.body || {};
  if (typeof id !== 'string' || typeof answer !== 'string') {
    return res.status(400).json({ error: 'bad_request' });
  }

  const c = captchas.get(id);
  if (!c || c.expires < Date.now()) {
    captchas.delete(id);
    return res.status(400).json({ error: 'captcha_expired' });
  }

  c.attempts += 1;
  if (c.attempts > MAX_ATTEMPTS) {
    captchas.delete(id);
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  if (answer.trim() !== c.answer) {
    return res.status(400).json({ error: 'wrong_answer' });
  }

  captchas.delete(id);

  const p = readPromo();
  if (!p.code) return res.status(404).json({ error: 'no_promo' });

  res.json({ game: p.game, code: p.code });
});

// ---------- TELEGRAM BOT ----------
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: !WEBHOOK_URL });

  if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/api/telegram/webhook`)
       .catch((e) => console.error('setWebHook failed:', e.message));

    app.post('/api/telegram/webhook', (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
  }

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const fromId = String(msg.from?.id || '');
    const text = (msg.text || '').trim();

    if (ADMIN_ID && fromId !== ADMIN_ID) {
      bot.sendMessage(chatId, '⛔ Нет доступа.').catch(() => {});
      return;
    }

    if (text === '/start' || text === '/help') {
      bot.sendMessage(chatId,
        `👋 Привет!\n\nОтправь промокод для игры ${GAME_NAME}, и он автоматически появится на сайте.\n\n` +
        `Команды:\n/current — текущий промокод\n/clear — удалить промокод\n/help — справка`
      ).catch(() => {});
      return;
    }

    if (text === '/current') {
      const p = readPromo();
      bot.sendMessage(chatId, p.code
        ? `🎮 ${p.game}\n🔑 ${p.code}\n🕒 ${p.updatedAt || '—'}`
        : 'Промокод сейчас не установлен.'
      ).catch(() => {});
      return;
    }

    if (text === '/clear') {
      writePromo({ game: GAME_NAME, code: null, updatedAt: null });
      bot.sendMessage(chatId, '🗑 Промокод удалён.').catch(() => {});
      return;
    }

    if (!text) return;
    if (text.length > 200) {
      bot.sendMessage(chatId, '❌ Слишком длинный промокод (макс. 200).').catch(() => {});
      return;
    }

    writePromo({ game: GAME_NAME, code: text, updatedAt: new Date().toISOString() });
    bot.sendMessage(chatId, `✅ Промокод обновлён:\n${text}`).catch(() => {});
  });

  bot.on('polling_error', (e) => console.error('polling_error:', e.message));
  console.log('🤖 Telegram bot запущен');
}

app.listen(PORT, () => console.log(`🚀 Сайт: http://localhost:${PORT}`));