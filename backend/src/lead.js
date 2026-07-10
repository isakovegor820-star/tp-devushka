// Приём и хранение заявок на участие в конференции «ТехнологИИ права 2026».
// Отдельный модуль: валидация, запись на диск, уведомление в Telegram.
//
// 152-ФЗ: вместе с заявкой фиксируем ФАКТ, ДАТУ и ВЕРСИЮ согласия — без этого
// согласие юридически не подтвердить. Версию поднимать при правке docs/soglasie-pdn.html.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CONSENT_VERSION = '1.0';

// Прайс держим на сервере: клиент не может назначить свою цену.
const TARIFFS = new Map([
  ['Стандарт', 35000],
  ['Бизнес', 55000],
  ['Full Pass', 88000],
  ['Корпоративный', 99000],
]);

const MAX = { name: 120, company: 160, email: 160, phone: 40, tariff: 40 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s()-]{10,20}$/;

const clean = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** Возвращает { lead } либо { errors: { поле: сообщение } }. */
export function validateLead(body) {
  const name = clean(body?.name, MAX.name);
  const company = clean(body?.company, MAX.company);
  const email = clean(body?.email, MAX.email).toLowerCase();
  const phone = clean(body?.phone, MAX.phone);
  const tariff = clean(body?.tariff, MAX.tariff);

  const errors = {};
  if (name.length < 2) errors.name = 'Укажите фамилию и имя.';
  if (!TARIFFS.has(tariff)) errors.tariff = 'Выберите тариф.';
  if (!email && !phone) errors.contact = 'Оставьте email или телефон — иначе мы не сможем прислать счёт.';
  if (email && !EMAIL_RE.test(email)) errors.email = 'Проверьте адрес почты.';
  if (phone && !PHONE_RE.test(phone)) errors.phone = 'Проверьте номер телефона.';
  if (body?.consent !== true) errors.consent = 'Без согласия на обработку персональных данных заявку принять нельзя.';

  if (Object.keys(errors).length) return { errors };

  return {
    lead: {
      name, company, email, phone, tariff,
      price: TARIFFS.get(tariff),
      marketing: body?.marketing === true,
    },
  };
}

const DATA_DIR = process.env.LEADS_DIR || join(process.cwd(), 'data');
const LEADS_FILE = join(DATA_DIR, 'leads.jsonl');

/** Дописывает заявку в JSONL. Возвращает сохранённую запись. */
export async function saveLead(lead, meta) {
  await mkdir(DATA_DIR, { recursive: true });
  const record = {
    id: meta.id,
    ts: meta.ts,
    tariff: lead.tariff,
    price: lead.price,
    name: lead.name,
    company: lead.company || null,
    email: lead.email || null,
    phone: lead.phone || null,
    consent: {
      pdn: true,                       // обязательное согласие (ст. 9 152-ФЗ)
      marketing: lead.marketing,       // отдельное согласие на рекламу (ст. 18 «О рекламе»)
      version: CONSENT_VERSION,
      ts: meta.ts,
      ip: meta.ip,
      ua: meta.ua,
    },
  };
  await appendFile(LEADS_FILE, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** Шлёт заявку в Telegram, если заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID. */
export async function notifyTelegram(rec) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'not_configured' };

  const text = [
    '🎟 <b>Новая заявка на участие</b>',
    `Тариф: <b>${esc(rec.tariff)}</b> — ${rec.price.toLocaleString('ru-RU')} ₽`,
    `Имя: ${esc(rec.name)}`,
    rec.company ? `Компания: ${esc(rec.company)}` : null,
    rec.email ? `Email: ${esc(rec.email)}` : null,
    rec.phone ? `Телефон: ${esc(rec.phone)}` : null,
    `Рассылка: ${rec.marketing ? 'да' : 'нет'}`,
    `<code>${esc(rec.id)}</code>`,
  ].filter(Boolean).join('\n');

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return { sent: r.ok };
  } catch {
    return { sent: false, reason: 'network' };
  }
}
