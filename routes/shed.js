const express = require('express');
const router = express.Router();
const { all, get, run, transaction } = require('../db-helpers');

// GET: Show page to manage all sheds (add, edit, delete)
router.get('/manage', async (req, res) => {
  try {
    const { status = 'active' } = req.query;
    const viewingSessionId = res.locals.viewingSession.id;
    // Fetch all sheds and join their allocation status for the current viewing session
    let sql = `
      SELECT 
        s.*,
        CASE WHEN sa.id IS NOT NULL THEN 'Allocated' ELSE 'Available' END as session_status
      FROM sheds s
      LEFT JOIN shed_allocations sa ON s.id = sa.shed_id AND sa.event_session_id = ?
    `;
    const params = [viewingSessionId];

    if (status === 'active') {
      sql += ' WHERE s.is_active = 1';
    } else if (status === 'inactive') {
      sql += ' WHERE s.is_active = 0';
    }
    sql += ' ORDER BY s.name';

    const sheds = await all(sql, params);

    res.render('manageSheds', {
      title: 'Manage Sheds',
      sheds: sheds || [],
      viewingSession: res.locals.viewingSession,
      report_url: '/shed/manage', // For active nav link
      filters: { status }
    });
  } catch (err) {
    console.error('Error loading manage sheds page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Add a new shed
router.post('/add', async (req, res) => {
  const { name, size, rent } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add sheds in an archived session.' };
    return res.redirect('/shed/manage');
  }

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
    const viewingSessionId = res.locals.viewingSession.id;
    // Fetch all current bookings and all available sheds in parallel
    const [bookings, sheds] = await Promise.all([
      all(`SELECT b.id, b.exhibitor_name, s.space_name 
           FROM bookings b 
           LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
           ON b.id = s.booking_id
           WHERE b.event_session_id = ? AND b.booking_status = 'active'
           ORDER BY b.exhibitor_name`, [viewingSessionId]),
      // A shed is available if it's not in the shed_allocations table for the current viewing session
      all(`
        SELECT s.* FROM sheds s
        WHERE s.is_active = 1 AND s.id NOT IN (SELECT sa.shed_id FROM shed_allocations sa WHERE sa.event_session_id = ?)
        ORDER BY s.name
      `, [viewingSessionId])
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
  const activeSessionId = res.locals.activeSession.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot allocate sheds in an archived session.' };
    return res.redirect('/shed/allocate');
  }

  if (!booking_id || !shed_id) {
    return res.status(400).send('Exhibitor and Shed must be selected.');
  }

  try {
    await transaction(async (db) => {
        const shed = await db.get('SELECT rent FROM sheds WHERE id = ?', [shed_id]);
        if (!shed) throw new Error('Selected shed not found.');

        // 1. Create the allocation record
        await db.run('INSERT INTO shed_allocations (booking_id, shed_id, allocation_date, event_session_id) VALUES (?, ?, date("now"), ?)', [booking_id, shed_id, activeSessionId]);

        // 2. Add the shed rent to the booking's due amount
        await db.run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [shed.rent, booking_id]);
    });
    req.session.flash = { type: 'success', message: 'Shed allocated successfully.' };
    res.redirect('/booking/list');
  } catch (err) {
    console.error('Error during shed allocation:', err.message);
    res.status(500).send('Failed to allocate shed.');
  }
});

// POST: Edit an existing shed
router.post('/edit/:id', async (req, res) => {
  const { name, size, rent } = req.body;
  const { id } = req.params;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot edit sheds in an archived session.' };
    return res.redirect('/shed/manage');
  }

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

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot deactivate sheds from an archived session.' };
    return res.redirect('/shed/manage');
  }

  try {
    // Check if the shed is currently allocated in ANY active session.
    const allocation = await get("SELECT sa.id FROM shed_allocations sa JOIN event_sessions es ON sa.event_session_id = es.id WHERE sa.shed_id = ? AND es.is_active = 1", [id]);
    if (allocation) {
      req.session.flash = { type: 'danger', message: 'Cannot deactivate a shed that is currently allocated in an active session. Please de-allocate it first.' };
      return res.redirect('/shed/manage');
    }
    await run('UPDATE sheds SET is_active = 0 WHERE id = ?', [id]);
    req.session.flash = { type: 'success', message: 'Shed deactivated successfully.' };
    return res.redirect('/shed/manage');
  } catch (err) {
    console.error(`Error deactivating shed #${id}:`, err.message);
    res.status(500).send('Failed to deactivate shed.');
  }
});

// POST: Reactivate a shed
router.post('/reactivate/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await run('UPDATE sheds SET is_active = 1 WHERE id = ?', [id]);
    res.redirect('/shed/manage?status=inactive');
  } catch (err) {
    console.error(`Error reactivating shed #${id}:`, err.message);
    res.status(500).send('Failed to reactivate shed.');
  }
});

// POST: Delete a shed allocation
router.post('/allocation/delete/:id', async (req, res) => {
  const allocationId = req.params.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    const allocation = await get('SELECT booking_id FROM shed_allocations WHERE id = ?', [allocationId]);
    req.session.flash = { type: 'warning', message: 'Cannot de-allocate sheds from an archived session.' };
    return res.redirect(`/booking/details-full/${allocation.booking_id}`);
  }

  try {
    let bookingIdToRedirect;
    await transaction(async (db) => {
      // 1. Get the allocation details to find the shed and booking
      const allocation = await db.get('SELECT * FROM shed_allocations WHERE id = ?', [allocationId]);
      if (!allocation) throw new Error('Shed allocation not found.');
      bookingIdToRedirect = allocation.booking_id;

      // 2. Get the shed's rent to subtract from the due amount
      const shed = await db.get('SELECT rent FROM sheds WHERE id = ?', [allocation.shed_id]);
      if (!shed) throw new Error('Associated shed not found.');

      // 3. Subtract the shed rent from the booking's due amount
      await db.run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [shed.rent, allocation.booking_id]);

      // 4. Delete the allocation record.
      await db.run('DELETE FROM shed_allocations WHERE id = ?', [allocationId]);
    });
    res.redirect(`/booking/details-full/${bookingIdToRedirect}`);
  } catch (err) {
    console.error(`Error deleting shed allocation #${allocationId}:`, err.message);
    res.status(500).send('Failed to delete shed allocation.');
  }
});

// GET: Show form to add a miscellaneous shed bill
router.get('/bill', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const bookings = await all(`
      SELECT b.id, b.exhibitor_name, s.space_name 
      FROM bookings b
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
      WHERE b.event_session_id = ?
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
  const activeSessionId = res.locals.activeSession.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add shed bills in an archived session.' };
    return res.redirect('/shed/bill');
  }

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
      const sql = `INSERT INTO shed_bills (booking_id, bill_date, description, amount, event_session_id) VALUES (?, date('now'), ?, ?, ?)`;
      await run(sql, [booking_id, description, billAmount, activeSessionId]);

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
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
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

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    const bill = await get('SELECT booking_id FROM shed_bills WHERE id = ?', [billId]);
    req.session.flash = { type: 'warning', message: 'Cannot edit shed bills in an archived session.' };
    return res.redirect(`/booking/details-full/${bill.booking_id}`);
  }

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

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    const bill = await get('SELECT booking_id FROM shed_bills WHERE id = ?', [billId]);
    req.session.flash = { type: 'warning', message: 'Cannot delete shed bills from an archived session.' };
    return res.redirect(`/booking/details-full/${bill.booking_id}`);
  }

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