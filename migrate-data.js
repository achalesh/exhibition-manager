const sqlite3 = require('sqlite3').verbose();

// --- CONFIGURATION ---
const OLD_DB_FILE = './exhibition.db'; // Your old database file
const NEW_DB_FILE = './production.db'; // Your new database file
// ---------------------

const tablesToMigrate = [
  'spaces',
  'clients',
  'bookings',
  'material_issues',
  'electric_items',
  'electric_bills',
  'exhibition_details',
];

console.log(`Starting data migration from ${OLD_DB_FILE} to ${NEW_DB_FILE}...`);

const db = new sqlite3.Database(NEW_DB_FILE, (err) => {
  if (err) {
    return console.error(`Error connecting to new database: ${err.message}`);
  }
  console.log('Connected to the new database.');
});

db.serialize(() => {
  // Attach the old database
  db.run(`ATTACH DATABASE '${OLD_DB_FILE}' AS old_db`, (err) => {
    if (err) return console.error(`Error attaching old database: ${err.message}`);
    console.log('Old database attached successfully.');
  });

  // Copy data for each table
  tablesToMigrate.forEach((table) => {
    let sql;
    if (table === 'bookings') {
      // Handle the bookings table specifically due to the new 'form_submitted' column
      // This maps the 16 columns from the old table to the corresponding columns in the new table, leaving 'form_submitted' as its default (0)
      sql = `INSERT INTO main.bookings (
        id, space_id, booking_date, exhibitor_name, facia_name, product_category, 
        contact_person, full_address, contact_number, secondary_number, id_proof, 
        rent_amount, discount, advance_amount, due_amount, client_id
      ) SELECT 
        id, space_id, booking_date, exhibitor_name, facia_name, product_category, 
        contact_person, full_address, contact_number, secondary_number, id_proof, 
        rent_amount, discount, advance_amount, due_amount, client_id 
      FROM old_db.bookings;`;
    } else if (table === 'exhibition_details') {
      // Use INSERT OR REPLACE to handle the unique constraint violation for the default row
      sql = `INSERT OR REPLACE INTO main.exhibition_details SELECT * FROM old_db.exhibition_details;`;
    } else {
      // Use the generic approach for all other tables
      sql = `INSERT INTO main.${table} SELECT * FROM old_db.${table};`;
    }

    db.run(sql, function (err) {
      if (err)
        console.error(`Error migrating data for table '${table}': ${err.message}`);
      else
        console.log(`✅ Migrated ${this.changes} rows for table '${table}'.`);
    });
  });

  // Close the database connection
  db.close((err) => {
    if (err) return console.error(err.message);
    console.log('\nData migration complete. Closed the database connection.');
  });
});