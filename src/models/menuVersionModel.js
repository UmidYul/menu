const { pool } = require('../config/db');

// menu_version сам по себе нигде не читается — это просто "что-то изменилось" счётчик,
// нужный только затем, чтобы UPDATE был атомарным поводом для pgNotify.publishMenuChange.
async function bump(venueId) {
  const result = await pool.query(
    'UPDATE venues SET menu_version = menu_version + 1 WHERE id = $1 RETURNING menu_version',
    [venueId]
  );
  return result.rows[0] ? result.rows[0].menu_version : null;
}

module.exports = { bump };
