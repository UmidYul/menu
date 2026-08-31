const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { t } = require('../../src/i18n');
const leadModel = require('../../src/models/leadModel');
const { normalizeUzPhone } = require('../../src/utils/phone');
const {
  contactNameField, venueNameField, cityField, VENUE_TYPES, commentField,
} = require('../../src/validators/leadValidators');
const { notifyOwnersNewLead } = require('../lib/leadNotify');

const SCENE_ID = 'apply-lead';

// Порядок полей визарда. extract(ctx) достаёт сырое значение из обновления (текст, нажатая
// кнопка или контакт — по полю разное), validate(raw) — как в веб-форме, где применимо.
const FIELDS = [
  {
    key: 'venue_name',
    prompt: (ctx) => t('bot.apply.venueNamePrompt', ctx.state.lang),
    extract: (ctx) => (ctx.message && ctx.message.text) || null,
    validate: (raw) => venueNameField.safeParse(raw),
    errorKey: 'apply.errorVenueNameLength',
  },
  {
    key: 'city',
    prompt: (ctx) => t('bot.apply.cityPrompt', ctx.state.lang),
    extract: (ctx) => (ctx.message && ctx.message.text) || null,
    validate: (raw) => cityField.safeParse(raw),
    errorKey: 'apply.errorTooLong',
  },
  {
    key: 'venue_type',
    prompt: (ctx) => t('bot.apply.venueTypePrompt', ctx.state.lang),
    keyboard: (ctx) => venueTypeKeyboard(ctx.state.lang),
    extract: (ctx) => {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (!data || !data.startsWith('lead:type:')) return null;
      return data.slice('lead:type:'.length);
    },
    validate: (raw) => (VENUE_TYPES.includes(raw) ? { success: true, data: raw } : { success: false, error: { issues: [{ message: 'apply.errorVenueTypeRequired' }] } }),
    errorKey: 'apply.errorVenueTypeRequired',
    isCallback: true,
  },
  {
    key: 'contact_name',
    prompt: (ctx) => t('bot.apply.contactNamePrompt', ctx.state.lang),
    extract: (ctx) => (ctx.message && ctx.message.text) || null,
    validate: (raw) => contactNameField.safeParse(raw),
    errorKey: 'apply.errorContactNameLength',
  },
  {
    key: 'phone',
    prompt: (ctx) => t('bot.apply.phonePrompt', ctx.state.lang),
    keyboard: (ctx) => phoneKeyboard(ctx.state.lang),
    extract: (ctx) => {
      if (ctx.message && ctx.message.contact) return ctx.message.contact.phone_number;
      return (ctx.message && ctx.message.text) || null;
    },
    validate: (raw) => {
      const normalized = normalizeUzPhone(raw);
      return normalized ? { success: true, data: normalized } : { success: false, error: { issues: [{ message: 'apply.errorPhoneInvalid' }] } };
    },
    errorKey: 'apply.errorPhoneInvalid',
    removeKeyboardAfter: true,
  },
  {
    key: 'comment',
    prompt: (ctx) => t('bot.apply.commentPrompt', ctx.state.lang),
    keyboard: (ctx) => skipKeyboard(ctx.state.lang),
    extract: (ctx) => {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (data === 'lead:skip') return '';
      return (ctx.message && ctx.message.text) || null;
    },
    validate: (raw) => commentField.safeParse(raw),
    errorKey: 'apply.errorTooLong',
  },
];

function navRow(lang, { back = true } = {}) {
  const row = [];
  if (back) row.push(Markup.button.callback(t('bot.apply.btnBack', lang), 'lead:back'));
  row.push(Markup.button.callback(t('bot.apply.btnCancel', lang), 'lead:cancel'));
  return row;
}

function venueTypeKeyboard(lang) {
  const rows = VENUE_TYPES.map((type) => [Markup.button.callback(t(`bot.apply.venueType.${type}`, lang), `lead:type:${type}`)]);
  rows.push(navRow(lang));
  return Markup.inlineKeyboard(rows);
}

