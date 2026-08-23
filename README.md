# QR-меню

Сервис QR-меню для мини-заведений (кофейни, суши-студии, мини-кафе, бары).

## Стек

- Node.js + Express
- EJS (серверный рендеринг)
- PostgreSQL + node-pg-migrate
- express-session + connect-pg-simple
- bcrypt, zod, multer + sharp, qrcode

## Запуск для разработки

1. Скопировать `.env.example` в `.env` и при необходимости поменять значения:

   ```
   cp .env.example .env
   ```

2. Поднять PostgreSQL через Docker:

   ```
   docker compose up -d
   ```

   Контейнер публикует Postgres на хостовом порту `5433` (а не стандартном `5432`), чтобы не конфликтовать с локально установленным PostgreSQL, если он у вас уже запущен. Это отражено в `.env.example`.

3. Установить зависимости:

   ```
   npm install
   ```

4. Прогнать миграции:

   ```
   npm run migrate:up
   ```

5. (Опционально) засеять тестовое заведение с парой категорий и позиций для локальной разработки:

   ```
   npm run seed
   ```

   Скрипт идемпотентен — при повторном запуске просто пропустит сидирование, если тестовое заведение (`slug=test-cafe`) уже существует.

   Также создаст тестовые учётные записи для входа в `/admin/login` (**только для локальной разработки**):

   | Логин | Пароль | Роль |
   |---|---|---|
   | `superadmin` | `superadmin123` | superadmin |
   | `venue_admin` | `venueadmin123` | venue_admin (заведение test-cafe) |
   | `staff` | `staff123` | staff (заведение test-cafe) |

6. Запустить сервер в режиме разработки (перезапуск при изменении файлов):

   ```
   npm run dev
   ```

7. Проверить, что сервер поднялся и подключился к БД:

   ```
   curl http://localhost:3000/health
   ```

   Должен вернуться `{"status":"ok","db":"connected"}`.

## Структура проекта

```
/src
  /routes        маршруты Express
  /controllers   обработчики маршрутов
  /models        доступ к данным (SQL-запросы)
  /middlewares   auth, роли, rate-limit и т.п.
  /views         EJS-шаблоны
  /public        статика (css/js), отдаётся по /
  /i18n          словари переводов ru.json / uz.json
  /config        конфигурация (подключение к БД и т.п.)
/migrations      миграции node-pg-migrate
/seed            скрипт наполнения БД тестовыми данными для локальной разработки
/public/uploads  загруженные пользователем фото (photo_url)
```

## Миграции

```
npm run migrate:up             # применить все непримененные миграции
npm run migrate:down           # откатить последнюю миграцию
npm run migrate:down -- N      # откатить последние N миграций
npm run migrate -- create some_name -j cjs   # создать новую миграцию (CommonJS-шаблон)
```

## Остановка и удаление БД

```
docker compose down          # остановить контейнер, данные сохранятся в volume
docker compose down -v       # остановить и удалить volume с данными
```
