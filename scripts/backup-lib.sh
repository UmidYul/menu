#!/usr/bin/env bash
# Промт 4.1. Общее для backup.sh, restore.sh и verify-backup.sh: конфигурация, лог, алерты,
# файл состояния и работа с местом на диске.
#
# Подключается через `. "$(dirname "$0")/backup-lib.sh"`. Сам по себе ничего не делает —
# только объявляет функции и разбирает конфиг, чтобы у трёх скриптов не разъехались ни имена
# переменных, ни формат состояния, ни то, как выглядит алерт.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/backup.env" ] && . "$SCRIPT_DIR/backup.env"

DATABASE_URL_VALUE="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
UPLOADS_DIR="${BACKUP_UPLOADS_DIR:-$APP_DIR/public/uploads}"
BACKUP_ROOT="${BACKUP_DIR:-/var/backups/qrmenu}"
OFFSITE_TARGET="${BACKUP_OFFSITE_TARGET:-}"
OFFSITE_RSYNC_OPTS="${BACKUP_OFFSITE_RSYNC_OPTS:-}"

KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"

DUMP_TIMEOUT="${BACKUP_DUMP_TIMEOUT_SECONDS:-1800}"
DISK_WARN_PERCENT="${BACKUP_DISK_WARN_PERCENT:-20}"
DISK_CRIT_PERCENT="${BACKUP_DISK_CRIT_PERCENT:-10}"

BOT_TOKEN="${BACKUP_BOT_TOKEN:-}"
CHAT_ID="${BACKUP_CHAT_ID:-}"

STATE_FILE="${BACKUP_STATE_FILE:-/var/lib/qrmenu/backup-state.json}"
STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/qrmenu/backup}"

PGDUMP="${BACKUP_PGDUMP:-pg_dump}"
PSQL="${BACKUP_PSQL:-psql}"
PGRESTORE="${BACKUP_PGRESTORE:-pg_restore}"

DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
# Снимки uploads лежат отдельно от дампов: они связаны между собой жёсткими ссылками
# (--link-dest), и перекладывать их поштучно в daily/weekly/monthly значило бы порвать эту связь.
UPLOADS_SNAPSHOT_DIR="$BACKUP_ROOT/uploads"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }

# --- состояние -----------------------------------------------------------------------------------

state_get() { cat "$STATE_DIR/$1" 2>/dev/null || echo ""; }
state_set() { mkdir -p "$STATE_DIR"; printf '%s' "$2" > "$STATE_DIR/$1"; }

# Экранирование для JSON-строки. Текст ошибки приходит из вывода pg_dump и может содержать
# кавычки, обратные слэши и переводы строк — без экранирования файл состояния перестанет
# быть разбираемым, а /health/detailed покажет «не удалось прочитать состояние бэкапов»
# вместо настоящей причины.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s", (NR>1 ? "\\n" : "") $0}'
}

