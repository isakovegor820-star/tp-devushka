# tp-devushka backend — AI-юрист (LLM-прокси)

Node.js бэкенд для чата «AI-юрист» на лендинге [slava-hunter.ru/tp-devushka.html](https://slava-hunter.ru/tp-devushka.html).
Держит API-ключ на сервере (в браузер не попадает), проксирует запросы к Claude, стримит ответ.

## Стек
- Node.js ≥ 18, Express
- [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) — модель по умолчанию `claude-opus-4-8`
- CORS, rate-limit, SSE-стриминг

## Запуск локально
```bash
cd backend
cp .env.example .env          # впишите ANTHROPIC_API_KEY
npm install
npm start                     # http://127.0.0.1:3031
```
Откройте `http://127.0.0.1:3031/test.html` — простая страница-чат для проверки.

## API

### `GET /api/health`
```json
{ "ok": true, "model": "claude-opus-4-8", "configured": true }
```

### `POST /api/chat`
Тело:
```json
{ "messages": [ { "role": "user", "content": "Сосед затопил квартиру, что делать?" } ] }
```
- По умолчанию отвечает **потоком** (SSE): строки `data: {"type":"delta","text":"…"}`, в конце `data: {"type":"done","usage":{…}}`.
- `"stream": false` в теле → обычный JSON `{ "reply": "…", "usage": {…} }`.

Клиент шлёт всю историю диалога (`messages`); сервер сам обрежет её до последних `MAX_HISTORY` сообщений и подставит системный промпт.

## Конфиг (env)
| Переменная | По умолчанию | Смысл |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **обязательно** |
| `PORT` | `3031` | порт (на сервере 3030 занят) |
| `MODEL` | `claude-opus-4-8` | можно `claude-sonnet-5` / `claude-haiku-4-5` для экономии |
| `MAX_TOKENS` | `4096` | максимум токенов в ответе |
| `MAX_HISTORY` | `24` | сколько последних сообщений держать |
| `ALLOWED_ORIGINS` | slava-hunter.ru | CORS-белый список |
| `RATE_LIMIT_PER_MIN` | `30` | лимит запросов/IP/мин |

Системный промпт (персона + дисклеймеры) — в [`src/prompt.js`](src/prompt.js).

## Деплой на сервер (кратко)
1. Залить `backend/` на сервер (без `node_modules`/`.env`), `npm ci --omit=dev`.
2. Создать `.env` с ключом, `PORT=3031`.
3. Запустить как сервис (systemd или pm2) — пример systemd в [`DEPLOY.md`](DEPLOY.md).
4. В nginx для `slava-hunter.ru` добавить проксирование на этот порт по отдельному пути
   (`/tp-devushka/api/` → `127.0.0.1:3031`), т.к. `/api/` уже занят другим приложением.

Подробности и wiring фронтенда — в [`DEPLOY.md`](DEPLOY.md).
