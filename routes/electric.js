const express = require('express');
const router = express.Router();
const { all, get, run, db } = require('../db-helpers');

// Utility to safely parse items
function parseItems(items) {
  try {
    if (typeof items === 'string') {
      const parsed = JSON.parse(items);
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    }
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

// GET: Show the form to create a new electric bill
router.get('/add', async (req, res) => {
  const selectedBookingId = req.query.booking_id;
  try {
    const [bookings, items] = await Promise.all([
      all(`
        SELECT b.id, b.exhibitor_name, b.facia_name, s.name as space_name
        FROM bookings b
        JOIN spaces s ON b.space_id = s.id
        ORDER BY
          CASE s.type
            WHEN 'Pavilion' THEN 1
            WHEN 'Stall' THEN 2
            WHEN 'Booth' THEN 3
            ELSE 4
          END, s.name
      `),
      all('SELECT * FROM electric_items ORDER BY name')
    ]);

    res.render('addElectricBill', {
      title: 'Electric Bill Entry',
      bookings: bookings || [],
      items: items || [],
      selectedBookingId,
      bill: null
    });
  } catch (err) {
    console.error('Error loading electric bill page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Save the new electric bill
router.post('/add', async (req, res) => {
  const { sl_no, booking_id, items, total_amount, remarks } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add electric bills to an archived session.' };
    return res.redirect(`/electric/add${booking_id ? '?booking_id=' + booking_id : ''}`);
  }

  if (!booking_id || !items || !total_amount) {
    return res.status(400).send('Missing required fields: Exhibitor, Items, and Total are required.');
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      const parsedItems = parseItems(items);
      const sql = `
        INSERT INTO electric_bills (sl_no, booking_id, bill_date, items_json, total_amount, remarks)
        VALUES (?, ?, datetime('now'), ?, ?, ?)
      `;
      await run(sql, [sl_no, booking_id, JSON.stringify(parsedItems), total_amount, remarks]);

      await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [total_amount, booking_id]);

      db.run('COMMIT');
      res.redirect(`/booking/details-full/${booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error('Error saving electric bill:', err.message);
      res.status(500).send('Failed to save the electric bill.');
    }
  });
});

// GET: Show form to edit an electric bill
router.get('/edit/:id', async (req, res) => {
  const billId = req.params.id;
  try {
    const bill = await get('SELECT * FROM electric_bills WHERE id = ?', [billId]);
    if (!bill) return res.status(404).send('Electric bill not found.');

    bill.items = parseItems(bill.items_json);

    const [bookings, items] = await Promise.all([
      all(`
        SELECT b.id, b.exhibitor_name, b.facia_name, s.name as space_name
        FROM bookings b JOIN spaces s ON b.space_id = s.id
        WHERE s.status = 'Booked' OR b.id = ?
        ORDER BY CASE s.type WHEN 'Pavilion' THEN 1 WHEN 'Stall' THEN 2 WHEN 'Booth' THEN 3 ELSE 4 END, s.name
      `, [bill.booking_id]),
      all('SELECT * FROM electric_items ORDER BY name')
    ]);

    res.render('addElectricBill', {
      title: `Edit Electric Bill #${bill.id}`,
      bill,
      bookings,
      items
    });
  } catch (err) {
    console.error('Error loading electric bill for editing:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Update an electric bill
router.post('/edit/:id', async (req, res) => {
  const billId = req.params.id;
  const { sl_no, booking_id, items, total_amount, remarks } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot edit data in an archived session.' };
    return res.redirect(`/booking/details-full/${booking_id}`);
  }

  if (req.session.user && req.session.user.role === 'admin') {
    db.serialize(async () => {
      try {
        db.run('BEGIN TRANSACTION');
        const oldBill = await get('SELECT total_amount, booking_id FROM electric_bills WHERE id = ?', [billId]);
        if (!oldBill) throw new Error('Original electric bill not found.');
        const newTotalAmount = parseFloat(total_amount) || 0;
        const amountDifference = newTotalAmount - oldBill.total_amount;
        const parsedItems = parseItems(items);
        await run(`UPDATE electric_bills SET sl_no = ?, booking_id = ?, items_json = ?, total_amount = ?, remarks = ? WHERE id = ?`, [sl_no, booking_id, JSON.stringify(parsedItems), newTotalAmount, remarks, billId]);
        if (String(oldBill.booking_id) !== String(booking_id)) {
          await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [oldBill.total_amount, oldBill.booking_id]);
          await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [newTotalAmount, booking_id]);
        } else {
          await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, booking_id]);
        }
        db.run('COMMIT');
        res.redirect(`/booking/details-full/${booking_id}?message=Electric bill updated successfully.`);
      } catch (err) {
        db.run('ROLLBACK');
        console.error(`Error updating electric bill #${billId}:`, err.message);
        res.status(500).send('Failed to update electric bill.');
      }
    });
  } else {
    // Non-admin: Submit for approval
    const proposed_data = JSON.stringify(req.body);
    const sql = `INSERT INTO electric_bill_edits (electric_bill_id, user_id, username, proposed_data, request_date) VALUES (?, ?, ?, ?, datetime('now'))`;
    await run(sql, [billId, req.session.user.id, req.session.user.username, proposed_data]);
    res.redirect(`/booking/details-full/${booking_id}?message=Electric bill edit submitted for approval.`);
  }
});

// POST: Delete an electric bill
router.post('/delete/:id', async (req, res) => {
  const billId = req.params.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    const bill = await get('SELECT booking_id FROM electric_bills WHERE id = ?', [billId]);
    req.session.flash = { type: 'warning', message: 'Cannot delete data from an archived session.' };
    return res.redirect(`/booking/details-full/${bill.booking_id}`);
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      const bill = await get('SELECT total_amount, booking_id FROM electric_bills WHERE id = ?', [billId]);
      if (!bill) {
        db.run('ROLLBACK');
        return res.redirect('/booking/list');
      }

      await run('DELETE FROM electric_bills WHERE id = ?', [billId]);
      await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [bill.total_amount, bill.booking_id]);

      db.run('COMMIT');
      res.redirect(`/booking/details-full/${bill.booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error deleting electric bill #${billId}:`, err.message);
      res.status(500).send('Failed to delete electric bill.');
    }
  });
});