# Файл состояния для /health/detailed. Формат задан ещё промтом 4.2 (см. lastBackup()
# в src/routes/health.js): читаются lastSuccessAt и lastStatus, остальные поля игнорируются,
# но полезны человеку, открывшему файл руками.
#
# Пишется атомарно, через временный файл и mv: health-check читает его в произвольный момент,
# и застать наполовину записанный JSON он не должен.
write_state() {
  local status="$1" error="${2:-}"
  mkdir -p "$(dirname "$STATE_FILE")" "$STATE_DIR"

  local last_success
  last_success="$(state_get last_success_at)"
  if [ "$status" = "ok" ]; then
    last_success="$(date -Iseconds)"
    state_set last_success_at "$last_success"
  fi

  local tmp="${STATE_FILE}.tmp.$$"
  {
    printf '{\n'
    printf '  "lastStatus": "%s",\n' "$status"
    printf '  "lastRunAt": "%s",\n' "$(date -Iseconds)"
    if [ -n "$last_success" ]; then
      printf '  "lastSuccessAt": "%s",\n' "$last_success"
    else
      printf '  "lastSuccessAt": null,\n'
    fi
    printf '  "consecutiveFailures": %s,\n' "$(state_get consecutive_failures | grep -E '^[0-9]+$' || echo 0)"
    printf '  "lastVerifyAt": %s,\n' "$([ -n "$(state_get last_verify_at)" ] && printf '"%s"' "$(state_get last_verify_at)" || printf 'null')"
    printf '  "lastVerifyStatus": %s,\n' "$([ -n "$(state_get last_verify_status)" ] && printf '"%s"' "$(state_get last_verify_status)" || printf 'null')"
    if [ -n "$error" ]; then
      printf '  "lastError": "%s"\n' "$(json_escape "$error")"
    else
      printf '  "lastError": null\n'
    fi
    printf '}\n'
  } > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

# --- уведомления ----------------------------------------------------------------------------------

# Промт, раздел 4: «Успешный бэкап: тихо, без сообщений, иначе владелец перестанет их читать».
# Поэтому функции «сообщить об успехе» здесь нет вовсе — только алерты и еженедельная сводка.
send_telegram() {
  local text="$1"
  log "TELEGRAM: $text"
  if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    log "  (BACKUP_BOT_TOKEN/BACKUP_CHAT_ID не заданы — сообщение только в лог)"
    return 0
  fi
  curl -sS -m 20 -o /dev/null \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" \
    || log "  (не удалось отправить сообщение в Telegram)"
}

# Промт: «Неудачный бэкап: немедленный алерт. Два неудачных подряд: повторный алерт с пометкой
# критичности». Счётчик живёт в файле, а не в памяти: между запусками процесса нет ничего общего.
alert_failure() {
  local reason="$1"
  local count
  count="$(state_get consecutive_failures | grep -E '^[0-9]+$' || echo 0)"
  count=$((count + 1))
  state_set consecutive_failures "$count"

  if [ "$count" -ge 2 ]; then
    send_telegram "🔴 КРИТИЧНО: бэкап qr.menu не удался ${count}-й раз подряд.

${reason}

Последний успешный бэкап: $(state_get last_success_at | grep . || echo 'не было ни разу').
Пока это не починено, восстанавливать нечего."
  else
    send_telegram "⚠️ Бэкап qr.menu не удался.

${reason}

Повторная попытка — по расписанию. Если следующая тоже провалится, придёт критический алерт."
  fi

  write_state failed "$reason"
}

mark_success() {
  state_set consecutive_failures 0
  write_state ok
}

# --- место на диске ---------------------------------------------------------------------------------

# Процент СВОБОДНОГО места на файловой системе с бэкапами. Отдельной функцией, чтобы проверку
# можно было прогнать в харнессе с подставным значением (BACKUP_FAKE_FREE_PERCENT).
disk_free_percent() {
  if [ -n "${BACKUP_FAKE_FREE_PERCENT:-}" ]; then
    printf '%s' "$BACKUP_FAKE_FREE_PERCENT"
    return 0
  fi
  local used
  used="$(df -P "$1" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [ -z "$used" ] && { printf '100'; return 0; }
  printf '%s' "$((100 - used))"
}

# Возвращает 0, если места достаточно; 1 — если критически мало (бэкап начинать нельзя).
# Предупреждение при 20% не останавливает бэкап: место ещё есть, и не сделать бэкап хуже,
# чем сделать его на подходящем к концу диске.
check_disk_space() {
  local target="$1"
  local free
  free="$(disk_free_percent "$target")"
  log "свободно на диске бэкапов: ${free}%"

  if [ "$free" -lt "$DISK_CRIT_PERCENT" ]; then
    send_telegram "🔴 КРИТИЧНО: на диске бэкапов осталось ${free}% свободного места (порог ${DISK_CRIT_PERCENT}%).
Бэкап не запускается: частичный файл занял бы остаток и уронил бы сервер вместе с базой."
    return 1
  fi

  if [ "$free" -lt "$DISK_WARN_PERCENT" ]; then
    # Предупреждение раз в сутки, а не на каждый запуск: иначе его перестанут читать
    # ровно к тому моменту, когда оно станет важным.
    local today
    today="$(date +%F)"
    if [ "$(state_get disk_warned_on)" != "$today" ]; then
      send_telegram "⚠️ На диске бэкапов осталось ${free}% свободного места (порог ${DISK_WARN_PERCENT}%).
Бэкап продолжает работать, но места хватит ненадолго — проверьте ротацию и размер uploads."
      state_set disk_warned_on "$today"
    fi
  fi
  return 0
}

# --- работа с БД -------------------------------------------------------------------------------------

# Имя базы из строки подключения — нужно и для восстановления, и для контрольных запросов.
db_name_from_url() {
  printf '%s' "$1" | sed -e 's#.*/##' -e 's#?.*##'
}

# Строка подключения к другой базе того же сервера (для restore в *_restore_test).
db_url_with_name() {
  printf '%s' "$1" | sed -e "s#/[^/?]*\(?.*\)\{0,1\}\$#/$2#"
}

# psql с единственным значением в ответе. -t убирает заголовки, -A — выравнивание,
# без них любое сравнение пришлось бы очищать от пробелов.
psql_value() {
  local url="$1" query="$2"
  # shellcheck disable=SC2086
  $PSQL "$url" -tA -c "$query" 2>/dev/null | tr -d '\r' | head -n 1
}

human_size() {
  local bytes="$1"
  if [ "$bytes" -ge 1073741824 ]; then
    printf '%s ГБ' "$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1073741824}')"
  elif [ "$bytes" -ge 1048576 ]; then
    printf '%s МБ' "$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1048576}')"
  else
    printf '%s КБ' "$(awk -v b="$bytes" 'BEGIN{printf "%.1f", b/1024}')"
  fi
}

file_size_bytes() {
  wc -c < "$1" 2>/dev/null | tr -d ' ' || echo 0
}

dir_size_bytes() {
  du -sb "$1" 2>/dev/null | awk '{print $1}' || echo 0
}
