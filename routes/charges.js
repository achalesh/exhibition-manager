const express = require('express');
const router = express.Router();
const { db, all, get, run } = require('../db-helpers');

// GET: Show the form to add various charges
router.get('/add', async (req, res) => {
  try {
    // Fetch all bookings to populate the exhibitor dropdown
    const bookings = await all(`
      SELECT b.id, b.exhibitor_name, s.name as space_name 
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY b.exhibitor_name
    `);
    res.render('addCharges', { title: 'Receive Payment', bookings });
  } catch (err) {
    console.error('Error loading add charges page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// GET: Fetch due details for a specific booking
router.get('/details/:booking_id', async (req, res) => {
  const { booking_id } = req.params;
  try {
    const booking = await get('SELECT client_id, rent_amount, discount, advance_amount FROM bookings WHERE id = ?', [booking_id]);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Calculate total charges for each category
    const rentCharged = (booking.rent_amount || 0) - (booking.discount || 0) - (booking.advance_amount || 0);
    const electricCharged = (await get('SELECT SUM(total_amount) as total FROM electric_bills WHERE booking_id = ?', [booking_id]))?.total || 0;
    const materialCharged = (await get('SELECT SUM(total_payable) as total FROM material_issues WHERE client_id = ?', [booking.client_id]))?.total || 0;
    const shedRentFromAllocation = (await get('SELECT SUM(s.rent) as total FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ?', [booking_id]))?.total || 0;
    const shedRentFromBills = (await get('SELECT SUM(amount) as total FROM shed_bills WHERE booking_id = ?', [booking_id]))?.total || 0;
    const shedCharged = shedRentFromAllocation + shedRentFromBills;

    // Calculate total payments for each category
    const payments = await get('SELECT SUM(rent_paid) as rent, SUM(electric_paid) as electric, SUM(material_paid) as material, SUM(shed_paid) as shed FROM payments WHERE booking_id = ?', [booking_id]);
    const rentPaid = payments?.rent || 0;
    const electricPaid = payments?.electric || 0;
    const materialPaid = payments?.material || 0;
    const shedPaid = payments?.shed || 0;

    const rentDue = rentCharged - rentPaid;
    const electricDue = electricCharged - electricPaid;
    const materialDue = materialCharged - materialPaid;
    const shedDue = shedCharged - shedPaid;

    res.json({
      rent_due: rentDue,
      electric_due: electricDue,
      material_due: materialDue,
      shed_due: shedDue,
      total_due: rentDue + electricDue + materialDue + shedDue
    });
  } catch (err) {
    console.error('Error fetching charge details:', err.message);
    res.status(500).json({ error: 'Failed to fetch details' });
  }
});

// POST: Record a new payment
router.post('/add', async (req, res) => {
  const { booking_id, receipt_number, payment_date, payment_type, cash_paid, upi_paid } = req.body;

  if (!booking_id) {
    return res.status(400).send('Booking is required.');
  }

  const cashAmount = parseFloat(cash_paid) || 0;
  const upiAmount = parseFloat(upi_paid) || 0;
  const totalPaid = cashAmount + upiAmount;

  // Determine payment mode based on which field has a value
  const payment_mode = cashAmount > 0 && upiAmount > 0 ? 'Cash & UPI' : (cashAmount > 0 ? 'Cash' : 'UPI');

  if (totalPaid <= 0) {
    return res.status(400).send('Payment amount must be greater than zero.');
  }

  const paymentCols = { rent: 'rent_paid', electric: 'electric_paid', material: 'material_paid', shed: 'shed_paid' };
  const targetCol = paymentCols[payment_type];
  if (!targetCol) {
    return res.status(400).send('Invalid payment type specified.');
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');
      // 1. Insert the detailed payment record
      const paymentSql = `INSERT INTO payments (booking_id, receipt_number, payment_date, payment_mode, cash_paid, upi_paid, ${targetCol}) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      const { lastID: paymentId } = await run(paymentSql, [booking_id, receipt_number, payment_date, payment_mode, cashAmount, upiAmount, totalPaid]);

      // 2. Update the master due_amount on the bookings table
      await run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [totalPaid, booking_id]);

      // 3. Add to accounting ledger as income
      const booking = await get('SELECT exhibitor_name FROM bookings WHERE id = ?', [booking_id]);
      let accountingCategory = 'Booking Payment'; // Default
      let accountingDescription = `Payment from ${booking.exhibitor_name}`;

      if (payment_type === 'rent') {
        accountingCategory = 'Rent Payment';
      } else if (payment_type === 'electric') {
        accountingCategory = 'Electric Bill Payment';
      } else if (payment_type === 'material') {
        accountingCategory = 'Material Issue Payment';
      } else if (payment_type === 'shed') {
        accountingCategory = 'Shed Rent Payment';
      }

      const accountingSql = `INSERT INTO accounting_transactions (payment_id, transaction_type, category, description, amount, transaction_date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      await run(accountingSql, [paymentId, 'income', accountingCategory, accountingDescription, totalPaid, payment_date, req.session.user.id]);


      db.run('COMMIT');
      // Redirect back to the page with the same exhibitor selected
      res.redirect(`/charges/add?booking_id=${booking_id}`);

    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error processing payment for booking ${booking_id}:`, err.message);
      res.status(500).send('Failed to process payment.');
    }
  });
});

// GET: Show form to edit a payment
router.get('/edit/:id', async (req, res) => {
  const paymentId = req.params.id;
  try {
    const payment = await get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!payment) {
      return res.status(404).send('Payment not found.');
    }

    // Determine the payment type and amount
    if (payment.rent_paid > 0) {
      payment.type = 'rent';
      payment.amount = payment.rent_paid;
    } else if (payment.electric_paid > 0) {
      payment.type = 'electric';
      payment.amount = payment.electric_paid;
    } else if (payment.material_paid > 0) {
      payment.type = 'material';
      payment.amount = payment.material_paid;
    } else if (payment.shed_paid > 0) {
      payment.type = 'shed';
      payment.amount = payment.shed_paid;
    }

    const bookings = await all('SELECT id, exhibitor_name, facia_name, space_id FROM bookings ORDER BY exhibitor_name');

    res.render('editPayment', { title: 'Edit Payment', payment, bookings });
  } catch (err) {
    console.error('Error loading payment for editing:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Update a payment
router.post('/edit/:id', async (req, res) => {
  const paymentId = req.params.id;
  const { receipt_number, payment_date, amount_paid } = req.body;
  const newAmount = parseFloat(amount_paid) || 0;

  if (newAmount <= 0) {
    return res.status(400).send('Payment amount must be greater than zero.');
  }

  if (req.session.user && req.session.user.role === 'admin') {
    db.serialize(async () => {
      try {
        db.run('BEGIN TRANSACTION');
        const oldPayment = await get('SELECT * FROM payments WHERE id = ?', [paymentId]);
        if (!oldPayment) throw new Error('Original payment not found.');
        const oldAmount = oldPayment.rent_paid + oldPayment.electric_paid + oldPayment.material_paid + oldPayment.shed_paid;
        const amountDifference = oldAmount - newAmount;
        let targetCol = '';
        if (oldPayment.rent_paid > 0) targetCol = 'rent_paid'; else if (oldPayment.electric_paid > 0) targetCol = 'electric_paid'; else if (oldPayment.material_paid > 0) targetCol = 'material_paid'; else if (oldPayment.shed_paid > 0) targetCol = 'shed_paid';
        if (!targetCol) throw new Error('Could not determine payment type for old payment.');
        await run(`UPDATE payments SET receipt_number = ?, payment_date = ?, ${targetCol} = ? WHERE id = ?`, [receipt_number, payment_date, newAmount, paymentId]);
        await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, oldPayment.booking_id]);

        // Update the corresponding accounting transaction
        await run('UPDATE accounting_transactions SET amount = ?, transaction_date = ? WHERE payment_id = ?', [newAmount, payment_date, paymentId]);

        db.run('COMMIT');
        res.redirect(`/booking/details-full/${oldPayment.booking_id}?message=Payment updated successfully.`);
      } catch (err) {
        db.run('ROLLBACK');
        console.error(`Error updating payment #${paymentId}:`, err.message);
        res.status(500).send('Failed to update payment.');
      }
    });
  } else {
    // Non-admin: Submit for approval
    try {
      const proposed_data = JSON.stringify(req.body);
      const sql = `INSERT INTO payment_edits (payment_id, user_id, username, proposed_data, request_date) VALUES (?, ?, ?, ?, datetime('now'))`;
      await run(sql, [paymentId, req.session.user.id, req.session.user.username, proposed_data]);
      const payment = await get('SELECT booking_id FROM payments WHERE id = ?', [paymentId]);
      res.redirect(`/booking/details-full/${payment.booking_id}?message=Payment edit submitted for approval.`);
    } catch (err) {
      console.error('Error submitting payment edit for approval:', err.message);
      res.status(500).send('Failed to submit payment edit for approval.');
    }
  }
});

// POST: Delete a payment
router.post('/delete/:id', async (req, res) => {
  const paymentId = req.params.id;
  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');
      const payment = await get('SELECT * FROM payments WHERE id = ?', [paymentId]);
      if (!payment) throw new Error('Payment not found.');

      const totalPaid = payment.rent_paid + payment.electric_paid + payment.material_paid + payment.shed_paid;
      await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [totalPaid, payment.booking_id]);

      // Delete the corresponding accounting transaction
      await run('DELETE FROM accounting_transactions WHERE payment_id = ?', [paymentId]);

      await run('DELETE FROM payments WHERE id = ?', [paymentId]);
      db.run('COMMIT');
      res.redirect(`/booking/details-full/${payment.booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error(`Error deleting payment #${paymentId}:`, err.message);
      res.status(500).send('Failed to delete payment.');
    }
  });
});

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).send('Access Denied: Admins only.');
};