// GET: API endpoint to fetch all bills for a given booking
router.get('/for-booking/:booking_id', async (req, res) => {
  const { booking_id } = req.params;
  try {
    const bills = await all('SELECT * FROM electric_bills WHERE booking_id = ? ORDER BY bill_date DESC', [booking_id]);
    const processedBills = bills.map(bill => {
      bill.items = parseItems(bill.items_json);
      return bill;
    });
    res.json(processedBills || []);
  } catch (err) {
    console.error('Error fetching bills for booking:', err.message);
    res.status(500).json({ error: 'Failed to fetch bills.' });
  }
});

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).send('Access Denied: Admins only.');
};

// GET: Show page to approve a pending electric bill edit
router.get('/approve/:edit_id', isAdmin, async (req, res) => {
  const editId = req.params.edit_id;
  try {
    const editRequest = await get("SELECT * FROM electric_bill_edits WHERE id = ? AND status = 'pending'", [editId]);
    if (!editRequest) {
      return res.status(404).send('Electric bill edit request not found or already processed.');
    }
    const currentBill = await get('SELECT * FROM electric_bills WHERE id = ?', [editRequest.electric_bill_id]);
    currentBill.items = parseItems(currentBill.items_json);
    const proposedData = JSON.parse(editRequest.proposed_data);
    proposedData.items = parseItems(proposedData.items);

    res.render('approveElectricBill', {
      title: 'Approve Electric Bill Edit',
      editRequest,
      currentBill,
      proposedData
    });
  } catch (err) {
    console.error('Error loading electric bill approval page:', err.message);
    res.status(500).send('Error loading approval page.');
  }
});

// POST: Approve a pending electric bill edit
router.post('/approve/:edit_id', isAdmin, async (req, res) => {
  const editId = req.params.edit_id;
  try {
    const editRequest = await get('SELECT * FROM electric_bill_edits WHERE id = ?', [editId]);
    const proposedData = JSON.parse(editRequest.proposed_data);
    const { sl_no, booking_id, items, total_amount, remarks } = proposedData;

    db.run('BEGIN TRANSACTION');
    const oldBill = await get('SELECT total_amount, booking_id FROM electric_bills WHERE id = ?', [editRequest.electric_bill_id]);
    const newTotalAmount = parseFloat(total_amount) || 0;
    const amountDifference = newTotalAmount - oldBill.total_amount;
    const parsedItems = parseItems(items);
    await run(`UPDATE electric_bills SET sl_no = ?, booking_id = ?, items_json = ?, total_amount = ?, remarks = ? WHERE id = ?`, [sl_no, booking_id, JSON.stringify(parsedItems), newTotalAmount, remarks, editRequest.electric_bill_id]);
    if (String(oldBill.booking_id) !== String(booking_id)) {
      await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [oldBill.total_amount, oldBill.booking_id]);
      await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [newTotalAmount, booking_id]);
    } else {
      await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, booking_id]);
    }
    await run(`UPDATE electric_bill_edits SET status = 'approved' WHERE id = ?`, [editId]);
    db.run('COMMIT');

    res.redirect('/dashboard?message=Electric bill edit approved and applied.');
  } catch (err) {
    db.run('ROLLBACK');
    console.error('Error approving electric bill edit:', err.message);
    res.status(500).send('Failed to approve electric bill edit.');
  }
});

// POST: Reject a pending electric bill edit
router.post('/reject/:edit_id', isAdmin, async (req, res) => {
  const editId = req.params.edit_id;
  const { rejection_reason } = req.body;
  await run(`UPDATE electric_bill_edits SET status = 'rejected', rejection_reason = ? WHERE id = ?`, [rejection_reason, editId]);
  res.redirect('/dashboard?message=Electric bill edit has been rejected.');
});

module.exports = router;