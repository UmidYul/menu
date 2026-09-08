#!/usr/bin/env bash
# Промт 4.2, раздел 2. Внешний монитор сервиса.
#
# ЗАПУСКАТЬ С ДРУГОЙ МАШИНЫ. Монитор на том же сервере не заметит, что сервер лёг, — он ляжет
# вместе с ним. Если второй машины нет, поставьте бесплатный внешний пингер на /health, а этот
# скрипт пусть проверяет то, что снаружи не видно (подробный health, срок сертификата, бот).
#
# Установка (cron, раз в 2 минуты):
#   */2 * * * * /path/to/monitor.sh >> /var/log/qrmenu-monitor.log 2>&1
#
# Переменные окружения (или файл рядом со скриптом — monitor.env):
#   MONITOR_BASE_URL      https://qr.menu            — адрес сервиса
#   MONITOR_DEMO_SLUG     demo                       — slug заведения для замера скорости меню
#   MONITOR_HEALTH_TOKEN  ...                        — токен /health/detailed (необязательно)
#   MONITOR_BOT_TOKEN     123:ABC                    — токен бота, которым ШЛЮТСЯ алерты
#   MONITOR_CHAT_ID       123456                     — куда слать алерты
#   MONITOR_SERVICE_BOT_TOKEN ...                    — токен ПРОВЕРЯЕМОГО бота (может совпадать)
#   MONITOR_STATE_DIR     /var/lib/qrmenu-monitor    — где хранится состояние между запусками
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/monitor.env" ] && . "$SCRIPT_DIR/monitor.env"

BASE_URL="${MONITOR_BASE_URL:-http://localhost:3000}"
DEMO_SLUG="${MONITOR_DEMO_SLUG:-demo}"
HEALTH_TOKEN="${MONITOR_HEALTH_TOKEN:-}"
BOT_TOKEN="${MONITOR_BOT_TOKEN:-}"
CHAT_ID="${MONITOR_CHAT_ID:-}"
SERVICE_BOT_TOKEN="${MONITOR_SERVICE_BOT_TOKEN:-$BOT_TOKEN}"
STATE_DIR="${MONITOR_STATE_DIR:-$SCRIPT_DIR/.monitor-state}"

# Пороги из промта.
DOWN_ALERT_AFTER_SECONDS=180        # недоступность дольше 3 минут
SLOW_THRESHOLD_SECONDS=3            # ответ медленнее 3 секунд
SLOW_ALERT_AFTER_STREAK=5           # ...подряд 5 раз
SSL_ALERT_DAYS=14                   # алерт за 14 дней до истечения сертификата

mkdir -p "$STATE_DIR"

now_ts() { date +%s; }

state_get() { cat "$STATE_DIR/$1" 2>/dev/null || echo ""; }
state_set() { printf '%s' "$2" > "$STATE_DIR/$1"; }
state_clear() { rm -f "$STATE_DIR/$1"; }

log() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }

# Алерт шлётся НАПРЯМУЮ в Telegram Bot API, а не через приложение. В этом весь смысл внешнего
# монитора: он должен работать именно тогда, когда приложение не работает.
send_alert() {
  local text="$1"
  log "ALERT: $text"
  if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    log "  (MONITOR_BOT_TOKEN/MONITOR_CHAT_ID не заданы — алерт только в лог)"
    return
  fi
  curl -sS -m 15 -o /dev/null \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" \
    || log "  (не удалось отправить алерт)"
}

# --- 1. Доступность /health -------------------------------------------------------------------
# Алерт не на первую же неудачу, а после DOWN_ALERT_AFTER_SECONDS: одиночный таймаут при
# перезапуске по деплою — не авария, а будить владельца по каждому такому случаю значит
# приучить его игнорировать алерты.

# curl при отказе соединения сам печатает 000 в %{http_code} — своего запасного echo не нужно,
# иначе на выходе склеивается "000000" и лог становится нечитаемым.
health_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/health" 2>/dev/null)"
health_code="${health_code:-000}"
down_since="$(state_get down_since)"

if [ "$health_code" = "200" ]; then
  if [ -n "$down_since" ]; then
    # Промт: восстановление тоже уведомляется, с длительностью простоя.
    downtime_min=$(( ( $(now_ts) - down_since ) / 60 ))
    send_alert "✅ Сервис снова доступен. Простой составил ${downtime_min} мин."
    state_clear down_since
    state_clear down_alerted
  fi
else
  if [ -z "$down_since" ]; then
    down_since="$(now_ts)"
    state_set down_since "$down_since"
    log "health отдал $health_code — засекаем время"
  fi
  elapsed=$(( $(now_ts) - down_since ))
  if [ "$elapsed" -ge "$DOWN_ALERT_AFTER_SECONDS" ] && [ -z "$(state_get down_alerted)" ]; then
    send_alert "🔥 Сервис недоступен уже $(( elapsed / 60 )) мин. /health отвечает ${health_code}."
    state_set down_alerted 1
  fi
