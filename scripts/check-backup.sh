#!/usr/bin/env bash
# Промт 4.1. Проверка того, как бэкап ведёт себя в ситуациях, которые на живых данных
# не воспроизвести: обрыв дампа, зависший pg_dump, заполнившийся диск, пустая база,
# ротация 7/4/6, две неудачи подряд.
#
#   ./scripts/check-backup.sh
#
# Все внешние команды ЗАМЕНЕНЫ ЗАГЛУШКАМИ в песочнице: PATH подменяется на каталог, где лежат
# поддельные pg_dump/psql, ведущие себя так, как задал конкретный случай. Иначе проверить
# «pg_dump завис» или «диск кончился» было бы нечем — не ломать же настоящую базу.
#
# Настоящий цикл дамп -> восстановление -> контрольные запросы делает не этот скрипт,
# а backup.sh + verify-backup.sh на живой базе (см. README, раздел про бэкапы).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

passed=0
failed=0

report() {
  if [ "$1" = "0" ]; then
    passed=$((passed + 1))
    printf '  ok   %s\n' "$2"
  else
    failed=$((failed + 1))
    printf '  FAIL %s\n' "$2" >&2
    [ -n "${3:-}" ] && printf '       %s\n' "$3" >&2
  fi
}

# Заглушки внешних команд. FAKE_* управляют их поведением из каждого случая.
setup_stubs() {
  local bin="$SANDBOX/bin"
  mkdir -p "$bin"

  cat > "$bin/pg_dump" <<'STUB'
#!/usr/bin/env bash
# Ведёт себя так, как велит FAKE_DUMP_MODE: ok — выдаёт правдоподобный дамп,
# tiny — обрывок, fail — ошибка, hang — висит (проверяем таймаут).
case "${FAKE_DUMP_MODE:-ok}" in
  hang)  sleep 60 ;;
  fail)  echo "pg_dump: error: connection to server failed" >&2; exit 1 ;;
  tiny)  printf 'PGDMP' ;;
  *)     printf 'PGDMP'; head -c 200000 /dev/zero | tr '\0' 'x' ;;
esac
STUB

  cat > "$bin/psql" <<'STUB'
#!/usr/bin/env bash
# Отвечает на контрольные запросы значениями из FAKE_*.
query=""
while [ $# -gt 0 ]; do
  [ "$1" = "-c" ] && query="${2:-}"
  shift
done
case "$query" in
  *server_version*)   echo "${FAKE_PG_VERSION:-16.15}" ;;
  *pgmigrations*)     echo "${FAKE_SCHEMA:-1787508600000_test}" ;;
  *FROM\ venues*)     echo "${FAKE_VENUES:-5}" ;;
  *FROM\ items*)      echo "${FAKE_ITEMS:-90}" ;;
  *) echo "" ;;
esac
STUB

  chmod +x "$bin/pg_dump" "$bin/psql"
  printf '%s' "$bin"
}

STUB_BIN="$(setup_stubs)"

# Запускает backup.sh в чистой песочнице. Каждый случай получает свой каталог, чтобы
# состояние и ротация из предыдущего не влияли на следующий.
run_backup() {
  local case_dir="$SANDBOX/$1"; shift
  mkdir -p "$case_dir"
  env PATH="$STUB_BIN:$PATH" \
      BACKUP_DIR="$case_dir/store" \
      BACKUP_STATE_DIR="$case_dir/state" \
      BACKUP_STATE_FILE="$case_dir/state.json" \
      BACKUP_UPLOADS_DIR="$case_dir/uploads" \
      BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
      BACKUP_OFFSITE_TARGET="" \
      BACKUP_DISK_WARN_PERCENT=0 \
      BACKUP_DISK_CRIT_PERCENT=0 \
      "$@" \
      bash "$SCRIPT_DIR/backup.sh" > "$case_dir/out.log" 2>&1
}

echo "Проверка бэкапов (внешние команды — заглушки, живая база не трогается)"
echo

# --- успешный путь -------------------------------------------------------------------------------
echo "Обычный бэкап:"
run_backup ok
code=$?
CASE="$SANDBOX/ok"
report "$([ $code -eq 0 ] && echo 0 || echo 1)" "успешный бэкап завершается кодом 0" "код $code"
report "$([ -f "$CASE"/store/daily/*.dump ] 2>/dev/null && echo 0 || echo 1)" "дамп создан"
report "$(ls "$CASE"/store/daily/*.manifest.json >/dev/null 2>&1 && echo 0 || echo 1)" "манифест создан"