function phoneKeyboard(lang) {
  return Markup.keyboard([[Markup.button.contactRequest(t('bot.apply.btnSharePhone', lang))]])
    .resize()
    .oneTime();
}

function skipKeyboard(lang) {
  return Markup.inlineKeyboard([[Markup.button.callback(t('bot.apply.btnSkip', lang), 'lead:skip')], navRow(lang)]);
}

function textNavKeyboard(lang) {
  return Markup.inlineKeyboard([navRow(lang)]);
}

async function sendFieldPrompt(ctx, index) {
  const field = FIELDS[index];
  const lang = ctx.state.lang;
  const keyboard = field.keyboard ? field.keyboard(ctx) : textNavKeyboard(lang);
  await ctx.reply(field.prompt(ctx), keyboard);
}

function summaryText(ctx) {
  const lang = ctx.state.lang;
  const s = ctx.wizard.state;
  return t('bot.apply.summary', lang, {
    venueName: s.venue_name,
    city: s.city || t('bot.apply.summaryEmpty', lang),
    venueType: t(`bot.apply.venueType.${s.venue_type}`, lang),
    contactName: s.contact_name,
    phone: s.phone,
    comment: s.comment || t('bot.apply.summaryEmpty', lang),
  });
}

function confirmKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t('bot.apply.btnSubmit', lang), 'lead:submit')],
    [Markup.button.callback(t('bot.apply.btnRestart', lang), 'lead:restart')],
    [Markup.button.callback(t('bot.apply.btnCancel', lang), 'lead:cancel')],
  ]);
}

async function leaveWithMessage(ctx, key) {
  await ctx.reply(t(key, ctx.state.lang), Markup.removeKeyboard());
  return ctx.scene.leave();
}

// Существующая активная заявка/заведение на этот telegram_id — сценарий вообще не заводим,
// просто показываем статус (edge case из промта).
async function checkExistingBeforeEnter(ctx) {
  const existing = await leadModel.findActiveByTelegramId(ctx.from.id);
  if (!existing) return false;
  const statusKey = `bot.apply.existingStatus.${existing.status}`;
  await ctx.reply(t('bot.apply.alreadyHaveLead', ctx.state.lang, { status: t(statusKey, ctx.state.lang) }));
  return true;
}

// Веб-заявка с тем же телефоном, ещё не привязанная к Telegram — предлагаем привязать вместо
// повторной заявки (edge case "сайт, потом бот").
async function offerAttachIfWebLeadExists(ctx, phone) {
  const webLead = await leadModel.findAttachableWebLeadByPhone(phone);
  if (!webLead) return false;
  ctx.wizard.state.attachLeadId = webLead.id;
  await ctx.reply(
    t('bot.apply.attachOffer', ctx.state.lang, { venueName: webLead.venue_name }),
    Markup.inlineKeyboard([
      [Markup.button.callback(t('bot.apply.btnAttachYes', ctx.state.lang), 'lead:attach:yes')],
      [Markup.button.callback(t('bot.apply.btnAttachNo', ctx.state.lang), 'lead:attach:no')],
    ])
  );
  return true;
}

const stepEnter = async (ctx) => {
  if (await checkExistingBeforeEnter(ctx)) return ctx.scene.leave();
  await sendFieldPrompt(ctx, 0);
  return ctx.wizard.next();
};

