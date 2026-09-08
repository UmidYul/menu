#!/usr/bin/env bash
# Промт 4.1, раздел 3. Восстановление из бэкапа.
#
#   ./scripts/restore.sh                              — последний дамп в базу <имя>_restore_test
#   ./scripts/restore.sh --file /path/to.dump         — конкретный дамп
#   ./scripts/restore.sh --into qrmenu_copy           — в другую базу (создаётся, если её нет)
#   ./scripts/restore.sh --into qrmenu --i-mean-it    — В ПРОДАКШЕН (только так, явным флагом)
#   ./scripts/restore.sh --uploads-only [--snapshot 2026-09-08]  — только фото
#
# ПО УМОЛЧАНИЮ ВОССТАНАВЛИВАЕТ НЕ В ПРОДАКШЕН (прямое требование промта). Продакшен-база
# требует и точного совпадения имени с боевым, и отдельного флага --i-mean-it, и ввода слова
# с клавиатуры. Три барьера подряд — потому что цена ошибки здесь не «перезапустить скрипт»,
# а «потеряли данные, которые как раз и восстанавливали».
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/backup-lib.sh"

DUMP_FILE=""
TARGET_DB=""
FORCE=0
UPLOADS_ONLY=0
SNAPSHOT=""
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --file) DUMP_FILE="${2:-}"; shift 2 ;;
    --into) TARGET_DB="${2:-}"; shift 2 ;;
    --snapshot) SNAPSHOT="${2:-}"; shift 2 ;;
    --i-mean-it) FORCE=1; shift ;;
    --uploads-only) UPLOADS_ONLY=1; shift ;;
    # Для автоматической проверки восстановления (verify-backup.sh): она и так работает
    # с одноразовой тестовой базой, и спрашивать в таймере некого.
    --yes) ASSUME_YES=1; shift ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DATABASE_URL_VALUE" ]; then
  echo "BACKUP_DATABASE_URL не задан — некуда восстанавливать. Заполните scripts/backup.env." >&2
  exit 1
fi

SOURCE_DB="$(db_name_from_url "$DATABASE_URL_VALUE")"

# --- только фото ------------------------------------------------------------------------------
# Промт, edge case: «Фото удалены, но есть в бэкапе — процедура частичного восстановления
# только uploads должна быть описана отдельно». Она и отдельная: базу здесь не трогаем вовсе.
if [ "$UPLOADS_ONLY" = "1" ]; then
  if [ -z "$SNAPSHOT" ]; then
    SNAPSHOT="$(find "$UPLOADS_SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1 | xargs -r basename)"
  fi
  SNAP_PATH="$UPLOADS_SNAPSHOT_DIR/$SNAPSHOT"
  [ -d "$SNAP_PATH" ] || { echo "снимок uploads не найден: $SNAP_PATH" >&2; exit 1; }

  echo "Восстановление ТОЛЬКО фото из снимка $SNAPSHOT в $UPLOADS_DIR"
  echo "Файлы, которых нет в снимке, будут УДАЛЕНЫ из $UPLOADS_DIR."
  if [ "$ASSUME_YES" != "1" ]; then
    printf 'Введите ВОССТАНОВИТЬ для подтверждения: '
    read -r answer
    [ "$answer" = "ВОССТАНОВИТЬ" ] || { echo "отменено"; exit 1; }
  fi

  mkdir -p "$UPLOADS_DIR"
  rsync -a --delete "$SNAP_PATH/" "$UPLOADS_DIR/" || { echo "rsync не смог восстановить фото" >&2; exit 1; }
  echo "готово: $(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ') файлов"
  exit 0
fi

# --- выбор дампа ------------------------------------------------------------------------------
if [ -z "$DUMP_FILE" ]; then
  DUMP_FILE="$(find "$DAILY_DIR" -maxdepth 1 -name 'qrmenu-*.dump' 2>/dev/null | sort | tail -n 1)"
fi
[ -n "$DUMP_FILE" ] && [ -f "$DUMP_FILE" ] || { echo "дамп не найден (искали в $DAILY_DIR)" >&2; exit 1; }

MANIFEST="${DUMP_FILE%.dump}.manifest.json"

echo "Дамп:     $DUMP_FILE ($(human_size "$(file_size_bytes "$DUMP_FILE")"))"