// GET: Show page to approve a pending payment edit
router.get('/approve/:edit_id', isAdmin, async (req, res) => {
  const editId = req.params.edit_id;
  try {
    const editRequest = await get("SELECT pe.*, b.exhibitor_name FROM payment_edits pe JOIN payments p ON pe.payment_id = p.id JOIN bookings b ON p.booking_id = b.id WHERE pe.id = ? AND pe.status = 'pending'", [editId]);
    if (!editRequest) {
      return res.status(404).send('Payment edit request not found or already processed.');
    }

    const currentPayment = await get('SELECT * FROM payments WHERE id = ?', [editRequest.payment_id]);
    const proposedData = JSON.parse(editRequest.proposed_data);

    res.render('approvePaymentEdit', {
      title: 'Approve Payment Edit',
      editRequest,
      currentPayment,
      proposedData
    });
  } catch (err) {
    console.error('Error loading payment approval page:', err.message);
    res.status(500).send('Error loading approval page.');
  }
});

// POST: Approve a pending payment edit
router.post('/approve/:edit_id', isAdmin, async (req, res) => {
  const editId = req.params.edit_id;
  try {
    const editRequest = await get('SELECT * FROM payment_edits WHERE id = ?', [editId]);
    const proposedData = JSON.parse(editRequest.proposed_data);
    const { receipt_number, payment_date, amount_paid } = proposedData;
    const newAmount = parseFloat(amount_paid) || 0;

    // Reuse the existing admin edit logic
    db.run('BEGIN TRANSACTION');
    const oldPayment = await get('SELECT * FROM payments WHERE id = ?', [editRequest.payment_id]);
    const oldAmount = oldPayment.rent_paid + oldPayment.electric_paid + oldPayment.material_paid + oldPayment.shed_paid;
    const amountDifference = oldAmount - newAmount;
    let targetCol = '';
    if (oldPayment.rent_paid > 0) targetCol = 'rent_paid'; else if (oldPayment.electric_paid > 0) targetCol = 'electric_paid'; else if (oldPayment.material_paid > 0) targetCol = 'material_paid'; else if (oldPayment.shed_paid > 0) targetCol = 'shed_paid';
    await run(`UPDATE payments SET receipt_number = ?, payment_date = ?, ${targetCol} = ? WHERE id = ?`, [receipt_number, payment_date, newAmount, editRequest.payment_id]);
    await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, oldPayment.booking_id]);
    
    // Update the corresponding accounting transaction
    await run('UPDATE accounting_transactions SET amount = ?, transaction_date = ? WHERE payment_id = ?', [newAmount, payment_date, editRequest.payment_id]);

    await run(`UPDATE payment_edits SET status = 'approved' WHERE id = ?`, [editId]);
    db.run('COMMIT');

    res.redirect('/dashboard?message=Payment edit approved and applied.');
  } catch (err) {
    db.run('ROLLBACK');
    console.error('Error approving payment edit:', err.message);
    res.status(500).send('Failed to approve payment edit.');
  }
});

// POST: Reject a pending payment edit
router.post('/reject/:edit_id', isAdmin, async (req, res) => {
  const editId = req.params.edit_id;
  const { rejection_reason } = req.body;
  await run(`UPDATE payment_edits SET status = 'rejected', rejection_reason = ? WHERE id = ?`, [rejection_reason, editId]);
  res.redirect('/dashboard?message=Payment edit has been rejected.');
});

module.exports = router;