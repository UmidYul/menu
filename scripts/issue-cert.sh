#!/usr/bin/env bash
# Промт 3.7, раздел 3: «выпуск выполняет отдельный скрипт (scripts/issue-cert.sh), вызываемый
# по задаче, а не напрямую из Node — так проще отлаживать и не нужны root-права у приложения».
#
# Что делает: берёт домены, ждущие сертификата (статус 'verifying' — он же и есть очередь,
# см. scripts/domain-cert-hook.js), выпускает на каждый сертификат через certbot с HTTP-01
# и сообщает результат обратно в приложение.
#
# Запускается от root по systemd-таймеру раз в 5 минут (unit-файлы — в README). Node-процессу
# root не нужен и не даётся: приложение только ставит домен в очередь статусом.
#
#   sudo ./scripts/issue-cert.sh            — выпустить всё, что ждёт
#   sudo ./scripts/issue-cert.sh <домен>    — выпустить один домен (для отладки)
#
# set -u и -o pipefail намеренно, но БЕЗ set -e: падение certbot на одном домене не должно
# прерывать обработку остальных — иначе один сломанный домен блокирует всю очередь.
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Каталог, из которого nginx отдаёт /.well-known/acme-challenge/ для ВСЕХ доменов сразу
# (см. конфиг в README). Общий webroot вместо отдельного на домен — иначе каждый новый домен
# требовал бы правки nginx до того, как для него можно выпустить сертификат.
ACME_WEBROOT="${ACME_WEBROOT:-/var/www/acme}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NODE_BIN="${NODE_BIN:-node}"

cd "$APP_DIR" || exit 1

if [ -z "$CERTBOT_EMAIL" ]; then
  echo "issue-cert: CERTBOT_EMAIL не задан — Let's Encrypt не сможет предупредить об истечении" >&2
fi

hook() {
  "$NODE_BIN" "$APP_DIR/scripts/domain-cert-hook.js" "$@"
}

issue_one() {
  local domain="$1"
  echo "issue-cert: выпускаю сертификат для $domain"

  # --webroot, а не --nginx: плагин nginx правит конфиг сам, а конфиг у нас общий на все
  # кастомные домены (один server-блок с wildcard-сертификатами по SNI) — пусть его меняет
  # только человек.
  # --non-interactive и --agree-tos обязательны: скрипт работает по таймеру, спросить некого.
  local output
  output=$(certbot certonly \
    --webroot -w "$ACME_WEBROOT" \
    -d "$domain" \
    --non-interactive --agree-tos \
    ${CERTBOT_EMAIL:+--email "$CERTBOT_EMAIL"} \
    --cert-name "$domain" \
    --keep-until-expiring \
    2>&1)
  local code=$?

  if [ $code -eq 0 ]; then
    # Перечитать конфигурацию, чтобы nginx подхватил новый сертификат. reload, а не restart:
    # уже открытые соединения гостей рвать незачем.
    systemctl reload nginx || echo "issue-cert: не удалось перезагрузить nginx" >&2
    hook activate "$domain"
  else
    echo "issue-cert: certbot вернул код $code для $domain" >&2
    echo "$output" >&2
    # В приложение уходит только последняя строка вывода: полный лог certbot содержит пути
    # и внутренние подробности, которым не место на экране владельца заведения.
    hook fail "$domain" "$(echo "$output" | tail -n 1)"
  fi
}

if [ $# -ge 1 ]; then
  issue_one "$1"
  exit 0
fi

pending=$(hook list)
if [ -z "$pending" ]; then
  exit 0
fi

while IFS= read -r domain; do
  [ -n "$domain" ] && issue_one "$domain"
done <<< "$pending"