# Проверка контрольной суммы ДО восстановления: битый файл лучше обнаружить сейчас, чем
# на середине наката в базу.
if [ -f "$MANIFEST" ]; then
  EXPECTED_SHA="$(grep -o '"dumpSha256": "[^"]*"' "$MANIFEST" | sed 's/.*: "//;s/"//')"
  ACTUAL_SHA="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
  if [ -n "$EXPECTED_SHA" ] && [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "КОНТРОЛЬНАЯ СУММА НЕ СОВПАЛА — файл повреждён. Восстановление отменено." >&2
    echo "  ожидалась: $EXPECTED_SHA" >&2
    echo "  получена:  $ACTUAL_SHA" >&2
    exit 1
  fi
  echo "Манифест: контрольная сумма совпала"

  # Промт, edge case: «Восстановление на другой версии PostgreSQL — зафиксируй версию
  # в манифесте и предупреди в документации». Предупреждаем и здесь, в момент действия:
  # читать README посреди аварии никто не станет.
  DUMP_PG="$(grep -o '"postgresVersion": "[^"]*"' "$MANIFEST" | sed 's/.*: "//;s/"//')"
  LOCAL_PG="$(psql_value "$DATABASE_URL_VALUE" "SHOW server_version")"
  if [ -n "$DUMP_PG" ] && [ -n "$LOCAL_PG" ]; then
    DUMP_MAJOR="${DUMP_PG%%.*}"
    LOCAL_MAJOR="${LOCAL_PG%%.*}"
    if [ "$DUMP_MAJOR" != "$LOCAL_MAJOR" ]; then
      echo "ВНИМАНИЕ: дамп снят с PostgreSQL $DUMP_PG, здесь $LOCAL_PG."
      [ "$LOCAL_MAJOR" -lt "$DUMP_MAJOR" ] 2>/dev/null \
        && echo "  Восстановление на БОЛЕЕ СТАРУЮ версию не поддерживается и, скорее всего, не пройдёт."
    fi
  fi
  grep -E '"(venues|items|schemaVersion)"' "$MANIFEST" | sed 's/^/  /'
fi

# --- выбор целевой базы --------------------------------------------------------------------------
if [ -z "$TARGET_DB" ]; then
  TARGET_DB="${SOURCE_DB}_restore_test"
fi

if [ "$TARGET_DB" = "$SOURCE_DB" ]; then
  if [ "$FORCE" != "1" ]; then
    echo >&2
    echo "ОТКАЗ: '$TARGET_DB' — это боевая база. Восстановление в неё сотрёт всё, что там сейчас есть." >&2
    echo "Если вы действительно этого хотите, добавьте --i-mean-it." >&2
    echo "По умолчанию скрипт восстанавливает в ${SOURCE_DB}_restore_test и ничего не ломает." >&2
    exit 1
  fi
  echo
  echo "!!! ВОССТАНОВЛЕНИЕ В БОЕВУЮ БАЗУ '$TARGET_DB' !!!"
  echo "Текущее содержимое будет УДАЛЕНО без возможности вернуть."
  if [ "$ASSUME_YES" != "1" ]; then
    printf 'Введите имя базы (%s) для подтверждения: ' "$TARGET_DB"
    read -r answer
    [ "$answer" = "$TARGET_DB" ] || { echo "отменено"; exit 1; }
  fi
fi

TARGET_URL="$(db_url_with_name "$DATABASE_URL_VALUE" "$TARGET_DB")"
# Служебные команды (DROP/CREATE DATABASE) нельзя выполнять, будучи подключённым к той же базе,
# поэтому идём через postgres — она есть на любом сервере.
ADMIN_URL="$(db_url_with_name "$DATABASE_URL_VALUE" "postgres")"

echo "Цель:     $TARGET_DB"
echo

# shellcheck disable=SC2086
$PSQL "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" >/dev/null 2>&1 \
  || $PSQL "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null
# shellcheck disable=SC2086
$PSQL "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\"" >/dev/null || {
  echo "не удалось создать базу $TARGET_DB" >&2; exit 1;
}

echo "накатываю дамп..."
# --no-owner/--no-privileges: на новом сервере ролей из старого может не быть вовсе, и падать
# из-за отсутствующего владельца при восстановлении данных — последнее, что нужно в аварии.
# shellcheck disable=SC2086
if ! $PGRESTORE --no-owner --no-privileges --dbname "$TARGET_URL" < "$DUMP_FILE"; then
  echo "pg_restore сообщил об ошибках — проверьте вывод выше." >&2
  exit 1
fi

VENUES="$(psql_value "$TARGET_URL" "SELECT count(*) FROM venues")"
ITEMS="$(psql_value "$TARGET_URL" "SELECT count(*) FROM items")"
echo
echo "готово: база $TARGET_DB, заведений $VENUES, позиций $ITEMS"
[ "$TARGET_DB" != "$SOURCE_DB" ] && echo "Боевая база не тронута."
exit 0
