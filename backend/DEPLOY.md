# Деплой бэкенда на сервер (slava-hunter.ru)

> Важно: на сервере путь `/api/` у `slava-hunter.ru` уже проксируется на порт `3030`
> (другое приложение). Поэтому наш бэкенд слушает **3031** и вешается на **отдельный
> путь** `/tp-devushka/api/`. Ничего чужого не трогаем.

## 1. Код на сервер
```bash
# на сервере
mkdir -p /var/www/tp-devushka-backend
# скопировать содержимое backend/ (без node_modules и .env), например через scp/git
cd /var/www/tp-devushka-backend
npm ci --omit=dev
cp .env.example .env      # и вписать ANTHROPIC_API_KEY, PORT=3031
```

## 2. systemd-сервис
`/etc/systemd/system/tp-devushka.service`:
```ini
[Unit]
Description=tp-devushka AI-lawyer backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/tp-devushka-backend
EnvironmentFile=/var/www/tp-devushka-backend/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload
systemctl enable --now tp-devushka
systemctl status tp-devushka
curl -s http://127.0.0.1:3031/api/health
```

## 3. nginx — добавить в server-блок slava-hunter.ru (443)
Вставить рядом с существующими `location`, НЕ трогая `location /api/` (он чужой):
```nginx
location /tp-devushka/api/ {
    proxy_pass http://127.0.0.1:3031/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # для SSE-стриминга ответа:
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
}
```
```bash
nginx -t && systemctl reload nginx
curl -s https://slava-hunter.ru/tp-devushka/api/health
```

Итоговый публичный эндпоинт чата: `https://slava-hunter.ru/tp-devushka/api/chat`.

## 4. Подключение фронтенда (tp-devushka.html)
Текущий `index.html` — единый минифицированный файл: в нём есть UI чата, но он не
подключён к бэкенду. Клиентский код для вызова (SSE-стриминг):

```js
async function askAILawyer(messages, onDelta) {
  const res = await fetch('https://slava-hunter.ru/tp-devushka/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const p of parts) {
      const line = p.replace(/^data: /, ''); if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === 'delta') { full += ev.text; onDelta(full); }
    }
  }
  return full;
}
```

`messages` — массив всей истории `[{role:'user'|'assistant', content}]`.
Рабочий пример целиком — в [`public/test.html`](public/test.html).

Чтобы аккуратно привязать это к существующему UI чата в минифицированном
`index.html`, нужен исходник фронтенда (до минификации) — тогда подключим кнопку
«Отправить» и вывод сообщений напрямую. Скинь исходник — сделаю.