// steps[1..FIELDS.length] читают ответ на FIELDS[cursor-1] и просят следующее поле.
const fieldSteps = FIELDS.map((field, index) => async (ctx) => {
  if (ctx.wizard.state.awaitingAttach) return; // ждём кнопку lead:attach:*, текст игнорируем

  if (field.isCallback === true && !ctx.callbackQuery) {
    await ctx.reply(t('bot.apply.useButtonsHint', ctx.state.lang));
    return;
  }

  const raw = field.extract(ctx);
  if (raw === null) {
    await ctx.reply(t('bot.apply.useButtonsHint', ctx.state.lang));
    return;
  }
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const parsed = field.validate(raw);
  if (!parsed.success) {
    await ctx.reply(t(field.errorKey, ctx.state.lang));
    return;
  }

  ctx.wizard.state[field.key] = parsed.data;

  if (field.removeKeyboardAfter) {
    await ctx.reply(t('bot.apply.phoneSaved', ctx.state.lang, { phone: parsed.data }), Markup.removeKeyboard());
  }

  // После телефона — проверка на привязку к существующей веб-заявке, до перехода дальше.
  if (field.key === 'phone') {
    const offered = await offerAttachIfWebLeadExists(ctx, parsed.data);
    if (offered) {
      ctx.wizard.state.awaitingAttach = true;
      return;
    }
  }

  const nextIndex = index + 1;
  if (nextIndex < FIELDS.length) {
    await sendFieldPrompt(ctx, nextIndex);
    return ctx.wizard.next();
  }

  await ctx.reply(summaryText(ctx), confirmKeyboard(ctx.state.lang));
  return ctx.wizard.next();
});

const stepConfirm = async (ctx) => {
  if (!ctx.callbackQuery) {
    await ctx.reply(t('bot.apply.useButtonsHint', ctx.state.lang));
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery().catch(() => {});

  if (data === 'lead:restart') {
    ctx.wizard.state = {};
    await sendFieldPrompt(ctx, 0);
    ctx.wizard.selectStep(1);
    return;
  }

  if (data !== 'lead:submit') return;

  const s = ctx.wizard.state;
  const lead = await leadModel.create(null, {
    source: 'bot',
    telegramId: ctx.from.id,
    telegramUsername: ctx.from.username,
    contactName: s.contact_name,
    phone: s.phone,
    venueName: s.venue_name,
    city: s.city,
    venueType: s.venue_type,
    comment: s.comment,
  });

  await ctx.reply(t('bot.apply.submitted', ctx.state.lang));
  await notifyOwnersNewLead(ctx.telegram, lead).catch((err) => console.error('bot: не удалось уведомить владельца о заявке', err));
  return ctx.scene.leave();
};

// Сцена целиком: enter + по одному шагу на поле + подтверждение. Кнопки "Назад"/"Отмена"
// работают на любом шаге через scene.action — не завязаны на конкретный cursor.
const scene = new Scenes.WizardScene(SCENE_ID, stepEnter, ...fieldSteps, stepConfirm);

scene.action('lead:cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return leaveWithMessage(ctx, 'bot.apply.cancelled');
});

scene.action('lead:back', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const cursor = ctx.wizard.cursor;
  // На первом поле "назад" вести некуда — выходим, как по "Отмена".
  if (cursor <= 1) return leaveWithMessage(ctx, 'bot.apply.cancelled');
  const targetFieldIndex = cursor - 2; // поле, которое нужно переспросить
  delete ctx.wizard.state[FIELDS[targetFieldIndex].key];
  await sendFieldPrompt(ctx, targetFieldIndex);
  ctx.wizard.selectStep(targetFieldIndex + 1);
});

scene.action(/^lead:attach:(yes|no)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const answer = ctx.match[1];
  ctx.wizard.state.awaitingAttach = false;

  if (answer === 'yes') {
    await leadModel.attachTelegram(ctx.wizard.state.attachLeadId, ctx.from.id, ctx.from.username);
    await ctx.reply(t('bot.apply.attached', ctx.state.lang));
    return ctx.scene.leave();
  }

  const commentIndex = FIELDS.findIndex((f) => f.key === 'comment');
  await sendFieldPrompt(ctx, commentIndex);
  ctx.wizard.selectStep(commentIndex + 1);
});

module.exports = { scene, SCENE_ID };
