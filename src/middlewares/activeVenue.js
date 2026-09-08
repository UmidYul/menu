const adminVenueModel = require('../models/adminVenueModel');
const { ensureCsrfToken } = require('./csrf');

// Промт 3.6. Резолвер активного заведения — единственное место, где решается, к данным какого
// заведения имеет доступ текущий запрос.
//
// Ключевое решение: доступ проверяется В БАЗЕ НА КАЖДЫЙ ЗАПРОС, а не берётся из сессии.
// Сессия живёт неделю, а доступ может быть отозван минуту назад — и разница между этими двумя
// сроками и есть окно утечки данных между заведениями. Один индексированный запрос по admin_id
// заодно отдаёт список для переключателя, так что отдельной цены у этой проверки нет.
//
// req.session.admin.venueId СОХРАНЯЕТ ИМЯ, но меняет смысл: теперь это активное заведение.
// Так все существующие обращения к нему (а их около сотни) автоматически становятся фильтром
// по активному заведению — вместо правки каждого места по отдельности, где ошибка была бы
// незаметной и означала бы утечку.

async function resolveActiveVenue(req, res, next) {
  const admin = req.session && req.session.admin;
  // Не авторизован или суперадмин — заведения ни при чём: у суперадмина venue_id всегда NULL,
  // а его доступ проверяет requireRole(['superadmin']).
  if (!admin || admin.role === 'superadmin') return next();

  try {
    const venues = await adminVenueModel.listForAdmin(admin.id);

    // Edge case промта: «Администратор потерял доступ ко всем заведениям — при входе показать
    // понятную страницу, а не пустую админку и не ошибку».
    if (venues.length === 0) {
      admin.venueId = null;
      admin.venueSlug = null;
      admin.venueRole = null;
      admin.venues = [];
      res.locals.venues = [];
      res.locals.activeVenue = null;
      // Выход и смена языка должны работать и без заведений — иначе человек застрянет
      // на этой странице без возможности выйти.
      if (req.path === '/logout' || req.path === '/lang' || req.path === '/password') return next();
      // Токен выставляем сами: csrfProtection стоит ниже по цепочке и до этой страницы
      // не доходит, а форма выхода на ней должна работать.
      return res.status(403).render('errors/no-venues', {
        login: admin.login,
        csrfToken: ensureCsrfToken(req, res),
      });
    }

    // Edge case промта: «Заведение удалено, а activeVenueId в сессии остался — middleware
    // сбрасывает на первое доступное». Сюда же попадает отозванный доступ: если активного
    // заведения больше нет в списке, оно молча заменяется, а не приводит к 500 или к показу
    // чужих данных.
    let active = venues.find((venue) => venue.id === admin.venueId);
    if (!active) {
      active = venues[0];
    }

    admin.venueId = active.id;
    admin.venueSlug = active.slug;
    admin.venueRole = active.role;
    admin.venues = venues.map((venue) => ({
      id: venue.id, name: venue.name, slug: venue.slug, role: venue.role, status: venue.status,
    }));

    // Для шаблонов: переключатель в шапке и признак «сеть» для пункта «Все заведения».
    res.locals.venues = admin.venues;
    res.locals.activeVenue = { id: active.id, name: active.name, slug: active.slug, role: active.role, status: active.status };
    res.locals.venueRole = active.role;

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { resolveActiveVenue };
