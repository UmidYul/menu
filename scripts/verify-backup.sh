#!/usr/bin/env bash
# Промт 4.1, раздел 3: «Еженедельная автоматическая проверка: восстановить последний дамп
# в тестовую базу, выполнить контрольные запросы (количество заведений, позиций, целостность
# внешних ключей), удалить тестовую базу, отчитаться в Telegram. Непроверенный бэкап — не бэкап».
#
#   ./scripts/verify-backup.sh
#
# Заодно отправляет еженедельную сводку из раздела 4 (размер базы, размер uploads, динамика
# роста, дата последней успешной проверки восстановления): это единственное регулярное
# сообщение, которое сервис шлёт владельцу про бэкапы, и раз уж оно уходит — пусть несёт всё
# сразу, а не приходит двумя разными.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/backup-lib.sh"

SOURCE_DB="$(db_name_from_url "$DATABASE_URL_VALUE")"
TEST_DB="${SOURCE_DB}_restore_test"
TEST_URL="$(db_url_with_name "$DATABASE_URL_VALUE" "$TEST_DB")"
ADMIN_URL="$(db_url_with_name "$DATABASE_URL_VALUE" "postgres")"

log "=== проверка восстановления ==="

drop_test_db() {
  # shellcheck disable=SC2086
  $PSQL "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE)" >/dev/null 2>&1 \
    || $PSQL "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$TEST_DB\"" >/dev/null 2>&1
}

verify_failed() {
  local reason="$1"
  log "ПРОВЕРКА НЕ ПРОШЛА: $reason"
  state_set last_verify_at "$(date -Iseconds)"
  state_set last_verify_status failed
  # Состояние переписываем, не трогая счётчик неудач самого бэкапа: провалившаяся проверка
  # восстановления и провалившийся бэкап — разные события, и смешивать их счётчики нельзя.
  write_state "$(state_get consecutive_failures | grep -qE '^[1-9]' && echo failed || echo ok)" ""
  send_telegram "🔴 ПРОВЕРКА ВОССТАНОВЛЕНИЯ НЕ ПРОШЛА

${reason}

Это значит, что бэкапы, возможно, нерабочие. Непроверенный бэкап — не бэкап: разберитесь
до того, как он понадобится."
  drop_test_db
  exit 1
}

DUMP_FILE="$(find "$DAILY_DIR" -maxdepth 1 -name 'qrmenu-*.dump' 2>/dev/null | sort | tail -n 1)"
[ -n "$DUMP_FILE" ] || verify_failed "В $DAILY_DIR нет ни одного дампа."

MANIFEST="${DUMP_FILE%.dump}.manifest.json"
log "проверяю $(basename "$DUMP_FILE")"

# 1. Восстановление в одноразовую базу. Через restore.sh, а не своим кодом: проверять надо
# ровно ту процедуру, которой будут пользоваться в аварии, — иначе проверка подтверждает
# работоспособность чего-то другого.
if ! "$SCRIPT_DIR/restore.sh" --file "$DUMP_FILE" --into "$TEST_DB" --yes > /tmp/verify-restore.$$ 2>&1; then
  RESTORE_OUT="$(tail -c 1200 /tmp/verify-restore.$$)"
  rm -f /tmp/verify-restore.$$
  verify_failed "Восстановление в тестовую базу упало:
${RESTORE_OUT}"
fi
rm -f /tmp/verify-restore.$$

# 2. Контрольные запросы.
VENUES="$(psql_value "$TEST_URL" "SELECT count(*) FROM venues")"
ITEMS="$(psql_value "$TEST_URL" "SELECT count(*) FROM items")"
ADMINS="$(psql_value "$TEST_URL" "SELECT count(*) FROM admins")"
MIGRATION="$(psql_value "$TEST_URL" "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1")"

[ -n "$VENUES" ] && [ "$VENUES" != "0" ] || verify_failed "В восстановленной базе ноль заведений."
[ -n "$ITEMS" ] || verify_failed "Не удалось сосчитать позиции в восстановленной базе."

# Сверка с манифестом: восстановилось ли ровно то, что записывали. Расхождение означает либо
# порченый дамп, либо порченый манифест — в обоих случаях доверять этому бэкапу нельзя.
if [ -f "$MANIFEST" ]; then
  M_VENUES="$(grep -o '"venues": [0-9]*' "$MANIFEST" | grep -o '[0-9]*')"
  M_ITEMS="$(grep -o '"items": [0-9]*' "$MANIFEST" | grep -o '[0-9]*')"
  [ "$VENUES" = "$M_VENUES" ] || verify_failed "Заведений в манифесте $M_VENUES, а восстановилось $VENUES."
  [ "$ITEMS" = "$M_ITEMS" ] || verify_failed "Позиций в манифесте $M_ITEMS, а восстановилось $ITEMS."
