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