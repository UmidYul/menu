// Группировка разрядов через неразрывный пробел ( ), чтобы число с суффиксом валюты
// никогда не переносилось на новую строку посередине.
function groupThousands(amount) {
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatPriceUZS(amount, lang) {
  const suffix = lang === 'uz' ? "so'm" : 'сум';
  return `${groupThousands(amount)} ${suffix}`;
}

module.exports = { formatPriceUZS, groupThousands };
