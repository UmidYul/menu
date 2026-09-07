const ExcelJS = require('exceljs');

// Промт 3.2, раздел 4 "Экспорт и сводки". Один файл, несколько листов — та же форма данных,
// что уже посчитана для страницы аналитики (src/services/analyticsDashboard.js), так что экспорт
// не может разойтись с тем, что владелец только что видел на экране: он строится из ТОГО ЖЕ
// dashboard-объекта, а не отдельным повторным запросом к БД.
function addSheet(workbook, title, columns, rows) {
  const sheet = workbook.addWorksheet(title);
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));
  return sheet;
}

async function buildWorkbook(venue, dashboard, t) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'qr.menu';
  workbook.created = new Date();

  if (!dashboard.hasEnoughData) {
    addSheet(workbook, t('analytics.exportSheetOverview'), [
      { header: t('analytics.exportColMetric'), key: 'metric', width: 40 },
      { header: t('analytics.exportColValue'), key: 'value', width: 20 },
    ], [{ metric: t('analytics.notEnoughData'), value: dashboard.totalViews }]);
    return workbook.xlsx.writeBuffer();
  }

  addSheet(workbook, t('analytics.exportSheetOverview'), [
    { header: t('analytics.exportColMetric'), key: 'metric', width: 40 },
    { header: t('analytics.exportColValue'), key: 'value', width: 20 },
  ], [
    { metric: t('analytics.exportPeriodFrom'), value: dashboard.period.from.toISOString().slice(0, 10) },
    { metric: t('analytics.exportPeriodTo'), value: dashboard.period.to.toISOString().slice(0, 10) },
    { metric: t('analytics.totalViewsLabel'), value: dashboard.totalViews },
    { metric: t('analytics.trendLabel'), value: dashboard.trendPercent === null ? '—' : `${dashboard.trendPercent}%` },
  ]);

  addSheet(workbook, t('analytics.exportSheetDaily'), [
    { header: t('analytics.exportColDate'), key: 'date', width: 14 },
    { header: t('analytics.totalViewsLabel'), key: 'count', width: 14 },
  ], dashboard.dailyPageViews.days.map((d) => ({ date: d.date, count: d.count })));

  addSheet(workbook, t('analytics.topViewedHeading'), [
    { header: t('analytics.exportColItem'), key: 'name', width: 40 },
    { header: t('analytics.exportColViews'), key: 'views', width: 12 },
    { header: t('analytics.exportColAdds'), key: 'adds', width: 12 },
  ], dashboard.topViewed.map((r) => ({ name: r.name, views: r.views, adds: r.adds })));

  addSheet(workbook, t('analytics.topAddedHeading'), [
    { header: t('analytics.exportColItem'), key: 'name', width: 40 },
    { header: t('analytics.exportColAdds'), key: 'adds', width: 12 },
  ], dashboard.topAdded.map((r) => ({ name: r.name, adds: r.adds })));

  addSheet(workbook, t('analytics.searchTopHeading'), [
    { header: t('analytics.exportColQuery'), key: 'query', width: 40 },
    { header: t('analytics.exportColCount'), key: 'count', width: 12 },
  ], dashboard.searchTop.map((r) => ({ query: r.dimension, count: r.value })));

  addSheet(workbook, t('analytics.searchEmptyHeading'), [
    { header: t('analytics.exportColQuery'), key: 'query', width: 40 },
    { header: t('analytics.exportColCount'), key: 'count', width: 12 },
  ], dashboard.searchEmptyTop.map((r) => ({ query: r.dimension, count: r.value })));

  addSheet(workbook, t('analytics.langHeading'), [
    { header: t('analytics.exportColLabel'), key: 'label', width: 20 },
    { header: t('analytics.exportColCount'), key: 'count', width: 12 },
  ], dashboard.langBreakdown.rows.map((r) => ({ label: r.label, count: r.value })));

  addSheet(workbook, t('analytics.deviceHeading'), [
    { header: t('analytics.exportColLabel'), key: 'label', width: 20 },
    { header: t('analytics.exportColCount'), key: 'count', width: 12 },
  ], dashboard.deviceBreakdown.rows.map((r) => ({ label: r.label, count: r.value })));

  addSheet(workbook, t('analytics.sourceHeading'), [
    { header: t('analytics.exportColLabel'), key: 'label', width: 20 },
    { header: t('analytics.exportColCount'), key: 'count', width: 12 },
  ], dashboard.sourceBreakdown.rows.map((r) => ({ label: r.label, count: r.value })));

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };
