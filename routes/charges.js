const express = require('express');
const router = express.Router();
const { all, get, run, transaction } = require('../db-helpers'); // Assuming transaction helper is added

// GET: Show the form to add various charges
router.get('/add', async (req, res) => {
  try {
    const { last_payment_id } = req.query;
    let lastPaymentDetails = null;

    // Fetch details of the last payment if an ID is provided
    if (last_payment_id) {
      lastPaymentDetails = await get(`
        SELECT 
          p.*, 
          b.exhibitor_name,
          (p.cash_paid + p.upi_paid) as total_paid,
          CASE
            WHEN p.rent_paid > 0 THEN 'Rent'
            WHEN p.electric_paid > 0 THEN 'Electric'
            WHEN p.material_paid > 0 THEN 'Material'
            WHEN p.shed_paid > 0 THEN 'Shed'
            ELSE 'Unknown'
          END as payment_category
        FROM payments p 
        JOIN bookings b ON p.booking_id = b.id 
        WHERE p.id = ?
      `, [last_payment_id]);
    }

    // Fetch bookings and next receipt number in parallel
    const [bookings, lastReceipt] = await Promise.all([
      all(`
        SELECT b.id, b.exhibitor_name, b.facia_name, s.name as space_name, (b.exhibitor_name || ' (' || s.name || ')') as display_name
        FROM bookings b
        JOIN spaces s ON b.space_id = s.id
        WHERE b.event_session_id = ? AND b.booking_status = 'active'
        ORDER BY b.exhibitor_name
      `, [res.locals.viewingSession.id]),
      get(`SELECT MAX(CAST(receipt_number AS INTEGER)) as max_receipt FROM payments WHERE event_session_id = ?`, [res.locals.viewingSession.id])
    ]);

    const nextReceiptNumber = (lastReceipt?.max_receipt || 0) + 1;

    res.render('addCharges', { 
      title: 'Receive Payment', 
      bookings, 
      lastPaymentDetails,
      nextReceiptNumber,
      selectedBookingId: req.query.booking_id
    });
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
  const { booking_id, receipt_number, payment_date, payment_type, cash_paid, upi_paid, remarks } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add payments to an archived session.' };
    return res.redirect(`/charges/add${booking_id ? '?booking_id=' + booking_id : ''}`);
  }

  if (!booking_id) {
    return res.status(400).send('Booking is required.');
  }

  const cashAmount = parseFloat(cash_paid) || 0;
  const upiAmount = parseFloat(upi_paid) || 0;
  const totalPaid = cashAmount + upiAmount;

  const payment_mode = cashAmount > 0 && upiAmount > 0 ? 'Cash & UPI' : (cashAmount > 0 ? 'Cash' : 'UPI');

  if (totalPaid <= 0) {
    req.session.flash = { type: 'danger', message: 'Payment amount must be greater than zero.' };
    return res.redirect(`/charges/add?booking_id=${booking_id}`);
  }

  const paymentCols = { rent: 'rent_paid', electric: 'electric_paid', material: 'material_paid', shed: 'shed_paid' };
  const targetCol = paymentCols[payment_type];
  if (!targetCol) {
    return res.status(400).send('Invalid payment type specified.');
  }

  const activeSessionId = res.locals.activeSession.id;
  try {
    let newPaymentId;
    await transaction(async (db) => {
        // 1. Insert the detailed payment record
        const finalReceiptNumber = payment_type === 'rent' ? receipt_number : 'NA';

        const paymentSql = `INSERT INTO payments (booking_id, receipt_number, payment_date, payment_mode, cash_paid, upi_paid, ${targetCol}, event_session_id, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const { lastID: paymentId } = await db.run(paymentSql, [
            booking_id, finalReceiptNumber, payment_date, 
            payment_mode, cashAmount, upiAmount, 
            totalPaid, activeSessionId, remarks
        ]);
        newPaymentId = paymentId; // Capture the new ID

        // 2. Update the master due_amount on the bookings table
        await db.run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [totalPaid, booking_id]);

        // 3. Add to accounting ledger as income
        const booking = await db.get('SELECT exhibitor_name FROM bookings WHERE id = ?', [booking_id]);
        const categories = {
            rent: 'Rent Payment',
            electric: 'Electric Bill Payment',
            material: 'Material Issue Payment',
            shed: 'Shed Rent Payment'
        };
        const accountingCategory = categories[payment_type] || 'Booking Payment';
        const accountingDescription = `Payment from ${booking.exhibitor_name}`;
        const accountingSql = `INSERT INTO accounting_transactions (payment_id, transaction_type, category, description, amount, transaction_date, user_id, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.run(accountingSql, [paymentId, 'income', accountingCategory, accountingDescription, totalPaid, payment_date, req.session.user.id, activeSessionId]);
    });
    // Redirect back to the page with the same exhibitor selected
    res.redirect(`/charges/add?booking_id=${booking_id}&last_payment_id=${newPaymentId}`);
  } catch (err) {
    console.error(`Error processing payment for booking ${booking_id}:`, err.message);
    res.status(500).send('Failed to process payment.');
  }
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
  const { receipt_number, payment_date, cash_paid, upi_paid, remarks } = req.body;
  const newCashAmount = parseFloat(cash_paid) || 0;
  const newUpiAmount = parseFloat(upi_paid) || 0;
  const newTotalAmount = newCashAmount + newUpiAmount;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    const payment = await get('SELECT booking_id FROM payments WHERE id = ?', [paymentId]);
    req.session.flash = { type: 'warning', message: 'Cannot edit payments in an archived session.' };
    return res.redirect(`/booking/details-full/${payment.booking_id}`);
  }

  if (newTotalAmount <= 0) {
    return res.status(400).send('Payment amount must be greater than zero.');
  }

  if (req.session.user && req.session.user.role === 'admin') {
    try {
      let bookingIdToRedirect;
      await transaction(async (db) => {
          const oldPayment = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
          if (!oldPayment) throw new Error('Original payment not found.');
          bookingIdToRedirect = oldPayment.booking_id;
          const oldTotalAmount = oldPayment.rent_paid + oldPayment.electric_paid + oldPayment.material_paid + oldPayment.shed_paid;
          const amountDifference = oldTotalAmount - newTotalAmount;
          const newPaymentMode = newCashAmount > 0 && newUpiAmount > 0 ? 'Cash & UPI' : (newCashAmount > 0 ? 'Cash' : 'UPI');
          let targetCol = '';
          if (oldPayment.rent_paid > 0) targetCol = 'rent_paid'; else if (oldPayment.electric_paid > 0) targetCol = 'electric_paid'; else if (oldPayment.material_paid > 0) targetCol = 'material_paid'; else if (oldPayment.shed_paid > 0) targetCol = 'shed_paid';
          if (!targetCol) throw new Error('Could not determine payment type for old payment.');
          await db.run(
            `UPDATE payments SET receipt_number = ?, payment_date = ?, payment_mode = ?, cash_paid = ?, upi_paid = ?, ${targetCol} = ?, remarks = ? WHERE id = ?`, 
            [receipt_number, payment_date, newPaymentMode, newCashAmount, newUpiAmount, newTotalAmount, remarks, paymentId]
          );
          await db.run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, oldPayment.booking_id]);
          await db.run('UPDATE accounting_transactions SET amount = ?, transaction_date = ? WHERE payment_id = ?', [newTotalAmount, payment_date, paymentId]);
      });
      res.redirect(`/booking/details-full/${bookingIdToRedirect}?message=Payment updated successfully.`);
    } catch (err) {
      console.error(`Error updating payment #${paymentId}:`, err.message);
      res.status(500).send('Failed to update payment.');
    }
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

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    const payment = await get('SELECT booking_id FROM payments WHERE id = ?', [paymentId]);
    req.session.flash = { type: 'warning', message: 'Cannot delete payments from an archived session.' };
    return res.redirect(`/booking/details-full/${payment.booking_id}`);
  }

  try {
    let bookingIdToRedirect;
    await transaction(async (db) => {
        const payment = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
        if (!payment) throw new Error('Payment not found.');
        bookingIdToRedirect = payment.booking_id;

        const totalPaid = payment.rent_paid + payment.electric_paid + payment.material_paid + payment.shed_paid;
        await db.run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [totalPaid, payment.booking_id]);

        await db.run('DELETE FROM accounting_transactions WHERE payment_id = ?', [paymentId]);
        await db.run('DELETE FROM payments WHERE id = ?', [paymentId]);
    });
    res.redirect(`/booking/details-full/${bookingIdToRedirect}`);
  } catch (err) {
    console.error(`Error deleting payment #${paymentId}:`, err.message);
    res.status(500).send('Failed to delete payment.');
  }
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


// GET /charges/receipt/:id - Show a printable receipt for a payment
router.get('/receipt/:id', async (req, res) => {
  const paymentId = req.params.id;
  try {
    const payment = await get(`
      SELECT 
        p.*,
        b.exhibitor_name,
        b.facia_name,
        s.name as space_name
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id
      JOIN spaces s ON b.space_id = s.id
      WHERE p.id = ?
    `, [paymentId]);

    if (!payment) {
      return res.status(404).send('Payment receipt not found.');
    }

    // --- Financial Summary Calculation ---
    // 1. Get all charges for the booking
    const bookingDetails = await get('SELECT client_id, rent_amount, discount FROM bookings WHERE id = ?', [payment.booking_id]);
    const rentCharged = (bookingDetails.rent_amount || 0) - (bookingDetails.discount || 0);
    const electricCharged = (await get('SELECT SUM(total_amount) as total FROM electric_bills WHERE booking_id = ?', [payment.booking_id]))?.total || 0;
    const materialCharged = (await get('SELECT SUM(total_payable) as total FROM material_issues WHERE client_id = ?', [bookingDetails.client_id]))?.total || 0;
    const shedRentFromAllocation = (await get('SELECT SUM(s.rent) as total FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ?', [payment.booking_id]))?.total || 0;
    const totalCharged = rentCharged + electricCharged + materialCharged + shedRentFromAllocation;

    // 2. Get all payments for the booking
    const allPayments = await all('SELECT rent_paid, electric_paid, material_paid, shed_paid FROM payments WHERE booking_id = ?', [payment.booking_id]);
    const totalPaid = allPayments.reduce((sum, p) => sum + p.rent_paid + p.electric_paid + p.material_paid + p.shed_paid, 0);
    
    // 3. Calculate the balance
    const thisPaymentAmount = payment.rent_paid + payment.electric_paid + payment.material_paid + payment.shed_paid;
    const balanceDue = totalCharged - totalPaid;
    const previousBalance = balanceDue + thisPaymentAmount;

    const financialSummary = {
      previous_balance: previousBalance,
      amount_paid: thisPaymentAmount,
      balance_due: balanceDue
    };

    res.render('paymentReceipt', {
      title: `Receipt #${payment.receipt_number || payment.id}`,
      payment,
      financialSummary,
      viewingSession: res.locals.viewingSession
    });
  } catch (err) {
    console.error('Error generating payment receipt:', err);
    res.status(500).send('Error generating receipt.');
  }
});

module.exports = router;