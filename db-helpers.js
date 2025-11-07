//db-helpers.js

const sqlite3 = require('sqlite3').verbose();

// Create a single, shared database connection for the entire application.
const db = new sqlite3.Database('./production.db', (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

/**
 * Promisified version of db.all()
 * @param {string} sql The SQL query to execute.
 * @param {Array} params The parameters to bind to the query.
 * @returns {Promise<Array>} A promise that resolves with an array of rows.
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Promisified version of db.get()
 * @param {string} sql The SQL query to execute.
 * @param {Array} params The parameters to bind to the query.
 * @returns {Promise<Object>} A promise that resolves with a single row object.
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Promisified version of db.run() for INSERT, UPDATE, DELETE
 * @param {string} sql The SQL query to execute.
 * @param {Array} params The parameters to bind to the query.
 * @returns {Promise<{lastID: number, changes: number}>} A promise that resolves with an object containing lastID and changes.
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    // The `function` keyword is used here to get access to `this` from the callback.
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * Logs an administrative action to the database.
 * @param {number|null} userId - The ID of the user performing the action.
 * @param {string} username - The username of the user performing the action.
 * @param {string} action - A description of the action (e.g., 'create_user').
 * @param {string} [details] - Additional details about the action.
 * @param {number} event_session_id - The ID of the session in which the action occurred.
 */
async function logAction(userId, username, action, details = null, event_session_id = null) {
  const sql = `INSERT INTO logs (timestamp, user_id, username, action, details, event_session_id) VALUES (datetime('now', 'localtime'), ?, ?, ?, ?, ?)`;
  try {
    // userId can be null for events like failed logins where the user is not authenticated
    await run(sql, [userId, username, action, details, event_session_id]);
  } catch (err) {
    console.error('Failed to write to audit log:', err.message);
  }
}

/**
 * Executes a series of database operations as a transaction.
 * The callback can use the regular `run`, `get`, `all` helpers.
 * @param {Function} callback - An async function containing the database operations.
 */
async function transaction(callback) {
  if (typeof callback !== 'function') {
    throw new Error('Transaction callback must be a function.');
  }
  try {
    await run('BEGIN TRANSACTION');
    await callback({ run, get, all }); // Pass helpers to the callback
    await run('COMMIT');
  } catch (err) {
    console.error('Transaction failed, rolling back.', err);
    try {
      await run('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to rollback transaction:', rollbackErr);
    }
    // Re-throw the original error to be caught by the route handler
    throw err;
  }
}

module.exports = {
  db, // Export the raw db object for .run() and .serialize()
  all,
  get,
  run,
  logAction,
  transaction,
};