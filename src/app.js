require('dotenv').config();

const path = require('path');
const express = require('express');
const methodOverride = require('method-override');
const { pool } = require('./config/db');
const sessionMiddleware = require('./config/session');
const adminAuthRoutes = require('./routes/adminAuth');
const adminDashboardRoutes = require('./routes/adminDashboard');
const superadminRoutes = require('./routes/superadmin');
const adminCategoriesRoutes = require('./routes/adminCategories');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
app.use(sessionMiddleware);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('Health check: ошибка подключения к БД', err);
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.use('/admin', adminAuthRoutes);
app.use('/admin', adminDashboardRoutes);
app.use('/admin/categories', adminCategoriesRoutes);
app.use('/superadmin', superadminRoutes);

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errors/500');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

module.exports = app;
