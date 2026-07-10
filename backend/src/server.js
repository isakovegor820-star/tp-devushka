import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { SYSTEM_PROMPT } from './prompt.js';
import { validateLead, saveLead, notifyTelegram } from './lead.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- config (all overridable via env) -------------------------------------
const PORT = Number(process.env.PORT || 3031);
const MODEL = process.env.MODEL || 'claude-opus-4-8';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 24); // last N messages kept
const MAX_MSG_CHARS = Number(process.env.MAX_MSG_CHARS || 8000); // per-message cap
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 30); // chat req/min/IP
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://slava-hunter.ru,https://www.slava-hunter.ru,http://localhost:3031,http://127.0.0.1:3031'
).split(',').map((s) => s.trim()).filter(Boolean);

// Anthropic client — constructed only if a key is present, so the server can
// still boot (and serve /api/health) without one.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropic) {
  console.warn('[warn] ANTHROPIC_API_KEY is not set — /api/chat will return 503 until it is.');
}

// ---- app ------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind nginx — needed for correct client IP / rate limit

app.use(cors({
  origin(origin, cb) {
    // allow non-browser clients (curl, server-to-server) which send no Origin
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json({ limit: '64kb' }));

// minimal request log (no message content — legal questions are sensitive)
app.use((req, res, next) => {
  const t = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
});

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте через минуту.' },
});

// заявок с одного IP нужно сильно меньше, чем сообщений в чат
const leadLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_LEAD_PER_MIN || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Слишком много заявок. Попробуйте через минуту.' },
});

// static test page (public/test.html) — handy for local end-to-end checks
app.use(express.static(join(__dirname, '..', 'public')));

// ---- health ---------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, configured: Boolean(anthropic) });
});

// ---- validation -----------------------------------------------------------
function normalizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Поле "messages" должно быть непустым массивом.' };
  }
  const cleaned = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return { error: 'Каждое сообщение должно иметь role "user" или "assistant".' };
    }
    if (typeof m.content !== 'string' || m.content.trim() === '') {
      return { error: 'Поле "content" должно быть непустой строкой.' };
    }
    cleaned.push({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) });
  }
  // keep only the tail, and ensure it starts with a user turn
  let tail = cleaned.slice(-MAX_HISTORY);
  while (tail.length && tail[0].role !== 'user') tail = tail.slice(1);
  if (tail.length === 0) return { error: 'Нужно хотя бы одно сообщение от пользователя.' };
  return { messages: tail };
}

// ---- chat -----------------------------------------------------------------
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { messages, error } = normalizeMessages(req.body?.messages);
  if (error) return res.status(400).json({ error });

  if (!anthropic) {
    return res.status(503).json({ error: 'Сервис временно недоступен (LLM не настроен).' });
  }

  const wantStream = req.body?.stream !== false; // stream by default

  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  };

  // ----- non-streaming (simple JSON) -----
  if (!wantStream) {
    try {
      const msg = await anthropic.messages.create(params);
      const reply = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return res.json({ reply, usage: msg.usage, stop_reason: msg.stop_reason });
    } catch (err) {
      return res.status(statusFor(err)).json({ error: userError(err) });
    }
  }

  // ----- streaming (SSE) -----
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx proxy buffering for SSE
  });
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let stream;
  try {
    stream = anthropic.messages.stream(params);

    // abort upstream if the browser disconnects
    req.on('close', () => { try { stream.abort(); } catch { /* noop */ } });

    stream.on('text', (delta) => send({ type: 'delta', text: delta }));

    const final = await stream.finalMessage();
    send({ type: 'done', usage: final.usage, stop_reason: final.stop_reason });
    res.end();
  } catch (err) {
    send({ type: 'error', error: userError(err) });
    res.end();
  }
});

// map SDK errors -> user-facing message / status, without leaking internals
function statusFor(err) {
  const s = err?.status;
  if (s === 429) return 429;
  if (s === 400 || s === 401 || s === 403) return 502; // config/auth problem on our side
  return 502;
}
function userError(err) {
  if (err?.status === 429) return 'Сейчас много запросов, попробуйте чуть позже.';
  return 'Не удалось получить ответ. Попробуйте ещё раз.';
}

// ---- lead (заявка на участие) ---------------------------------------------
app.post('/api/lead', leadLimiter, async (req, res) => {
  const { errors, lead } = validateLead(req.body);
  if (errors) return res.status(400).json({ ok: false, errors });

  const meta = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ip: req.ip,
    ua: String(req.get('user-agent') || '').slice(0, 200),
  };

  try {
    const record = await saveLead(lead, meta);
    // уведомление не должно ронять или задерживать ответ клиенту
    notifyTelegram(record).catch(() => {});
    // в лог — без персональных данных
    console.log(`lead ${meta.id} saved (${lead.tariff})`);
    return res.status(201).json({ ok: true, id: meta.id });
  } catch (err) {
    console.error('lead save failed:', err?.code || 'unknown');
    return res.status(500).json({ ok: false, error: 'Не удалось сохранить заявку. Попробуйте ещё раз.' });
  }
});

app.listen(PORT, () => {
  console.log(`tp-devushka backend on http://127.0.0.1:${PORT}  (model: ${MODEL})`);
});
