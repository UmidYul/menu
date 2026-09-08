#!/usr/bin/env bash
# Промт 4.1. Ежедневный бэкап базы и загруженных фото.
#
#   ./scripts/backup.sh            — обычный запуск (из systemd-таймера в 04:00 по Ташкенту)
#   ./scripts/backup.sh --dry-run  — показать, что было бы сделано, ничего не меняя
#
# НЕ node-cron внутри приложения (прямое требование промта): бэкап не должен зависеть от того,
# жив ли Node-процесс. Ровно те ночи, когда приложение упало, — самые важные для бэкапа.
#
# Порядок операций продиктован edge cases промта и соблюдается буквально:
#   1) дамп базы            — согласованный снимок на момент начала;
#   2) снимок uploads       — ПОСЛЕ дампа: файлы, добавленные между этими шагами, попадут
#                             в следующий инкремент, и это нормально; главное — не терять старые;
#   3) манифест с контрольной суммой;
#   4) вторая копия;
#   5) и ТОЛЬКО ПОТОМ удаление старых бэкапов.
# Обратный порядок (сначала освободить место, потом писать) означал бы, что неудачная ночь
# оставляет и без нового бэкапа, и без старого.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/backup-lib.sh"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

STAMP="$(date +%Y%m%d-%H%M%S)"
TODAY="$(date +%F)"
DUMP_NAME="qrmenu-${STAMP}.dump"
DUMP_PATH="$DAILY_DIR/$DUMP_NAME"
MANIFEST_PATH="$DAILY_DIR/qrmenu-${STAMP}.manifest.json"

# Всё, что успели создать, — чтобы снести при обрыве. Промт: «Диск заполнился во время бэкапа —
# частичный файл удаляется, старые бэкапы не трогаются».
CREATED_FILES=()

cleanup_partial() {
  for f in "${CREATED_FILES[@]:-}"; do
    [ -n "$f" ] && [ -e "$f" ] && { rm -rf "$f"; log "удалён частичный файл: $f"; }
  done
}

fail() {
  local reason="$1"
  log "ОШИБКА: $reason"
  cleanup_partial
  alert_failure "$reason"
  exit 1
}

log "=== бэкап qr.menu, метка $STAMP ==="

if [ -z "$DATABASE_URL_VALUE" ]; then
  fail "BACKUP_DATABASE_URL не задан — нечего бэкапить. Заполните scripts/backup.env."
fi

if [ -z "$OFFSITE_TARGET" ]; then
  # Не ошибка, но и молчать нельзя: промт называет вторую копию обязательной.
  log "ВНИМАНИЕ: BACKUP_OFFSITE_TARGET не задан — бэкап останется в одном месте."
fi

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR" "$UPLOADS_SNAPSHOT_DIR" "$STATE_DIR"

check_disk_space "$BACKUP_ROOT" || fail "На диске бэкапов критически мало места — запуск отменён."

if [ "$DRY_RUN" = "1" ]; then
  log "--dry-run: дальше был бы дамп в $DUMP_PATH, снимок uploads из $UPLOADS_DIR,"
  log "--dry-run: манифест, копия в '${OFFSITE_TARGET:-—}' и ротация ${KEEP_DAILY}/${KEEP_WEEKLY}/${KEEP_MONTHLY}."
  exit 0
fi

# --- 1. Дамп базы ---------------------------------------------------------------------------------
# -Fc (custom) со встроенным сжатием, как требует промт: восстанавливается выборочно через
# pg_restore, в отличие от простого SQL-текста.
#
# timeout убивает зависший pg_dump (промт: «таймаут 30 минут и убийство процесса с алертом»).
# --kill-after даёт процессу 30 секунд на корректное завершение по TERM и потом добивает KILL:
# pg_dump, зависший на сетевом чтении, на TERM может не отреагировать вовсе.
log "дамп базы -> $DUMP_PATH"
CREATED_FILES+=("$DUMP_PATH")

DUMP_ERR="$(mktemp)"
# shellcheck disable=SC2086
timeout --kill-after=30s "$DUMP_TIMEOUT" $PGDUMP "$DATABASE_URL_VALUE" -Fc --no-owner --no-privileges \
  > "$DUMP_PATH" 2> "$DUMP_ERR"
DUMP_CODE=$?

DUMP_ERR_TEXT="$(head -c 2000 "$DUMP_ERR")"
rm -f "$DUMP_ERR"

if [ $DUMP_CODE -eq 124 ] || [ $DUMP_CODE -eq 137 ]; then
  fail "pg_dump не уложился в ${DUMP_TIMEOUT} с и был убит. Проверьте нагрузку на базу и длинные транзакции."
fi
if [ $DUMP_CODE -ne 0 ]; then
  fail "pg_dump завершился с кодом ${DUMP_CODE}: ${DUMP_ERR_TEXT}"
fi

