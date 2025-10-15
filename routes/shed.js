const express = require('express');
const router = express.Router();
const { db, all, get, run } = require('../db-helpers');

// GET: Show page to manage all sheds (add, edit, delete)
router.get('/manage', async (req, res) => {
  try {
    const sheds = await all('SELECT * FROM sheds ORDER BY name');
    res.render('manageSheds', {
      title: 'Manage Sheds',
      sheds: sheds || [],
      report_url: '/shed/manage' // For active nav link
    });
  } catch (err) {
    console.error('Error loading manage sheds page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Add a new shed
router.post('/add', async (req, res) => {
  const { name, size, rent } = req.body;
  if (!name || !rent) {
    return res.status(400).send('Shed Name and Rent are required.');
  }
  try {
    await run('INSERT INTO sheds (name, size, rent) VALUES (?, ?, ?)', [name, size, rent]);
    res.redirect('/shed/manage');
  } catch (err) {
    console.error('Error adding new shed:', err.message);
    res.status(500).send('Failed to add shed. Name might already exist.');
  }
});

// GET: Show the form to allocate a shed
router.get('/allocate', async (req, res) => {
  try {
    // Fetch all current bookings and all available sheds in parallel
    const [bookings, sheds] = await Promise.all([
      all(`SELECT b.id, b.exhibitor_name, s.name as space_name 
           FROM bookings b JOIN spaces s ON b.space_id = s.id 
           ORDER BY b.exhibitor_name`),
      all("SELECT * FROM sheds WHERE status = 'Available' ORDER BY name")
    ]);

    res.render('allocateShed', {
      title: 'Allocate Shed',
      bookings: bookings || [],
      sheds: sheds || []
    });
  } catch (err) {
    console.error('Error loading shed allocation page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Process the shed allocation
router.post('/allocate', async (req, res) => {
  const { booking_id, shed_id } = req.body;

  if (!booking_id || !shed_id) {
    return res.status(400).send('Exhibitor and Shed must be selected.');
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      const shed = await get('SELECT rent FROM sheds WHERE id = ?', [shed_id]);
      if (!shed) throw new Error('Selected shed not found.');

      // 1. Create the allocation record
      await run('INSERT INTO shed_allocations (booking_id, shed_id, allocation_date) VALUES (?, ?, date("now"))', [booking_id, shed_id]);

      // 2. Update the shed's status to 'Allocated'
      await run("UPDATE sheds SET status = 'Allocated' WHERE id = ?", [shed_id]);

      // 3. Add the shed rent to the booking's due amount
      await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [shed.rent, booking_id]);

      db.run('COMMIT');
      res.redirect('/booking/list');
    } catch (err) {
      db.run('ROLLBACK');
      console.error('Error during shed allocation:', err.message);
      res.status(500).send('Failed to allocate shed.');
    }
  });
});

// POST: Edit an existing shed
router.post('/edit/:id', async (req, res) => {
  const { name, size, rent } = req.body;
  const { id } = req.params;
  if (!name || !rent) {
    return res.status(400).send('Shed Name and Rent are required.');
  }
  try {
    await run('UPDATE sheds SET name = ?, size = ?, rent = ? WHERE id = ?', [name, size, rent, id]);
    res.redirect('/shed/manage');
  } catch (err) {
    console.error(`Error updating shed #${id}:`, err.message);
    res.status(500).send('Failed to update shed.');
  }
});

// POST: Delete a shed
router.post('/delete/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // First, check if the shed is currently allocated.
    const allocation = await get('SELECT id FROM shed_allocations WHERE shed_id = ?', [id]);
    if (allocation) {
      return res.status(400).send('Cannot delete a shed that is currently allocated. Please de-allocate it first.');
    }
    // If not allocated, proceed with deletion.
    await run('DELETE FROM sheds WHERE id = ?', [id]);
    res.redirect('/shed/manage');
  } catch (err) {
    console.error(`Error deleting shed #${id}:`, err.message);
    res.status(500).send('Failed to delete shed.');
  }
});

// POST: Delete a shed allocation
router.post('/allocation/delete/:id', async (req, res) => {
  const allocationId = req.params.id;

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // 1. Get the allocation details to find the shed and booking
      const allocation = await get('SELECT * FROM shed_allocations WHERE id = ?', [allocationId]);
      if (!allocation) throw new Error('Shed allocation not found.');

      // 2. Get the shed's rent to subtract from the due amount
      const shed = await get('SELECT rent FROM sheds WHERE id = ?', [allocation.shed_id]);
      if (!shed) throw new Error('Associated shed not found.');

      // 3. Update the booking's due amount
      await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [shed.rent, allocation.booking_id]);

      // 4. Update the shed's status back to 'Available'
      await run("UPDATE sheds SET status = 'Available' WHERE id = ?", [allocation.shed_id]);

      // 5. Delete the allocation record
      await run('DELETE FROM shed_allocations WHERE id = ?', [allocationId]);

      db.run('COMMIT');
      res.redirect(`/booking/details-full/${allocation.booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error deleting shed allocation #${allocationId}:`, err.message);
      res.status(500).send('Failed to delete shed allocation.');
    }
  });
});

