//setup-db.js
// This script sets up the SQLite database with necessary tables and sample data.
// Run this script once to initialize the database before starting the application.

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('./production.db');

/**
 * Promisified version of db.run() for the setup script.
 * @param {string} sql The SQL query to execute.
 * @param {Array} params The parameters to bind to the query.
 * @returns {Promise<{lastID: number, changes: number}>}
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * Promisified version of db.all() for the setup script.
 * @param {string} sql The SQL query to execute.
 * @param {Array} params The parameters to bind to the query.
 * @returns {Promise<Array>}
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
 * Promisified version of db.get() for the setup script.
 * @param {string} sql The SQL query to execute.
 * @param {Array} params The parameters to bind to the query.
 * @returns {Promise<Object>}
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function setupDatabase() {
  console.log('Starting database setup...');

  // Wrap everything in a serialize to ensure order for this block
  db.serialize(async () => {
    try {
      // --- Schema Migration First ---
      console.log('Running schema migrations...');
      await run(`ALTER TABLE exhibition_details ADD COLUMN name TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE exhibition_details ADD COLUMN place TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE material_issues ADD COLUMN sl_no TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE electric_bills ADD COLUMN sl_no TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE booking_staff ADD COLUMN role TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE booking_staff ADD COLUMN secondary_phone TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE payments ADD COLUMN payment_mode TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE payments ADD COLUMN cash_paid REAL DEFAULT 0`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE payments ADD COLUMN upi_paid REAL DEFAULT 0`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE exhibition_details ADD COLUMN logo_path TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE booking_edits ADD COLUMN rejection_reason TEXT`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      await run(`ALTER TABLE booking_edits ADD COLUMN user_notified INTEGER DEFAULT 0`).catch(e => { if (!e.message.includes('duplicate')) throw e; });
      // Add the missing tables if they don't exist

      await run(`CREATE TABLE IF NOT EXISTS payment_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        proposed_data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        request_date TEXT NOT NULL,
        rejection_reason TEXT,
        user_notified INTEGER DEFAULT 0,
        FOREIGN KEY (payment_id) REFERENCES payments(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
      console.log('Migrations checked.');

      // --- Table Creation ---
      console.log('Creating tables...');
      await run(`DROP TABLE IF EXISTS stalls`);
      await run(`DROP TABLE IF EXISTS pavilions`);

      await run(`CREATE TABLE IF NOT EXISTS spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    size TEXT,
    rent_amount REAL,
    facilities TEXT,
    location TEXT,
    status TEXT DEFAULT 'Available'
  )`);

      await run(`DELETE FROM spaces WHERE type = 'SpecialZone'`);

      await run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_person TEXT,
    contact_number TEXT,
    full_address TEXT
  )`);

      await run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    exhibitor_name TEXT,
    facia_name TEXT,
    product_category TEXT,
    contact_person TEXT,
    full_address TEXT,
    contact_number TEXT,
    secondary_number TEXT,
    id_proof TEXT,
    rent_amount REAL,
    discount REAL,
    advance_amount REAL,
    due_amount REAL,
    form_submitted INTEGER DEFAULT 0,
    client_id INTEGER,
    FOREIGN KEY (space_id) REFERENCES spaces(id),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);

      await run(`CREATE TABLE IF NOT EXISTS material_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sl_no TEXT,
    client_id INTEGER,
    stall_number TEXT,
    camp TEXT,
    plywood_free INTEGER,
    table_free INTEGER,
    chair_free INTEGER,
    rod_free INTEGER,
    plywood_paid INTEGER,
    table_paid INTEGER,
    chair_paid INTEGER,
    table_numbers TEXT,
    chair_numbers TEXT,
    total_payable INTEGER,
    advance_paid INTEGER,
    balance_due INTEGER,
    notes TEXT,
    issue_date TEXT DEFAULT CURRENT_DATE,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);

      await run(`CREATE TABLE IF NOT EXISTS material_defaults (
    id INTEGER PRIMARY KEY,
    free_tables INTEGER DEFAULT 1,
    free_chairs INTEGER DEFAULT 2
  )`);
      await run(`INSERT OR IGNORE INTO material_defaults (id, free_tables, free_chairs) VALUES (1, 1, 2)`);

      await run(`CREATE TABLE IF NOT EXISTS electric_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    service_charge REAL DEFAULT 0,
    fitting_charge REAL DEFAULT 0
  )`);

      await run(`CREATE TABLE IF NOT EXISTS electric_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sl_no TEXT,
    booking_id INTEGER,
    bill_date TEXT,
    items_json TEXT,
    total_amount REAL,
    remarks TEXT,
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
  )`);

      await run(`CREATE TABLE IF NOT EXISTS shed_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    bill_date TEXT,
    description TEXT,
    amount REAL,
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
  )`);

      await run(`CREATE TABLE IF NOT EXISTS sheds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    size TEXT,
    rent REAL,
    status TEXT DEFAULT 'Available'
  )`);

      await run(`CREATE TABLE IF NOT EXISTS shed_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    shed_id INTEGER NOT NULL,
    allocation_date TEXT,
    FOREIGN KEY (booking_id) REFERENCES bookings(id),
    FOREIGN KEY (shed_id) REFERENCES sheds(id)
  )`);

      await run(`CREATE TABLE IF NOT EXISTS booking_staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dob TEXT,
    address TEXT,
    phone TEXT NOT NULL,
    secondary_phone TEXT,
    aadhaar TEXT UNIQUE,
    photo_path TEXT,
    role TEXT
  )`);

      await run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    receipt_number TEXT,
    payment_date TEXT,
    rent_paid REAL DEFAULT 0,
    electric_paid REAL DEFAULT 0,
    material_paid REAL DEFAULT 0,
    shed_paid REAL DEFAULT 0,
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
  )`);

      await run(`CREATE TABLE IF NOT EXISTS booking_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        proposed_data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
        request_date TEXT NOT NULL,
        rejection_reason TEXT,
        user_notified INTEGER DEFAULT 0,
        FOREIGN KEY (booking_id) REFERENCES bookings(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      await run(`CREATE TABLE IF NOT EXISTS payment_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        proposed_data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        request_date TEXT NOT NULL,
        rejection_reason TEXT,
        user_notified INTEGER DEFAULT 0,
        FOREIGN KEY (payment_id) REFERENCES payments(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      await run(`CREATE TABLE IF NOT EXISTS material_issue_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_issue_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        proposed_data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        request_date TEXT NOT NULL,
        rejection_reason TEXT,
        user_notified INTEGER DEFAULT 0,
        FOREIGN KEY (material_issue_id) REFERENCES material_issues(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      await run(`CREATE TABLE IF NOT EXISTS electric_bill_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        electric_bill_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        proposed_data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        request_date TEXT NOT NULL,
        rejection_reason TEXT,
        user_notified INTEGER DEFAULT 0,
        FOREIGN KEY (electric_bill_id) REFERENCES electric_bills(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      await run(`CREATE TABLE IF NOT EXISTS exhibition_details (
    id INTEGER PRIMARY KEY,
    name TEXT,
    address TEXT,
    location TEXT,
    place TEXT,
    logo_path TEXT
  )`);
      console.log('Tables created.');

      // --- Data Seeding ---
      console.log('Seeding data...');
      await run(`INSERT OR IGNORE INTO sheds (name, size, rent) VALUES ('Shed A-1', '10x10', 5000), ('Shed A-2', '10x10', 5000), ('Shed B-1', '15x10', 7500)`);
      await run(`INSERT OR IGNORE INTO exhibition_details (id, name, address, location, place) VALUES (1, 'National Consumer Fair', 'Akshaya Nagar', 'Bengaluru', 'Main Ground')`);

      // --- User Creation ---
      await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user'
  )`);

      const saltRounds = 10;
      const defaultPassword = 'admin';
      const hash = await bcrypt.hash(defaultPassword, saltRounds);
      await run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [hash]);
      console.log('Default user created.');

      // --- Drop and Recreate Logs table for schema consistency ---
      await run(`DROP TABLE IF EXISTS logs`);

      // --- Audit Log Table ---
      await run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER,
        username TEXT,
        action TEXT,
        details TEXT
      )`);

      // --- Accounting Transactions Table ---
      await run(`CREATE TABLE IF NOT EXISTS accounting_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER UNIQUE,
        transaction_type TEXT NOT NULL CHECK(transaction_type IN ('income', 'expenditure')),
        category TEXT NOT NULL,
        description TEXT,
        amount REAL NOT NULL,
        transaction_date DATE NOT NULL,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
      )`);
      await run(`ALTER TABLE accounting_transactions ADD COLUMN payment_id INTEGER`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });
      await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_payment_id ON accounting_transactions (payment_id)`);
      console.log('Accounting table created.');

      // --- One-time Migration: Move existing payments to accounting ---
      console.log('Migrating existing payments to accounting ledger...');
      try {
        // Clear old payment-related income to avoid duplicates on re-run
        await run(`DELETE FROM accounting_transactions WHERE payment_id IS NOT NULL OR category LIKE '% Payment'`);

        const payments = await all(`
          SELECT p.*, b.exhibitor_name 
          FROM payments p 
          JOIN bookings b ON p.booking_id = b.id
        `);

        const adminUser = await get(`SELECT id FROM users WHERE username = 'admin'`);
        const adminUserId = adminUser ? adminUser.id : null;

        for (const p of payments) {
          let amount = 0;
          let payment_type = '';

          if (p.rent_paid > 0) { amount = p.rent_paid; payment_type = 'rent'; }
          else if (p.electric_paid > 0) { amount = p.electric_paid; payment_type = 'electric'; }
          else if (p.material_paid > 0) { amount = p.material_paid; payment_type = 'material'; }
          else if (p.shed_paid > 0) { amount = p.shed_paid; payment_type = 'shed'; }

          if (amount > 0) {
            const categories = {
              rent: 'Rent Payment',
              electric: 'Electric Bill Payment',
              material: 'Material Issue Payment',
              shed: 'Shed Rent Payment'
            };
            const accountingCategory = categories[payment_type] || 'Booking Payment';
            const accountingDescription = `Payment from ${p.exhibitor_name}`;
            const accountingSql = `INSERT INTO accounting_transactions (payment_id, transaction_type, category, description, amount, transaction_date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`;
            await run(accountingSql, [p.id, 'income', accountingCategory, accountingDescription, amount, p.payment_date, adminUserId]);
          }
        }
        console.log(`Migrated ${payments.length} payments to accounting.`);
      } catch (err) { console.error('Could not migrate payments:', err.message); }

      // --- Electric Items Population ---
      console.log('Populating electric_items...');
      await run('DELETE FROM electric_items');
      const items = [
        ['LED / CFL-Minimum (up to 40 Watts)', 800, 0], ['LED / CFL-40 -100 watts', 1300, 0],
        ['Tube 40 watts', 750, 250], ['Tube 40 watts full night period', 2200, 0],
        ['Bulbs 25–100 watts', 1050, 250], ['Bulbs 200 watts', 2100, 300],
        ['Flood Light 500 watts', 4300, 0], ['5 AMP Plug Point', 3000, 0],
        ['Motor 1 HP', 6000, 0], ['Fan (Connection Only)', 2300, 0],
        ['Series 1 (24-60)', 4200, 0], ['Series 2 (60-100)', 5500, 0],
        ['Mercury 200 watts', 2300, 0]
      ];
      const stmt = db.prepare('INSERT INTO electric_items (name, service_charge, fitting_charge) VALUES (?, ?, ?)');
      for (const item of items) {
        await new Promise((resolve, reject) => stmt.run(item, err => err ? reject(err) : resolve()));
      }
      await new Promise((resolve, reject) => stmt.finalize(err => err ? reject(err) : resolve()));
      console.log('Electric items populated.');

      // --- Event Session Table ---
      console.log('Creating event_sessions table...');
      await run(`CREATE TABLE IF NOT EXISTS event_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        location TEXT,
        start_date DATE,
        end_date DATE,
        is_active INTEGER DEFAULT 0,
        address TEXT,
        place TEXT,
        logo_path TEXT
      )`);
      await run(`ALTER TABLE event_sessions ADD COLUMN address TEXT`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });
      await run(`ALTER TABLE event_sessions ADD COLUMN place TEXT`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });
      await run(`ALTER TABLE event_sessions ADD COLUMN logo_path TEXT`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });

      // Create a default session if none exists and make it active
      const existingSession = await get('SELECT id FROM event_sessions LIMIT 1');
      if (!existingSession) {
        // On first run, migrate data from the old exhibition_details table
        const oldDetails = await get('SELECT * FROM exhibition_details WHERE id = 1');
        await run(
          `INSERT INTO event_sessions (name, location, address, place, logo_path, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
          [oldDetails?.name || 'Initial Session', oldDetails?.location || 'Default Location', oldDetails?.address, oldDetails?.place, oldDetails?.logo_path, 1]
        );
        console.log('Migrated old exhibition_details to new event_sessions table.');
      }

      // --- Ticketing System Tables ---
      console.log('Creating ticketing system tables...');
      // Table for the two fixed base rates
      await run(`CREATE TABLE IF NOT EXISTS base_rates (
        id INTEGER PRIMARY KEY,
        rate REAL NOT NULL UNIQUE
      )`);
      await run(`INSERT OR IGNORE INTO base_rates (id, rate) VALUES (1, 100)`);
      await run(`INSERT OR IGNORE INTO base_rates (id, rate) VALUES (2, 50)`);

      // Table to store user-defined rides, linked to a base rate
      await run(`CREATE TABLE IF NOT EXISTS ticket_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        base_rate_id INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (base_rate_id) REFERENCES base_rates(id)
      )`);
      // Migration for old 'rate' column in ticket_rates
      try {
        await run(`ALTER TABLE ticket_rates ADD COLUMN base_rate_id INTEGER`);
        await run(`UPDATE ticket_rates SET base_rate_id = CASE WHEN rate = 100 THEN 1 WHEN rate = 50 THEN 2 ELSE NULL END`);
      } catch (e) {
        if (!e.message.includes('duplicate')) throw e;
      }

      // Table to track physical ticket stock
      await run(`CREATE TABLE IF NOT EXISTS ticket_stock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        base_rate_id INTEGER,
        start_number INTEGER NOT NULL,
        end_number INTEGER NOT NULL,
        color TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'Available',
        FOREIGN KEY (base_rate_id) REFERENCES base_rates(id)
      )`);
      // Migration for ticket_stock table to handle schema change from rate_id to base_rate_id
      try {
        await run('ALTER TABLE ticket_stock RENAME TO ticket_stock_old');
        await run(`CREATE TABLE ticket_stock (id INTEGER PRIMARY KEY AUTOINCREMENT, base_rate_id INTEGER, start_number INTEGER NOT NULL, end_number INTEGER NOT NULL, color TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'Available', FOREIGN KEY (base_rate_id) REFERENCES base_rates(id))`);
        await run(`INSERT INTO ticket_stock (id, base_rate_id, start_number, end_number, color, created_at, status) SELECT id, rate_id, start_number, end_number, color, created_at, status FROM ticket_stock_old`);
        await run('DROP TABLE ticket_stock_old');
        console.log('ticket_stock table migrated successfully.');
      } catch (e) {
        if (!e.message.includes('no such table: ticket_stock_old')) console.log('Skipping ticket_stock migration as it seems up-to-date.');
      }

      // Table to log daily sales
      await run(`CREATE TABLE IF NOT EXISTS ticket_sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_date DATE NOT NULL,
        details TEXT NOT NULL, -- JSON object of { rate_id: count, ... }
        total_revenue REAL NOT NULL,
        user_id INTEGER NOT NULL
      )`);
      console.log('Ticketing tables created.');

      // Table for detailed ticket distribution and settlement
      await run(`CREATE TABLE IF NOT EXISTS ticket_distributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        distribution_date DATE NOT NULL,
        staff_id INTEGER NOT NULL,
        stock_id INTEGER,
        rate_id INTEGER NOT NULL,
        distributed_start_number INTEGER NOT NULL,
        distributed_end_number INTEGER NOT NULL,
        returned_start_number INTEGER,
        returned_end_number INTEGER,
        settlement_date DATE,
        tickets_sold INTEGER,
        calculated_revenue REAL,
        upi_amount REAL,
        cash_amount REAL,
        status TEXT DEFAULT 'Distributed',
        settled_by_user_id INTEGER,
        FOREIGN KEY (staff_id) REFERENCES booking_staff(id),
        FOREIGN KEY (rate_id) REFERENCES ticket_rates(id),
        FOREIGN KEY (stock_id) REFERENCES ticket_stock(id)
      )`);
      await run(`ALTER TABLE ticket_distributions ADD COLUMN stock_id INTEGER`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });
      await run(`ALTER TABLE ticket_distributions ADD COLUMN upi_amount REAL`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });
      await run(`ALTER TABLE ticket_distributions ADD COLUMN cash_amount REAL`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });

      // --- Add event_session_id to all operational tables ---
      console.log('Adding event_session_id to operational tables...');
      const tablesToUpdate = [
        'bookings', 'payments', 'material_issues', 'electric_bills', 'shed_bills', 'booking_staff',
        'shed_allocations', 'accounting_transactions', 'ticket_stock', 'ticket_distributions',
        'logs'
      ];
      for (const table of tablesToUpdate) {
        await run(`ALTER TABLE ${table} ADD COLUMN event_session_id INTEGER REFERENCES event_sessions(id)`).catch(e => { if (!e.message.includes('duplicate column name')) throw e; });
      }

      // --- One-time data migration to the default session ---
      console.log('Migrating existing data to the default event session...');
      const defaultSession = await get('SELECT id FROM event_sessions WHERE is_active = 1');
      if (defaultSession) {
        for (const table of tablesToUpdate) {
          await run(`UPDATE ${table} SET event_session_id = ? WHERE event_session_id IS NULL`, [defaultSession.id]);
        }
      }

      // --- App Meta Table for settings ---
      await run(`CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);
      await run(`INSERT OR IGNORE INTO app_meta (key, value) VALUES ('last_backup_date', '2000-01-01')`);

    } catch (err) {
      console.error('Error during database setup:', err.message);
    } finally {
      closeDb();
    }
  });
}

function closeDb() {
  db.close((err) => {
    if (err) {
      return console.error('Error closing database:', err.message);
    }
    console.log('✅ Database setup complete. Material form and core tables are ready.');
  });
}

// Run the setup
setupDatabase();