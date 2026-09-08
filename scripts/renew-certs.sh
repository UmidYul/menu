#!/usr/bin/env bash
# Промт 3.7, раздел 3: «Автопродление — стандартным таймером certbot, с алертом владельцу
# сервиса при неудаче».
#
# Сам certbot умеет продлевать себя таймером certbot.timer, и его мы не заменяем. Эта обёртка
# добавляет ровно то, чего в стандартном таймере нет: если продление не удалось, владелец
# сервиса должен УЗНАТЬ об этом заранее, а не из жалобы заведения через две недели, когда
# сертификат истечёт.
#
# Ставится вместо certbot.timer (см. README): тот же график дважды в сутки, но с разбором
# результата.
#
#   sudo ./scripts/renew-certs.sh
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ACME_WEBROOT="${ACME_WEBROOT:-/var/www/acme}"
NODE_BIN="${NODE_BIN:-node}"

cd "$APP_DIR" || exit 1

# --deploy-hook срабатывает только при РЕАЛЬНОМ обновлении сертификата, а не на каждом запуске:
# перезагружать nginx дважды в сутки впустую незачем.
output=$(certbot renew \
  --webroot -w "$ACME_WEBROOT" \
  --non-interactive \
  --deploy-hook "systemctl reload nginx" \
  2>&1)
code=$?

echo "$output"

if [ $code -eq 0 ]; then
  exit 0
fi

echo "renew-certs: certbot renew вернул код $code" >&2

# Какие именно домены не продлились. certbot печатает их в блоке "The following renewals
# failed"; разбираем вывод, потому что кодом возврата он сообщает только сам факт неудачи.
failed=$(echo "$output" | grep -oE '/etc/letsencrypt/live/[^/]+/fullchain\.pem' | sed 's|.*/live/||; s|/fullchain.pem||' | sort -u)

if [ -z "$failed" ]; then
  # Не удалось понять, какой домен пострадал, — сообщаем хотя бы сам факт, привязав его
  # к первому активному домену, чтобы алерт вообще дошёл до владельца сервиса.
  any=$("$NODE_BIN" "$APP_DIR/scripts/domain-cert-hook.js" list | head -n 1)
  [ -n "$any" ] && "$NODE_BIN" "$APP_DIR/scripts/domain-cert-hook.js" renew-failed "$any" "certbot renew: код $code"
  exit 1
fi

while IFS= read -r domain; do
  [ -n "$domain" ] && "$NODE_BIN" "$APP_DIR/scripts/domain-cert-hook.js" renew-failed "$domain" "certbot renew: код $code"
done <<< "$failed"

exit 1