// GET: Show form to add a miscellaneous shed bill
router.get('/bill', async (req, res) => {
  try {
    const bookings = await all(`
      SELECT b.id, b.exhibitor_name, s.name as space_name 
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY b.exhibitor_name
    `);
    res.render('addShedBill', { title: 'Add Shed Bill', bookings });
  } catch (err) {
    console.error('Error loading shed bill page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Save a new shed bill
router.post('/bill', async (req, res) => {
  const { booking_id, description, amount } = req.body;

  if (!booking_id || !description || !amount) {
    return res.status(400).send('Exhibitor, Description, and Amount are required.');
  }

  const billAmount = parseFloat(amount) || 0;
  if (billAmount <= 0) {
    return res.status(400).send('Amount must be greater than zero.');
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');
      // 1. Insert the shed bill
      const sql = `INSERT INTO shed_bills (booking_id, bill_date, description, amount) VALUES (?, date('now'), ?, ?)`;
      await run(sql, [booking_id, description, billAmount]);

      // 2. Update the master due_amount on the bookings table
      await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [billAmount, booking_id]);

      db.run('COMMIT');
      res.redirect(`/booking/details-full/${booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error processing shed bill for booking ${booking_id}:`, err.message);
      res.status(500).send('Failed to process shed bill.');
    }
  });
});

// GET: Show form to edit a shed bill
router.get('/bill/edit/:id', async (req, res) => {
  const billId = req.params.id;
  try {
    const bill = await get('SELECT * FROM shed_bills WHERE id = ?', [billId]);
    if (!bill) {
      return res.status(404).send('Shed bill not found.');
    }
    // Fetch all bookings to populate the dropdown
    const bookings = await all(`
      SELECT b.id, b.exhibitor_name, s.name as space_name 
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY b.exhibitor_name
    `);
    res.render('editShedBill', { title: `Edit Shed Bill #${billId}`, bill, bookings });
  } catch (err) {
    console.error('Error loading shed bill for editing:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Update a shed bill
router.post('/bill/edit/:id', async (req, res) => {
  const billId = req.params.id;
  const { booking_id, description, amount } = req.body;
  const newAmount = parseFloat(amount) || 0;

  if (!booking_id || !description || newAmount <= 0) {
    return res.status(400).send('All fields are required and amount must be positive.');
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // Get the old bill to calculate the difference in due amount
      const oldBill = await get('SELECT amount, booking_id FROM shed_bills WHERE id = ?', [billId]);
      if (!oldBill) throw new Error('Original shed bill not found.');

      const amountDifference = newAmount - oldBill.amount;

      // 1. Update the shed bill itself
      await run(
        'UPDATE shed_bills SET booking_id = ?, description = ?, amount = ? WHERE id = ?',
        [booking_id, description, newAmount, billId]
      );

      // 2. Adjust the due amount on the booking
      // If the booking changed, reverse the old charge and apply the new one
      if (oldBill.booking_id !== booking_id) {
        await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [oldBill.amount, oldBill.booking_id]);
        await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [newAmount, booking_id]);
      } else {
        // Otherwise, just apply the difference
        await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, booking_id]);
      }

      db.run('COMMIT');
      res.redirect(`/booking/details-full/${booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error updating shed bill #${billId}:`, err.message);
      res.status(500).send('Failed to update shed bill.');
    }
  });
});

// POST: Delete a shed bill
router.post('/bill/delete/:id', async (req, res) => {
  const billId = req.params.id;

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // 1. Get the bill details before deleting it
      const bill = await get('SELECT amount, booking_id FROM shed_bills WHERE id = ?', [billId]);
      if (!bill) {
        // If the bill is already gone, just redirect.
        db.run('ROLLBACK');
        return res.redirect('/booking/list');
      }

      // 2. Delete the shed bill
      await run('DELETE FROM shed_bills WHERE id = ?', [billId]);

      // 3. Subtract the bill amount from the booking's due_amount
      await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [bill.amount, bill.booking_id]);

      db.run('COMMIT');
      res.redirect(`/booking/details-full/${bill.booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error deleting shed bill #${billId}:`, err.message);
      res.status(500).send('Failed to delete shed bill.');
    }
  });
});

module.exports = router;