MANIFEST="$(ls "$CASE"/store/daily/*.manifest.json 2>/dev/null | head -1)"
if [ -n "$MANIFEST" ]; then
  for field in createdAt dumpBytes dumpSha256 postgresVersion schemaVersion venues items uploadsFiles; do
    report "$(grep -q "\"$field\"" "$MANIFEST" && echo 0 || echo 1)" "в манифесте есть $field"
  done
  DUMP="$(ls "$CASE"/store/daily/*.dump | head -1)"
  M_SHA="$(grep -o '"dumpSha256": "[^"]*"' "$MANIFEST" | sed 's/.*: "//;s/"//')"
  report "$([ "$M_SHA" = "$(sha256sum "$DUMP" | awk '{print $1}')" ] && echo 0 || echo 1)" "контрольная сумма в манифесте совпадает с файлом"
fi

report "$(grep -q '"lastStatus": "ok"' "$CASE/state.json" && echo 0 || echo 1)" "состояние для health-check записано как ok"
report "$(grep -q 'TELEGRAM' "$CASE/out.log" && echo 1 || echo 0)" "успешный бэкап НЕ шлёт сообщений (промт: тихо)"

# --- снимки uploads -----------------------------------------------------------------------------
# Промт: «полный архив раз в неделю, ежедневно — инкремент». Реализовано через rsync --link-dest:
# каждый снимок — полное дерево, но неизменившиеся файлы в нём жёсткие ссылки на вчерашние.
#
# Без rsync шаг пропускается — на Windows его в Git Bash нет, и честнее сказать об этом,
# чем сделать вид, что фото проверены. На сервере (Linux) rsync есть всегда.
echo
echo "Снимки uploads:"
if ! command -v rsync >/dev/null 2>&1; then
  echo "  ПРОПУЩЕНО: rsync не установлен. Фото на этой машине не проверены."
  echo "  Прогоните этот скрипт на Linux (или в контейнере), чтобы проверить и их."
else
  CASE="$SANDBOX/uploads"
  mkdir -p "$CASE/uploads/12"
  printf 'фото-один' > "$CASE/uploads/12/a.webp"
  printf 'фото-два'  > "$CASE/uploads/12/b.webp"

  run_uploads_backup() {
    env PATH="$STUB_BIN:$PATH" \
        BACKUP_DIR="$CASE/store" BACKUP_STATE_DIR="$CASE/state" BACKUP_STATE_FILE="$CASE/state.json" \
        BACKUP_UPLOADS_DIR="$CASE/uploads" BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
        BACKUP_OFFSITE_TARGET="" BACKUP_DISK_WARN_PERCENT=0 BACKUP_DISK_CRIT_PERCENT=0 \
        bash "$SCRIPT_DIR/backup.sh" >> "$CASE/out.log" 2>&1
  }

  run_uploads_backup
  SNAP_TODAY="$CASE/store/uploads/$(date +%F)"
  report "$([ -f "$SNAP_TODAY/12/a.webp" ] && echo 0 || echo 1)" "снимок uploads сделан и содержит файлы"

  MANIFEST_U="$(ls "$CASE"/store/daily/*.manifest.json 2>/dev/null | head -1)"
  report "$(grep -q '"uploadsFiles": 2' "$MANIFEST_U" && echo 0 || echo 1)" "число файлов uploads попало в манифест"

  # Второй прогон с подменённой датой снимка: имитируем «вчера», чтобы проверить инкремент.
  # Переименовываем снимок в позавчерашний день — тогда следующий запуск возьмёт его как основу.
  mv "$SNAP_TODAY" "$CASE/store/uploads/2026-01-01"
  printf 'фото-один-новое' > "$CASE/uploads/12/a.webp"
  printf 'фото-три'        > "$CASE/uploads/12/c.webp"
  rm "$CASE/uploads/12/b.webp"
  run_uploads_backup

  report "$([ -f "$SNAP_TODAY/12/c.webp" ] && echo 0 || echo 1)" "новый файл попал в свежий снимок"
  report "$([ ! -f "$SNAP_TODAY/12/b.webp" ] && echo 0 || echo 1)" "удалённый файл из свежего снимка ушёл"
  report "$([ -f "$CASE/store/uploads/2026-01-01/12/b.webp" ] && echo 0 || echo 1)" \
    "но в предыдущем снимке он ЦЕЛ — это и есть история"
  report "$([ "$(cat "$CASE/store/uploads/2026-01-01/12/a.webp")" = "фото-один" ] && echo 0 || echo 1)" \
    "предыдущий снимок хранит СТАРУЮ версию изменённого файла"

  # Инкремент по существу: неизменённый файл в новом снимке — та же inode, что в старом.
  if command -v stat >/dev/null 2>&1; then
    printf 'фото-один-новое' > "$CASE/uploads/12/unchanged.webp"
    mv "$SNAP_TODAY" "$CASE/store/uploads/2026-01-02"
    run_uploads_backup
    INO_OLD="$(stat -c %i "$CASE/store/uploads/2026-01-02/12/c.webp" 2>/dev/null || echo x)"
    INO_NEW="$(stat -c %i "$SNAP_TODAY/12/c.webp" 2>/dev/null || echo y)"
    report "$([ "$INO_OLD" = "$INO_NEW" ] && echo 0 || echo 1)" \
      "неизменённый файл — жёсткая ссылка на вчерашний, место не тратится" "($INO_OLD vs $INO_NEW)"
  fi
fi

# --- вторая копия -------------------------------------------------------------------------------
# Промт: «Второе место хранения обязательно. Бэкап на том же диске, что и БД, бэкапом
# не является». В проде цель — другой сервер по ssh; здесь локальный каталог, который проходит
# ровно тот же код (rsync с той же строкой аргументов), только без сети.
echo
echo "Вторая копия:"
if ! command -v rsync >/dev/null 2>&1; then
  echo "  ПРОПУЩЕНО: rsync не установлен."
else
  CASE="$SANDBOX/offsite"
  mkdir -p "$CASE/uploads" "$CASE/remote"
  env PATH="$STUB_BIN:$PATH" \
      BACKUP_DIR="$CASE/store" BACKUP_STATE_DIR="$CASE/state" BACKUP_STATE_FILE="$CASE/state.json" \
      BACKUP_UPLOADS_DIR="$CASE/uploads" BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
      BACKUP_OFFSITE_TARGET="$CASE/remote/" BACKUP_DISK_WARN_PERCENT=0 BACKUP_DISK_CRIT_PERCENT=0 \
      bash "$SCRIPT_DIR/backup.sh" > "$CASE/out.log" 2>&1
  code=$?
  report "$([ $code -eq 0 ] && echo 0 || echo 1)" "бэкап со второй копией проходит" "код $code"
  report "$([ -n "$(find "$CASE/remote/daily" -name '*.dump' 2>/dev/null)" ] && echo 0 || echo 1)" \
    "дамп доехал до второго места хранения"
  report "$([ -n "$(find "$CASE/remote/daily" -name '*.manifest.json' 2>/dev/null)" ] && echo 0 || echo 1)" \
    "манифест доехал вместе с дампом"

  # Недоступное второе хранилище — это авария, а не мелочь: одна копия бэкапом не считается,
  # и молча засчитывать такую ночь успешной нельзя.
  CASE="$SANDBOX/offsite_fail"
  mkdir -p "$CASE/uploads"
  env PATH="$STUB_BIN:$PATH" \
      BACKUP_DIR="$CASE/store" BACKUP_STATE_DIR="$CASE/state" BACKUP_STATE_FILE="$CASE/state.json" \
      BACKUP_UPLOADS_DIR="$CASE/uploads" BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
      BACKUP_OFFSITE_TARGET="/nonexistent-mount-point-$$/backups/" \
      BACKUP_DISK_WARN_PERCENT=0 BACKUP_DISK_CRIT_PERCENT=0 \
      bash "$SCRIPT_DIR/backup.sh" > "$CASE/out.log" 2>&1
  code=$?
  report "$([ $code -ne 0 ] && echo 0 || echo 1)" "недоступное второе хранилище — это неудача бэкапа" "код $code"
  report "$(grep -q 'внешнее хранилище' "$CASE/out.log" && echo 0 || echo 1)" "в алерте сказано, что не доехала вторая копия"
  report "$(grep -q '"lastStatus": "failed"' "$CASE/state.json" && echo 0 || echo 1)" "health-check увидит это как неудачу"
fi

# --- обрыв дампа ---------------------------------------------------------------------------------
echo
echo "Дамп не удался:"
run_backup fail FAKE_DUMP_MODE=fail
code=$?
CASE="$SANDBOX/fail"
report "$([ $code -ne 0 ] && echo 0 || echo 1)" "неудачный бэкап завершается ненулевым кодом" "код $code"
report "$([ -z "$(find "$CASE/store/daily" -name '*.dump' 2>/dev/null)" ] && echo 0 || echo 1)" \
  "частичный файл удалён (промт: диск заполнился — частичный файл удаляется)"
report "$(grep -q '"lastStatus": "failed"' "$CASE/state.json" && echo 0 || echo 1)" "состояние записано как failed"
report "$(grep -q 'connection to server failed' "$CASE/state.json" && echo 0 || echo 1)" "причина ошибки попала в состояние"
report "$(grep -q '⚠️ Бэкап qr.menu не удался' "$CASE/out.log" && echo 0 || echo 1)" "ушёл алерт о неудаче"

# --- вторая неудача подряд -----------------------------------------------------------------------
echo
echo "Две неудачи подряд (промт: повторный алерт с пометкой критичности):"
CASE="$SANDBOX/fail"
env PATH="$STUB_BIN:$PATH" FAKE_DUMP_MODE=fail \
    BACKUP_DIR="$CASE/store" BACKUP_STATE_DIR="$CASE/state" BACKUP_STATE_FILE="$CASE/state.json" \
    BACKUP_UPLOADS_DIR="$CASE/uploads" BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
    BACKUP_OFFSITE_TARGET="" BACKUP_DISK_WARN_PERCENT=0 BACKUP_DISK_CRIT_PERCENT=0 \
    bash "$SCRIPT_DIR/backup.sh" > "$CASE/out2.log" 2>&1
report "$(grep -q '🔴 КРИТИЧНО' "$CASE/out2.log" && echo 0 || echo 1)" "вторая неудача подряд помечена критичной"
report "$(grep -q '"consecutiveFailures": 2' "$CASE/state.json" && echo 0 || echo 1)" "счётчик неудач подряд дошёл до 2"

# --- зависший pg_dump ------------------------------------------------------------------------------
echo
echo "pg_dump завис (промт: таймаут и убийство процесса с алертом):"
run_backup hang FAKE_DUMP_MODE=hang BACKUP_DUMP_TIMEOUT_SECONDS=2
code=$?
CASE="$SANDBOX/hang"
report "$([ $code -ne 0 ] && echo 0 || echo 1)" "зависший дамп прерывается, а не висит вечно" "код $code"
report "$(grep -q 'не уложился' "$CASE/out.log" && echo 0 || echo 1)" "в алерте сказано именно про таймаут"
report "$([ -z "$(find "$CASE/store/daily" -name '*.dump' 2>/dev/null)" ] && echo 0 || echo 1)" "недописанный файл убран"

# --- подозрительно маленький дамп ---------------------------------------------------------------------
echo
echo "Дамп обрезан на старте:"
run_backup tiny FAKE_DUMP_MODE=tiny
code=$?
report "$([ $code -ne 0 ] && echo 0 || echo 1)" "обрезанный дамп считается неудачей" "код $code"
report "$(grep -q 'не похоже на рабочую базу' "$SANDBOX/tiny/out.log" && echo 0 || echo 1)" "сказано, что дамп подозрительно мал"

# --- пустая база -------------------------------------------------------------------------------------
echo
echo "В базе ноль заведений (промт: счётчики нужны, чтобы заметить бэкап пустой базы):"
run_backup empty FAKE_VENUES=0
code=$?
report "$([ $code -ne 0 ] && echo 0 || echo 1)" "бэкап пустой базы считается неудачей" "код $code"
report "$(grep -q 'ноль заведений' "$SANDBOX/empty/out.log" && echo 0 || echo 1)" "сказано про ноль заведений"

# --- мало места ----------------------------------------------------------------------------------------
echo
echo "Место на диске (промт: <20% предупреждение, <10% критический алерт):"
run_backup disk_warn BACKUP_FAKE_FREE_PERCENT=15 BACKUP_DISK_WARN_PERCENT=20 BACKUP_DISK_CRIT_PERCENT=10
code=$?
report "$([ $code -eq 0 ] && echo 0 || echo 1)" "при 15% свободного бэкап всё равно делается" "код $code"
report "$(grep -q '⚠️ На диске бэкапов осталось 15%' "$SANDBOX/disk_warn/out.log" && echo 0 || echo 1)" "но пришло предупреждение"

run_backup disk_crit BACKUP_FAKE_FREE_PERCENT=5 BACKUP_DISK_WARN_PERCENT=20 BACKUP_DISK_CRIT_PERCENT=10
code=$?
report "$([ $code -ne 0 ] && echo 0 || echo 1)" "при 5% свободного бэкап не начинается" "код $code"
report "$(grep -q '🔴 КРИТИЧНО: на диске' "$SANDBOX/disk_crit/out.log" && echo 0 || echo 1)" "и пришёл критический алерт"
report "$([ -z "$(find "$SANDBOX/disk_crit/store/daily" -name '*.dump' 2>/dev/null)" ] && echo 0 || echo 1)" \
  "при нехватке места старые бэкапы не трогаются, новый не создаётся"

# --- ротация --------------------------------------------------------------------------------------------
echo
echo "Ротация (промт: 7 ежедневных, 4 еженедельных, 6 ежемесячных):"
CASE="$SANDBOX/rotate"
mkdir -p "$CASE/store/daily"
# Десять «вчерашних» бэкапов: после нового должно остаться ровно KEEP_DAILY.
for i in $(seq -w 1 10); do
  printf 'old' > "$CASE/store/daily/qrmenu-202601${i}-000000.dump"
  printf '{}' > "$CASE/store/daily/qrmenu-202601${i}-000000.manifest.json"
done
env PATH="$STUB_BIN:$PATH" \
    BACKUP_DIR="$CASE/store" BACKUP_STATE_DIR="$CASE/state" BACKUP_STATE_FILE="$CASE/state.json" \
    BACKUP_UPLOADS_DIR="$CASE/uploads" BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
    BACKUP_OFFSITE_TARGET="" BACKUP_DISK_WARN_PERCENT=0 BACKUP_DISK_CRIT_PERCENT=0 BACKUP_KEEP_DAILY=7 \
    bash "$SCRIPT_DIR/backup.sh" > "$CASE/out.log" 2>&1

remaining="$(find "$CASE/store/daily" -name '*.dump' | wc -l | tr -d ' ')"
report "$([ "$remaining" = "7" ] && echo 0 || echo 1)" "после ротации осталось ровно 7 ежедневных" "осталось $remaining"
# Точный список: было 10 старых плюс новый, оставить надо 7 — значит уйти обязаны четыре
# САМЫХ СТАРЫХ (01–04), а 05–10 остаться. Проверять «сколько осталось» мало: ротация,
# удаляющая случайные четыре, дала бы то же число.
gone_ok=0
for i in 01 02 03 04; do
  [ -f "$CASE/store/daily/qrmenu-202601${i}-000000.dump" ] && gone_ok=1
done
for i in 05 06 07 08 09 10; do
  [ -f "$CASE/store/daily/qrmenu-202601${i}-000000.dump" ] || gone_ok=1
done
report "$gone_ok" "удалены ровно четыре самых старых, свежие остались"
report "$([ ! -f "$CASE/store/daily/qrmenu-20260101-000000.manifest.json" ] && echo 0 || echo 1)" "манифест удалён вместе со своим дампом"

# Порядок из промта: сначала новый бэкап, потом удаление старых. Если бы порядок был обратный,
# упавший дамп оставил бы и без нового, и без старых.
CASE="$SANDBOX/rotate_order"
mkdir -p "$CASE/store/daily"
for i in $(seq -w 1 10); do printf 'old' > "$CASE/store/daily/qrmenu-202601${i}-000000.dump"; done
env PATH="$STUB_BIN:$PATH" FAKE_DUMP_MODE=fail \
    BACKUP_DIR="$CASE/store" BACKUP_STATE_DIR="$CASE/state" BACKUP_STATE_FILE="$CASE/state.json" \
    BACKUP_UPLOADS_DIR="$CASE/uploads" BACKUP_DATABASE_URL="postgres://u:p@localhost:5432/qrmenu" \
    BACKUP_OFFSITE_TARGET="" BACKUP_DISK_WARN_PERCENT=0 BACKUP_DISK_CRIT_PERCENT=0 BACKUP_KEEP_DAILY=7 \
    bash "$SCRIPT_DIR/backup.sh" > "$CASE/out.log" 2>&1
remaining="$(find "$CASE/store/daily" -name '*.dump' | wc -l | tr -d ' ')"
report "$([ "$remaining" = "10" ] && echo 0 || echo 1)" \
  "при неудачном дампе старые бэкапы НЕ удаляются (порядок из промта)" "осталось $remaining из 10"

echo
echo "проверок: $((passed + failed)), пройдено: $passed, провалов: $failed"
[ "$failed" -eq 0 ] || exit 1