DUMP_SIZE="$(file_size_bytes "$DUMP_PATH")"
# Пустой или подозрительно маленький дамп — тоже неудача. Заголовок custom-формата и служебные
# таблицы занимают заведомо больше килобайта, и файл меньше этого означает, что дамп оборвался
# на старте, а не что база пустая.
if [ "$DUMP_SIZE" -lt 1024 ]; then
  fail "Дамп получился размером ${DUMP_SIZE} байт — это не похоже на рабочую базу."
fi
log "дамп готов: $(human_size "$DUMP_SIZE")"

# --- 2. Снимок uploads ------------------------------------------------------------------------------
# ПОСЛЕ дампа — см. комментарий в шапке.
#
# rsync --link-dest, а не tar --listed-incremental (промт разрешает оба). Разница в том, как они
# ломаются: порванная цепочка tar-инкрементов теряет всё, что после неё, а битый rsync-снимок
# теряет только себя. Плюс каждый снимок — просматриваемое дерево целиком (неизменившиеся файлы
# в нём — жёсткие ссылки на вчерашние, места занимают ноль), и восстановление фото сводится
# к обычному копированию, а не к проигрыванию цепочки.
UPLOADS_SNAPSHOT="$UPLOADS_SNAPSHOT_DIR/$TODAY"
UPLOADS_FILES=0
UPLOADS_BYTES=0

if [ ! -d "$UPLOADS_DIR" ]; then
  log "ВНИМАНИЕ: каталог uploads не найден ($UPLOADS_DIR) — снимок фото пропущен."
elif ! command -v rsync >/dev/null 2>&1; then
  log "ВНИМАНИЕ: rsync не установлен — снимок фото пропущен. Поставьте rsync, фото не бэкапятся."
else
  # Предыдущий снимок — источник жёстких ссылок. Берём последний по имени (имена — даты).
  PREV_SNAPSHOT="$(find "$UPLOADS_SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type d ! -name "$TODAY" 2>/dev/null | sort | tail -n 1)"
  LINK_OPT=()
  [ -n "$PREV_SNAPSHOT" ] && LINK_OPT=(--link-dest="$PREV_SNAPSHOT")
  [ -n "$PREV_SNAPSHOT" ] && log "инкремент от снимка $(basename "$PREV_SNAPSHOT")" || log "первый снимок uploads — полный"

  CREATED_FILES+=("$UPLOADS_SNAPSHOT")
  # --delete: снимок отражает состояние каталога на момент запуска, включая удаления. Историю
  # хранят ПРЕДЫДУЩИЕ снимки, а не накопление мусора в свежем.
  if ! rsync -a --delete "${LINK_OPT[@]}" "$UPLOADS_DIR/" "$UPLOADS_SNAPSHOT/"; then
    fail "rsync не смог сделать снимок uploads из $UPLOADS_DIR"
  fi
  UPLOADS_FILES="$(find "$UPLOADS_SNAPSHOT" -type f 2>/dev/null | wc -l | tr -d ' ')"
  UPLOADS_BYTES="$(dir_size_bytes "$UPLOADS_SNAPSHOT")"
  log "снимок uploads: $UPLOADS_FILES файлов, $(human_size "$UPLOADS_BYTES") (без учёта жёстких ссылок)"
fi

# --- 3. Манифест ------------------------------------------------------------------------------------
# Промт: «дата, размер, контрольная сумма sha256, версия схемы (последняя применённая миграция),
# количество заведений, позиций и файлов в uploads. Количества нужны, чтобы заметить бэкап
# пустой базы». Плюс версия PostgreSQL — промт требует зафиксировать её отдельно: восстановление
# дампа на более старой версии не работает, и узнать об этом лучше до, а не во время аварии.
log "манифест -> $MANIFEST_PATH"

SHA256="$(sha256sum "$DUMP_PATH" 2>/dev/null | awk '{print $1}')"
[ -z "$SHA256" ] && fail "Не удалось посчитать контрольную сумму дампа."

PG_VERSION="$(psql_value "$DATABASE_URL_VALUE" "SHOW server_version")"
SCHEMA_VERSION="$(psql_value "$DATABASE_URL_VALUE" "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1")"
VENUES_COUNT="$(psql_value "$DATABASE_URL_VALUE" "SELECT count(*) FROM venues")"
ITEMS_COUNT="$(psql_value "$DATABASE_URL_VALUE" "SELECT count(*) FROM items")"

# Счётчики — не украшение: пустая база даёт валидный дамп, который заметят только при попытке
# восстановиться. Ноль заведений считаем аварией.
if [ -z "$VENUES_COUNT" ] || [ "$VENUES_COUNT" = "0" ]; then
  fail "В базе ноль заведений — похоже, дамп снят не с той базы или база пуста."
fi

