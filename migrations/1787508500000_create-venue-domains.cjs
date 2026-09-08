/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.7, раздел 1. Свой домен заведения: menu.mykafe.uz вместо qr.menu/menu/slug.
  pgm.createTable('venue_domains', {
    id: 'id',
    venue_id: {
      type: 'integer',
      notNull: true,
      references: 'venues',
      onDelete: 'CASCADE',
    },
    // Хранится ВСЕГДА в нижнем регистре, без протокола и слэшей, кириллица — в punycode
    // (промт: «Кириллические домены — принимать, но хранить в punycode»). Приведение делает
    // приложение (url.domainToASCII), а CHECK ниже стоит вторым рубежом: домен в верхнем
    // регистре — это тот же домен, и разъехавшийся регистр обошёл бы UNIQUE.
    domain: { type: 'text', notNull: true, unique: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'verifying', 'active', 'failed', 'disabled')",
    },
    // Значение TXT-записи, которой владелец подтверждает, что домен его. Генерируется при
    // добавлении и НЕ меняется при перепроверках: иначе уже прописанная запись переставала бы
    // подходить каждый раз, когда владелец нажимает «Проверить сейчас».
    verification_token: { type: 'text', notNull: true },
    verified_at: { type: 'timestamptz' },
    last_check_at: { type: 'timestamptz' },
    // Текст последней неудачи — показывается владельцу как «что видно сейчас» (промт, раздел 4).
    last_error: { type: 'text' },
    is_primary: { type: 'boolean', notNull: true, default: true },
    // Промт: проверка «не чаще раза в 5 минут на домен, с экспоненциальным отступом при
    // неудачах и остановкой через 48 часов». Обе колонки — то, на чём это держится:
    // next_check_at говорит планировщику, кого вообще брать, check_attempts — насколько
    // отодвинуть следующую попытку. В перечне колонок промта их нет, но без них его же
    // требование невыразимо, а считать отступ «в голове» планировщика нельзя: он переживает
    // перезапуск процесса, а память — нет.
    check_attempts: { type: 'integer', notNull: true, default: 0 },
    next_check_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('venue_domains', 'venue_domains_domain_lowercase_check', {
    check: 'domain = lower(domain)',
  });
  // Форма домена: метки из букв/цифр/дефисов через точку, минимум две метки, без протокола,
  // слэшей, пробелов и порта. Полноценная валидация (длина меток, punycode) — в приложении;
  // здесь отсекается заведомый мусор, который не должен доехать до таблицы никаким путём.
  pgm.addConstraint('venue_domains', 'venue_domains_domain_format_check', {
    check: "domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'",
  });

  // Промт: «не больше 2 доменов на заведение (основной и алиас с www)».
  //
  // Уникальность пары (venue_id, is_primary) выражает ровно это: один основной плюс один
  // не-основной и есть максимум два. Индексом, а не проверкой в приложении и не триггером:
  // счёт строк перед вставкой — классическая гонка двух вкладок, а индекс не обойти ничем.
  // Заодно бесплатно получаем «основной ровно один», что при подсчёте пришлось бы проверять
  // отдельно.
  pgm.createIndex('venue_domains', ['venue_id', 'is_primary'], {
    name: 'venue_domains_venue_id_is_primary_key',
    unique: true,
  });

  // Выборка планировщика: «кого пора проверять». Статусы, которые он трогает, — pending
  // и verifying, поэтому индекс частичный: активные и отключённые домены в него не попадают
  // и не раздувают его.
  pgm.createIndex('venue_domains', ['next_check_at'], {
    name: 'venue_domains_pending_check_idx',
    where: "status IN ('pending', 'verifying')",
  });

  pgm.createIndex('venue_domains', ['venue_id']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venue_domains');
};