fi

# 3. Целостность внешних ключей (прямое требование промта). NOT VALID-ограничений в схеме нет,
# но восстановленная база могла приехать с отключёнными проверками, и убедиться дешевле,
# чем однажды обнаружить осиротевшие строки.
#
# Проверяем самые нагруженные связи явными запросами: VALIDATE CONSTRAINT на всю схему занял бы
# минуты и требовал бы прав владельца.
ORPHAN_ITEMS="$(psql_value "$TEST_URL" "SELECT count(*) FROM items i LEFT JOIN categories c ON c.id = i.category_id WHERE c.id IS NULL")"
ORPHAN_CATS="$(psql_value "$TEST_URL" "SELECT count(*) FROM categories c LEFT JOIN venues v ON v.id = c.venue_id WHERE v.id IS NULL")"
ORPHAN_LINKS="$(psql_value "$TEST_URL" "SELECT count(*) FROM admin_venues av LEFT JOIN venues v ON v.id = av.venue_id WHERE v.id IS NULL")"

[ "$ORPHAN_ITEMS" = "0" ] || verify_failed "В восстановленной базе $ORPHAN_ITEMS позиций без категории."
[ "$ORPHAN_CATS" = "0" ] || verify_failed "В восстановленной базе $ORPHAN_CATS категорий без заведения."
[ "$ORPHAN_LINKS" = "0" ] || verify_failed "В восстановленной базе $ORPHAN_LINKS связей доступа без заведения."

log "контрольные запросы: заведений $VENUES, позиций $ITEMS, администраторов $ADMINS, схема $MIGRATION"
log "внешние ключи: осиротевших строк нет"

# 4. Убираем за собой. Тестовая база не должна оставаться на сервере: её легко перепутать
# с боевой, а место она занимает как боевая.
drop_test_db
log "тестовая база удалена"

state_set last_verify_at "$(date -Iseconds)"
state_set last_verify_status ok
write_state "$([ "$(state_get consecutive_failures)" = "0" ] && echo ok || echo failed)" ""

# --- еженедельная сводка (раздел 4 промта) --------------------------------------------------------
DB_BYTES="$(psql_value "$DATABASE_URL_VALUE" "SELECT pg_database_size('$SOURCE_DB')")"
[ -z "$DB_BYTES" ] && DB_BYTES=0
UPLOADS_BYTES="$(dir_size_bytes "$UPLOADS_DIR")"
DUMP_BYTES="$(file_size_bytes "$DUMP_FILE")"

# Динамика роста — сравнение с прошлой сводкой. Хранится в том же каталоге состояния;
# при первой сводке сравнивать не с чем, и мы честно так и пишем, а не рисуем «+0%».
PREV_DB="$(state_get last_summary_db_bytes)"
PREV_UP="$(state_get last_summary_uploads_bytes)"

growth_line() {
  local now="$1" prev="$2" label="$3"
  if [ -z "$prev" ] || [ "$prev" = "0" ]; then
    printf '%s: %s (первая сводка, сравнивать не с чем)' "$label" "$(human_size "$now")"
  else
    local delta_pct
    delta_pct="$(awk -v n="$now" -v p="$prev" 'BEGIN{printf "%+.1f", (n-p)*100.0/p}')"
    printf '%s: %s (%s%% за неделю)' "$label" "$(human_size "$now")" "$delta_pct"
  fi
}

state_set last_summary_db_bytes "$DB_BYTES"
state_set last_summary_uploads_bytes "$UPLOADS_BYTES"

FREE_PCT="$(disk_free_percent "$BACKUP_ROOT")"
DAILY_COUNT="$(find "$DAILY_DIR" -maxdepth 1 -name '*.dump' 2>/dev/null | wc -l | tr -d ' ')"

send_telegram "📦 Бэкапы qr.menu — недельная сводка

Проверка восстановления: пройдена $(date '+%d.%m.%Y %H:%M')
Восстановлено из бэкапа: заведений $VENUES, позиций $ITEMS, схема $MIGRATION

$(growth_line "$DB_BYTES" "$PREV_DB" 'База')
$(growth_line "$UPLOADS_BYTES" "$PREV_UP" 'Фото')
Последний дамп: $(human_size "$DUMP_BYTES")
Хранится ежедневных копий: $DAILY_COUNT
Свободно на диске бэкапов: ${FREE_PCT}%"

log "=== проверка восстановления пройдена ==="