CREATED_FILES+=("$MANIFEST_PATH")
cat > "$MANIFEST_PATH" <<MANIFEST
{
  "createdAt": "$(date -Iseconds)",
  "stamp": "$STAMP",
  "dumpFile": "$DUMP_NAME",
  "dumpBytes": $DUMP_SIZE,
  "dumpSha256": "$SHA256",
  "postgresVersion": "$PG_VERSION",
  "schemaVersion": "$SCHEMA_VERSION",
  "venues": $VENUES_COUNT,
  "items": $ITEMS_COUNT,
  "uploadsSnapshot": "$TODAY",
  "uploadsFiles": $UPLOADS_FILES,
  "uploadsBytes": $UPLOADS_BYTES
}
MANIFEST

log "заведений: $VENUES_COUNT, позиций: $ITEMS_COUNT, схема: $SCHEMA_VERSION, PostgreSQL: $PG_VERSION"

# --- 4. Копии на неделю и месяц -----------------------------------------------------------------------
# Жёсткая ссылка, а не копия: тот же файл под тремя именами занимает место один раз, а ротация
# удаляет имена независимо — файл исчезнет, когда пропадёт последняя ссылка на него.
if [ "$(date +%u)" = "7" ]; then
  ln -f "$DUMP_PATH" "$WEEKLY_DIR/$DUMP_NAME" 2>/dev/null || cp "$DUMP_PATH" "$WEEKLY_DIR/$DUMP_NAME"
  ln -f "$MANIFEST_PATH" "$WEEKLY_DIR/$(basename "$MANIFEST_PATH")" 2>/dev/null || cp "$MANIFEST_PATH" "$WEEKLY_DIR/"
  log "воскресенье — копия в weekly"
fi
if [ "$(date +%d)" = "01" ]; then
  ln -f "$DUMP_PATH" "$MONTHLY_DIR/$DUMP_NAME" 2>/dev/null || cp "$DUMP_PATH" "$MONTHLY_DIR/$DUMP_NAME"
  ln -f "$MANIFEST_PATH" "$MONTHLY_DIR/$(basename "$MANIFEST_PATH")" 2>/dev/null || cp "$MANIFEST_PATH" "$MONTHLY_DIR/"
  log "первое число — копия в monthly"
fi

# --- 5. Вторая копия --------------------------------------------------------------------------------
# Промт: «Второе место хранения обязательно. Бэкап на том же диске, что и БД, бэкапом не является».
if [ -n "$OFFSITE_TARGET" ]; then
  log "копия на внешнее хранилище: $OFFSITE_TARGET"
  # shellcheck disable=SC2086
  if eval rsync -a --delete $OFFSITE_RSYNC_OPTS "\"$BACKUP_ROOT/\"" "\"$OFFSITE_TARGET\""; then
    log "вторая копия готова"
  else
    # Неудача второй копии — это авария: локальный бэкап есть, но одна копия бэкапом
    # не считается, и молча считать такую ночь успешной нельзя.
    fail "Не удалось скопировать бэкап на внешнее хранилище ($OFFSITE_TARGET). Локальная копия создана."
  fi
fi

# --- 6. Ротация ---------------------------------------------------------------------------------------
# ТОЛЬКО ПОСЛЕ того, как новый бэкап полностью готов и скопирован. Промт: «Порядок важен:
# сначала новый, потом удаление старых».
rotate() {
  local dir="$1" keep="$2" label="$3"
  local count
  count="$(find "$dir" -maxdepth 1 -name 'qrmenu-*.dump' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$count" -le "$keep" ] && return 0

  # Сортировка по имени работает, потому что имена начинаются с даты в формате YYYYMMDD-HHMMSS.
  find "$dir" -maxdepth 1 -name 'qrmenu-*.dump' 2>/dev/null | sort | head -n "$((count - keep))" | while read -r old; do
    rm -f "$old" "${old%.dump}.manifest.json"
    log "ротация ($label): удалён $(basename "$old")"
  done
}

rotate "$DAILY_DIR" "$KEEP_DAILY" ежедневные
rotate "$WEEKLY_DIR" "$KEEP_WEEKLY" еженедельные
rotate "$MONTHLY_DIR" "$KEEP_MONTHLY" ежемесячные

# Снимков uploads держим столько же, сколько ежедневных дампов: они соответствуют друг другу
# по дате, и держать снимок без дампа (или наоборот) незачем.
SNAP_COUNT="$(find "$UPLOADS_SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$SNAP_COUNT" -gt "$KEEP_DAILY" ]; then
  find "$UPLOADS_SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -n "$((SNAP_COUNT - KEEP_DAILY))" | while read -r old; do
    rm -rf "$old"
    log "ротация (снимки uploads): удалён $(basename "$old")"
  done
fi

# --- готово ---------------------------------------------------------------------------------------------
# Промт: «Успешный бэкап: тихо, без сообщений». В Telegram не пишем ничего — только состояние
# для /health/detailed и строка в лог.
mark_success
log "=== бэкап завершён успешно: $(human_size "$DUMP_SIZE") базы, $UPLOADS_FILES файлов uploads ==="
