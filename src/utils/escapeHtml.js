// Общий HTML/XML-эскейпинг — те же 5 символов достаточно и для разметки писем, и для XML
// (sitemap, og:image SVG). Раньше было по копии в разных местах под именем escapeXml —
// собрано в одну, чтобы менять в одном месте.
function escapeHtml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

module.exports = { escapeHtml };
