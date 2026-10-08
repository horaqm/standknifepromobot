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

const rnd = (min,max)=>Math.floor(Math.random()*(max-min+1))+min;
const pick = a => a[Math.floor(Math.random()*a.length)];
const uid = () => crypto.randomBytes(6).toString('hex');

// ---------- БАЗА (один JSON-файл) ----------
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

// список промокодов БЕЗ кодов
app.get('/api/promos', (_req, res) => {
  const promos = db.promos
    .slice()
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .map(p => ({ id: p.id, game: p.game, channel: p.channel, addedAt: p.addedAt }));
  res.json({ game: GAME_NAME, promos });
});

app.post('/api/captcha', rateLimit(200), (_req, res) => res.json(makeCaptcha()));

app.post('/api/reveal', rateLimit(200), (req, res) => {
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

  const send = (chatId, text, opts) => bot.sendMessage(chatId, text, opts).catch(() => {});

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const fromId = String(msg.from?.id || '');
    const text   = (msg.text || '').trim();

    // /start и /help
    if (text === '/start' || text === '/help') {
      if (!isAllowed(fromId)) {
        return send(chatId,
          `⛔ Нет доступа.\n\nТвой ID: ${fromId}\nПередай его админу, чтобы он добавил тебя: /add ${fromId}`
        );
      }
      const user = db.users[fromId];
      if (!user || !user.channel) {
        return send(chatId,
          `👋 Привет!\n\nОтправь username своего Telegram-канала (например, @mychannel).\n` +
          `Под этим именем на сайте будут публиковаться твои промокоды.`
        );
      }
      return send(chatId,
        `👋 Привет, ${user.channel}!\n\n` +
        `Отправь промокод для игры ${GAME_NAME} — он появится на сайте.\n\n` +
        `Команды:\n` +
        `/list — твои промокоды\n` +
        `/del <id> — удалить промокод\n` +
        `/clear — удалить все свои\n` +
        `/channel @new — сменить канал\n` +
        `/help — справка`
      );
    }

    if (!isAllowed(fromId)) return send(chatId, '⛔ Нет доступа.');

    // команды админа
    if (text.startsWith('/add ') && fromId === ADMIN_ID) {
      const id = text.slice(5).trim();
      if (!/^\d+$/.test(id)) return send(chatId, '❌ Формат: /add 123456789');
      if (db.allowed.includes(id)) return send(chatId, '✅ Уже добавлен');
      db.allowed.push(id); save();
      return send(chatId, `✅ Добавлен: ${id}`);
    }
    if (text.startsWith('/remove ') && fromId === ADMIN_ID) {
      const id = text.slice(8).trim();
      const i = db.allowed.indexOf(id);
      if (i === -1) return send(chatId, '❌ Не найден');
      db.allowed.splice(i, 1); save();
      return send(chatId, `🗑 Удалён: ${id}`);
    }
    if (text === '/users' && fromId === ADMIN_ID) {
      if (!db.allowed.length) return send(chatId, 'Список пуст');
      return send(chatId, '👥 Разрешённые:\n' + db.allowed.map(id => {
        const u = db.users[id];
        return `${id} — ${u ? u.channel : '(не зареган)'}`;
      }).join('\n'));
    }

    // смена канала
    if (text.startsWith('/channel ')) {
      const ch = text.slice(9).trim();
      if (!ch) return send(chatId, '❌ Пустое имя');
      if (!db.users[fromId]) db.users[fromId] = {};
      db.users[fromId].channel = ch;
      save();
      return send(chatId, `✅ Канал изменён: ${ch}`);
    }

    // свои промокоды
    if (text === '/list') {
      const mine = db.promos.filter(p => p.addedBy === fromId);
      if (!mine.length) return send(chatId, 'У тебя пока нет промокодов');
      return send(chatId, '📋 Твои промокоды:\n\n' + mine.map(p =>
        `🔑 ${p.code}\n   id: ${p.id}\n   ${new Date(p.addedAt).toLocaleString('ru')}`
      ).join('\n\n'));
    }
    if (text.startsWith('/del ')) {
      const id = text.slice(5).trim();
      const i = db.promos.findIndex(p => p.id === id && p.addedBy === fromId);
      if (i === -1) return send(chatId, '❌ Не найден');
      db.promos.splice(i, 1); save();
      return send(chatId, '🗑 Удалён');
    }
    if (text === '/clear') {
      db.promos = db.promos.filter(p => p.addedBy !== fromId); save();
      return send(chatId, '🗑 Все твои промокоды удалены');
    }

    if (!text) return;

    // первое сообщение = имя канала
    const user = db.users[fromId] || {};
    if (!user.channel) {
      if (text.length > 100) return send(chatId, '❌ Слишком длинное имя канала');
      user.channel = text;
      user.registeredAt = new Date().toISOString();
      db.users[fromId] = user;
      save();
      return send(chatId, `✅ Канал сохранён: ${text}\n\nТеперь отправляй промокоды — они появятся на сайте.`);
    }

    // промокод
    if (text.length > 200) return send(chatId, '❌ Слишком длинный код (макс. 200)');
    const promo = {
      id: uid(),
      code: text,
      game: GAME_NAME,
      channel: user.channel,
      addedBy: fromId,
      addedAt: new Date().toISOString()
    };
    db.promos.push(promo);
    save();
    send(chatId, `✅ Промокод добавлен:\n${text}\nid: ${promo.id}\n\nОн уже на сайте.`);
  });

  bot.on('polling_error', e => console.error('polling_error:', e.message));
  console.log('🤖 Telegram bot запущен');
}

app.listen(PORT, () => console.log(`🚀 Сайт: http://localhost:${PORT}`));