fi

# --- 2. Время ответа публичного меню ------------------------------------------------------------
# Меряется именно меню, а не /health: гость приходит на меню, и медленная страница для него —
# та же авария, только тихая.

menu_time="$(curl -sS -m 20 -o /dev/null -w '%{time_total}' "$BASE_URL/menu/$DEMO_SLUG" 2>/dev/null || echo 99)"
slow_streak="$(state_get slow_streak)"
slow_streak="${slow_streak:-0}"

# bash не умеет дробную арифметику — сравниваем через awk.
is_slow="$(awk -v t="$menu_time" -v limit="$SLOW_THRESHOLD_SECONDS" 'BEGIN { print (t > limit) ? 1 : 0 }')"
if [ "$is_slow" = "1" ]; then
  slow_streak=$(( slow_streak + 1 ))
  state_set slow_streak "$slow_streak"
  if [ "$slow_streak" -ge "$SLOW_ALERT_AFTER_STREAK" ] && [ -z "$(state_get slow_alerted)" ]; then
    send_alert "🐌 Меню отвечает дольше ${SLOW_THRESHOLD_SECONDS} с уже ${slow_streak} проверок подряд (последний замер: ${menu_time} с)."
    state_set slow_alerted 1
  fi
else
  if [ -n "$(state_get slow_alerted)" ]; then
    send_alert "✅ Скорость меню вернулась в норму (${menu_time} с)."
  fi
  state_set slow_streak 0
  state_clear slow_alerted
fi

# --- 3. Срок действия SSL ------------------------------------------------------------------------

case "$BASE_URL" in
  https://*)
    host="${BASE_URL#https://}"
    host="${host%%/*}"
    cert_end="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -z "$cert_end" ]; then
      if [ -z "$(state_get ssl_alerted)" ]; then
        send_alert "🔒 Не удалось проверить сертификат ${host} — соединение не устанавливается."
        state_set ssl_alerted 1
      fi
    else
      cert_end_ts="$(date -d "$cert_end" +%s 2>/dev/null || echo 0)"
      if [ "$cert_end_ts" -gt 0 ]; then
        days_left=$(( (cert_end_ts - $(now_ts)) / 86400 ))
        log "сертификат ${host}: осталось ${days_left} дн."
        if [ "$days_left" -le "$SSL_ALERT_DAYS" ] && [ -z "$(state_get ssl_alerted)" ]; then
          send_alert "🔒 Сертификат ${host} истекает через ${days_left} дн. Проверьте автопродление certbot."
          state_set ssl_alerted 1
        fi
        [ "$days_left" -gt "$SSL_ALERT_DAYS" ] && state_clear ssl_alerted
      fi
    fi
    ;;
  *)
    log "SSL не проверяется: адрес не https"
    ;;
esac

# --- 4. Доступность бота ---------------------------------------------------------------------
# getMe у Telegram — самый дешёвый способ убедиться, что токен жив и API отвечает. Что процесс
# бота НА СЕРВЕРЕ работает, отсюда не видно вовсе — это видно в /health/detailed по очереди
# уведомлений: если она растёт, значит воркер стоит.

if [ -n "$SERVICE_BOT_TOKEN" ]; then
  bot_ok="$(curl -sS -m 10 "https://api.telegram.org/bot${SERVICE_BOT_TOKEN}/getMe" 2>/dev/null | grep -c '"ok":true' || echo 0)"
  if [ "$bot_ok" = "0" ]; then
    if [ -z "$(state_get bot_alerted)" ]; then
      send_alert "🤖 Бот не отвечает на getMe — проверьте токен и процесс бота."
      state_set bot_alerted 1
    fi
  else
    [ -n "$(state_get bot_alerted)" ] && send_alert "✅ Бот снова отвечает."
    state_clear bot_alerted
  fi
fi

# --- 5. Подробный health ------------------------------------------------------------------------
# То, что снаружи не видно: очередь уведомлений, место на диске, возраст бэкапа. Требует токена;
# без него шаг пропускается, а не считается аварией.

if [ -n "$HEALTH_TOKEN" ]; then
  detailed="$(curl -sS -m 15 -H "X-Health-Token: ${HEALTH_TOKEN}" "$BASE_URL/health/detailed" 2>/dev/null || echo '')"
  if echo "$detailed" | grep -q '"status":"degraded"'; then
    problems="$(echo "$detailed" | sed -n 's/.*"problems":\[\([^]]*\)\].*/\1/p')"
    if [ -z "$(state_get detailed_alerted)" ]; then
      send_alert "⚠️ Подробная проверка сообщает о проблемах: ${problems}"
      state_set detailed_alerted 1
    fi
  else
    [ -n "$(state_get detailed_alerted)" ] && send_alert "✅ Подробная проверка снова в норме."
    state_clear detailed_alerted
  fi
fi

log "проверка завершена: health=${health_code}, меню=${menu_time}с"
