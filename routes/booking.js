const express = require('express');
const router = express.Router();
const { db, all, get, run } = require('../db-helpers');

// GET: Show unified booking form, load ALL spaces
router.get('/add', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    // Fetch available spaces and suggestion data in parallel
    const [availableSpaces, exhibitors, productCategories, faciaNames] = await Promise.all([
      // Fetch only spaces that are NOT actively booked in the current session.
      // This is the most direct way to ensure only available spaces are listed.
      all(`
        SELECT id, name, type, rent_amount FROM spaces 
        WHERE id NOT IN (SELECT space_id FROM bookings WHERE event_session_id = ? AND booking_status = 'active')
        ORDER BY type, name`, [viewingSessionId]),
      all('SELECT DISTINCT name FROM clients ORDER BY name'),
      all('SELECT DISTINCT product_category FROM bookings WHERE product_category IS NOT NULL ORDER BY product_category'),
      all('SELECT DISTINCT facia_name FROM bookings WHERE facia_name IS NOT NULL ORDER BY facia_name')
    ]);

    res.render('bookSpace', {
      title: 'Book a Space',
      spaces: availableSpaces || [], // Use the correct list of available spaces
      suggestions: {
        exhibitors: exhibitors.map(e => e.name),
        productCategories: productCategories.map(pc => pc.product_category),
        faciaNames: faciaNames.map(fn => fn.facia_name)
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading spaces');
  }
});

// GET: Booking details for a specific space
router.get('/details/:space_id', async (req, res) => {
  const spaceId = req.params.space_id;
  const sql = `
    SELECT * FROM bookings WHERE space_id = ? AND booking_status = 'active' ORDER BY booking_date DESC LIMIT 1
  `;
  try {
    const booking = await get(sql, [spaceId]);
    res.json(booking || null);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// POST: Save booking
router.post('/add', async (req, res) => {
  const {
    space_id, exhibitor_name, facia_name, product_category,
    contact_person, full_address, contact_number, secondary_number,
    id_proof, rent_amount, discount, advance_amount, due_amount, form_submitted
  } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add bookings to an archived session. Please switch to the active session.' };
    return res.redirect('/booking/add');
  }

  const activeSessionId = res.locals.activeSession.id;

  const formSubmittedStatus = form_submitted ? 1 : 0;
  if (!space_id || !exhibitor_name || !contact_person || !contact_number) { // Basic validation
    return res.status(400).send('Missing required fields: space, exhibitor name, contact person, and contact number are required.');
  }

  // Check if the space is already actively booked in this session
  const existingBooking = await get('SELECT id FROM bookings WHERE space_id = ? AND event_session_id = ? AND booking_status = ?', [space_id, activeSessionId, 'active']);
  if (existingBooking) {
    req.session.flash = { type: 'danger', message: 'This space is already actively booked. Please vacate the previous exhibitor first.' };
    return res.redirect('/booking/add');
  }

  // Use a transaction to ensure all or nothing is saved
  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // Step 1: Find or Create client to prevent duplicates
      let client = await get('SELECT id FROM clients WHERE name = ?', [exhibitor_name]);
      let clientId;
      if (client) {
        clientId = client.id;
      } else {
        const clientSql = `INSERT INTO clients (name, contact_person, contact_number, full_address) VALUES (?, ?, ?, ?)`;
        clientId = (await run(clientSql, [exhibitor_name, contact_person, contact_number, full_address])).lastID;
      }

      // Step 2: Create booking
      const bookingSql = `
        INSERT INTO bookings (
          space_id, client_id, booking_date, exhibitor_name, facia_name, product_category,
          contact_person, full_address, contact_number, secondary_number, id_proof, event_session_id,
          rent_amount, discount, advance_amount, due_amount, form_submitted
        ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const bookingParams = [space_id, clientId, exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, activeSessionId, rent_amount, discount, advance_amount, due_amount, formSubmittedStatus];
      const { lastID: bookingId } = await run(bookingSql, bookingParams);

      db.run('COMMIT');
      res.redirect(`/booking/confirmation/${bookingId}`);

    } catch (err) {
      console.error("Error during booking transaction:", err.message);
      db.run('ROLLBACK');
      res.status(500).send('Error saving booking. The operation was rolled back.');
    }
  });
});

// GET: Booking list
router.get('/list', async (req, res) => {
  const viewingSessionId = res.locals.viewingSession.id;
  const filter = req.query.form_status || 'all';
  const whereClauses = ['b.event_session_id = ?'];
  const params = [viewingSessionId];

  if (filter === 'submitted') {
    whereClauses.push('b.form_submitted = 1');
  } else if (filter === 'not_submitted') {
    whereClauses.push('b.form_submitted = 0');
  }

  const sql = `
    SELECT b.id, b.exhibitor_name AS client_name, b.facia_name, s.name AS space_name, s.size as space_size, s.type as space_type,
           b.rent_amount, b.discount, b.due_amount, b.form_submitted
    FROM bookings b
    JOIN spaces s ON b.space_id = s.id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY
      CASE s.type
        WHEN 'Pavilion' THEN 1
        WHEN 'Stall' THEN 2
        WHEN 'Booth' THEN 3
        ELSE 4
      END,
      s.name
  `;
  try {
    const bookings = await all(sql, params);
    res.render('bookings', { title: 'View Bookings', bookings, currentFilter: filter, message: req.query.message });
  } catch (err) {
    console.error("Error fetching bookings:", err.message);
    res.render('bookings', { title: 'View Bookings', bookings: [], currentFilter: filter, message: null });
  }
});

// GET: Show booking confirmation page
router.get('/confirmation/:id', async (req, res) => {
  const bookingId = req.params.id;
  const sql = `
    SELECT b.id, b.exhibitor_name, b.rent_amount, b.due_amount, s.name AS space_name, s.type as space_type
    FROM bookings b
    JOIN spaces s ON b.space_id = s.id
    WHERE b.id = ?
  `;
  try {
    const booking = await get(sql, [bookingId]);
    if (!booking) {
      return res.status(404).send('Booking not found');
    }
    res.render('bookingConfirmation', {
      title: 'Booking Confirmed',
      booking: booking
    });
  } catch (err) {
    res.status(500).send('Error loading confirmation page.');
  }
});

// GET: Show full details for a booking, including materials and electric bills
router.get('/details-full/:id', async (req, res) => {
  const bookingId = parseInt(req.params.id, 10);
  const viewingSessionId = res.locals.viewingSession.id;
  try {
    // --- Logic for Next/Back buttons ---
    const orderedBookingsSql = `
      SELECT b.id
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      WHERE b.event_session_id = ?
      ORDER BY
        CASE s.type
          WHEN 'Pavilion' THEN 1
          WHEN 'Stall' THEN 2
          WHEN 'Booth' THEN 3
          ELSE 4
        END,
        s.name
    `;
    const allBookingIds = (await all(orderedBookingsSql, [viewingSessionId])).map(b => b.id);
    const currentIndex = allBookingIds.indexOf(bookingId);

    const previousId = currentIndex > 0 ? allBookingIds[currentIndex - 1] : null;
    const nextId = currentIndex < allBookingIds.length - 1 ? allBookingIds[currentIndex + 1] : null;
    // --- End Logic for Next/Back buttons ---

    // Fetch booking, client, and space details
    const bookingSql = `
      SELECT b.*, c.name as client_name, s.name as space_name, s.type as space_type
      FROM bookings b
      JOIN clients c ON b.client_id = c.id
      JOIN spaces s ON b.space_id = s.id
      WHERE b.id = ? AND b.event_session_id = ?
    `;
    const booking = await get(bookingSql, [bookingId, viewingSessionId]);

    if (!booking) {
      return res.status(404).send('Booking not found.');
    }

    // Fetch related material issues
    const materials = await all('SELECT * FROM material_issues WHERE client_id = ? AND event_session_id = ?', [booking.client_id, viewingSessionId]);

    // Fetch related electric bills and parse items
    const electricBills = await all('SELECT * FROM electric_bills WHERE booking_id = ? AND event_session_id = ?', [bookingId, viewingSessionId]);
    electricBills.forEach(bill => {
      try {
        let items = JSON.parse(bill.items_json || '[]');
        // Handle double-stringified JSON
        if (typeof items === 'string') {
          items = JSON.parse(items);
        }
        bill.items = items;
      } catch (e) { bill.items = []; }
    });

    // Fetch related shed allocations
    const shedAllocations = await all('SELECT sa.id, s.name as shed_name, s.rent, sa.allocation_date FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ? AND sa.event_session_id = ?', [bookingId, viewingSessionId]);

    // Fetch related payments and determine type
    const paymentsRaw = await all('SELECT * FROM payments WHERE booking_id = ? AND event_session_id = ? ORDER BY payment_date DESC', [bookingId, viewingSessionId]);
    booking.payments = paymentsRaw.map(p => {
      let type = 'Unknown';
      let amount = 0;
      if (p.rent_paid > 0) { type = 'Rent'; amount = p.rent_paid; }
      else if (p.electric_paid > 0) { type = 'Electric'; amount = p.electric_paid; }
      else if (p.material_paid > 0) { type = 'Material'; amount = p.material_paid; }
      else if (p.shed_paid > 0) { type = 'Shed'; amount = p.shed_paid; }
      return {
        id: p.id,
        payment_date: p.payment_date,
        receipt_number: p.receipt_number,
        type,
        amount
      };
    });


    // --- Detailed Financial Calculations ---

    // 1. Calculate total charges for each category
    const rentCharged = (booking.rent_amount || 0);
    const electricCharged = electricBills.reduce((sum, bill) => sum + (bill.total_amount || 0), 0);
    const materialCharged = materials.reduce((sum, issue) => sum + (issue.total_payable || 0), 0);
    const shedRentFromAllocation = (await get('SELECT SUM(s.rent) as total FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ? AND sa.event_session_id = ?', [bookingId, viewingSessionId]))?.total || 0;
    const shedCharged = shedRentFromAllocation;
    
    // 2. Calculate total payments for each category (using the raw query result)
    const payments = await get('SELECT SUM(rent_paid) as rent, SUM(electric_paid) as electric, SUM(material_paid) as material, SUM(shed_paid) as shed FROM payments WHERE booking_id = ? AND event_session_id = ?', [bookingId, viewingSessionId]);
    const rentPaid = (payments?.rent || 0) + (booking.advance_amount || 0); // Include advance in rent paid
    const electricPaid = payments?.electric || 0;
    const materialPaid = payments?.material || 0;
    const shedPaid = payments?.shed || 0;

    // 3. Attach financial summary to booking object
    booking.financials = {
      rent: { charged: rentCharged, paid: rentPaid, due: rentCharged - (booking.discount || 0) - rentPaid },
      electric: { charged: electricCharged, paid: electricPaid, due: electricCharged - electricPaid },
      material: { charged: materialCharged, paid: materialPaid, due: materialCharged - materialPaid },
      shed: { charged: shedCharged, paid: shedPaid, due: shedCharged - shedPaid }
    };

    // Fetch count of issued materials for the link
    const issuedMaterialCount = (await get('SELECT COUNT(id) as count FROM material_stock WHERE issued_to_client_id = ? AND status = ?', [booking.client_id, 'Issued']))?.count || 0;

    res.render('bookingDetailsFull', {
      title: `Details for Booking #${booking.id}`,
      booking,
      materials,
      electricBills,
      shedAllocations,
      previousId,
      nextId,
      issuedMaterialCount
    });

  } catch (err) {
    console.error('Error fetching full booking details:', err.message);
    res.status(500).send('Error loading booking details.');
  }
});

// GET: Redirect from a space ID to its latest booking's full detail page
router.get('/details-full-by-space/:space_id', async (req, res) => {
  const spaceId = req.params.space_id;
  const viewingSessionId = res.locals.viewingSession.id;
  try {
    const booking = await get("SELECT id FROM bookings WHERE space_id = ? AND event_session_id = ? AND booking_status = 'active' ORDER BY booking_date DESC LIMIT 1", [spaceId, viewingSessionId]);
    if (booking) {
      res.redirect(`/booking/details-full/${booking.id}`);
    } else {
      // If no booking, maybe redirect to the space booking page or show a message
      req.app.locals.message = 'This space is available and has no booking history.';
      res.redirect(`/booking/add?space_id=${spaceId}`);
    }
  } catch (err) {
    res.status(500).send('Error finding booking for this space.');
  }
});

// GET: Show form to edit a booking
router.get('/edit/:id', async (req, res) => {
  try {
    const booking = await get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!booking) {
      return res.status(404).send('Booking not found.');
    }
    res.render('editBooking', { title: 'Edit Booking', booking });
  } catch (err) {
    res.status(500).send('Error loading booking for editing.');
  }
});

// POST: Update a booking
router.post('/edit/:id', async (req, res) => {
  const bookingId = req.params.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot edit data in an archived session.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }

  const { exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, rent_amount, discount, advance_amount, due_amount, form_submitted } = req.body;

  if (!exhibitor_name || !contact_person || !contact_number) {
    return res.status(400).send('Missing required fields: exhibitor name, contact person, and contact number are required.');
  }

  // If user is an admin, update directly
  if (req.session.user && req.session.user.role === 'admin') {
    const formSubmittedStatus = form_submitted ? 1 : 0;
    const sql = `UPDATE bookings SET exhibitor_name = ?, facia_name = ?, product_category = ?, contact_person = ?, full_address = ?, contact_number = ?, secondary_number = ?, id_proof = ?, rent_amount = ?, discount = ?, advance_amount = ?, due_amount = ?, form_submitted = ? WHERE id = ?`;
    const params = [exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, rent_amount, discount, advance_amount, due_amount, formSubmittedStatus, bookingId];
    try {
      await run(sql, params);
      res.redirect('/booking/list?message=Booking updated successfully.');
    } catch (err) {
      console.error('Error updating booking:', err.message);
      res.status(500).send('Failed to update booking.');
    }
  } else {
    // If user is not an admin, submit for approval
    try {
      const proposed_data = JSON.stringify(req.body);
      const sql = `INSERT INTO booking_edits (booking_id, user_id, username, proposed_data, request_date) VALUES (?, ?, ?, ?, datetime('now'))`;
      await run(sql, [bookingId, req.session.user.id, req.session.user.username, proposed_data]);
      res.redirect('/booking/list?message=Edit submitted for approval.');
    } catch (err) {
      console.error('Error submitting booking edit for approval:', err.message);
      res.status(500).send('Failed to submit edit for approval.');
    }
  }
});

// GET: Show page to approve a pending booking edit
router.get('/approve/:edit_id', async (req, res) => {
  // Ensure user is admin
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Access Denied.');
  }

  const editId = req.params.edit_id;
  try {
    const editRequest = await get('SELECT * FROM booking_edits WHERE id = ? AND status = "pending"', [editId]);
    if (!editRequest) {
      return res.status(404).send('Edit request not found or already processed.');
    }

    const currentBooking = await get('SELECT * FROM bookings WHERE id = ?', [editRequest.booking_id]);
    const proposedData = JSON.parse(editRequest.proposed_data);

    res.render('approveBookingEdit', {
      title: 'Approve Booking Edit',
      editRequest,
      currentBooking,
      proposedData
    });
  } catch (err) {
    console.error('Error loading approval page:', err.message);
    res.status(500).send('Error loading approval page.');
  }
});

// POST: Approve a pending edit
router.post('/approve/:edit_id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Access Denied.');
  }
  const editId = req.params.edit_id;
  try {
    const editRequest = await get('SELECT * FROM booking_edits WHERE id = ?', [editId]);
    const proposedData = JSON.parse(editRequest.proposed_data);
    const { exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, rent_amount, discount, advance_amount, due_amount, form_submitted } = proposedData;
    const formSubmittedStatus = form_submitted ? 1 : 0;

    const sql = `UPDATE bookings SET exhibitor_name = ?, facia_name = ?, product_category = ?, contact_person = ?, full_address = ?, contact_number = ?, secondary_number = ?, id_proof = ?, rent_amount = ?, discount = ?, advance_amount = ?, due_amount = ?, form_submitted = ? WHERE id = ?`;
    const params = [exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, rent_amount, discount, advance_amount, due_amount, formSubmittedStatus, editRequest.booking_id];
    
    await run(sql, params);
    await run(`UPDATE booking_edits SET status = 'approved' WHERE id = ?`, [editId]);

    res.redirect('/dashboard?message=Edit approved and applied.');
  } catch (err) {
    console.error('Error approving edit:', err.message);
    res.status(500).send('Failed to approve edit.');
  }
});

// POST: Reject a pending edit
router.post('/reject/:edit_id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Access Denied.');
  }
  const editId = req.params.edit_id;
  const { rejection_reason } = req.body;
  await run(`UPDATE booking_edits SET status = 'rejected', rejection_reason = ? WHERE id = ?`, [rejection_reason, editId]);
  res.redirect('/dashboard?message=Edit has been rejected.');
});

// GET: Rent Receipt view
router.get('/receipt/:id', async (req, res) => {
  const bookingId = req.params.id;
  const sql = `
    SELECT 
      b.*, 
      c.name AS client_name, 
      c.full_address AS client_address,
      s.name AS space_name, 
      s.size AS space_size
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN spaces s ON b.space_id = s.id 
    WHERE b.id = ?
  `;
  try {
    const booking = await get(sql, [bookingId]);
    if (!booking) {
      return res.status(404).send('Booking not found');
    }
    res.render('rentReceipt', {
      title: `Rent Receipt #${booking.id}`,
      booking: booking
    });
  } catch (err) {
    console.error('Error fetching receipt data:', err.message);
    res.status(500).send('Error generating receipt.');
  }
});

// GET: Invoice view
router.get('/invoice/:id', async (req, res) => {
  const bookingId = req.params.id;
  const sql = `
    SELECT b.*, c.name AS client_name, c.contact_number AS contact, s.name AS space_name, s.facilities
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN spaces s ON b.space_id = s.id
    WHERE b.id = ?
  `;
  try {
    const booking = await get(sql, [bookingId]);
    if (err || !booking) return res.send('Invoice not found');
    res.render('invoice', { title: `Invoice #${booking.id}`, booking }); // <-- ADDED title
  } catch (err) {
    res.send('Invoice not found');
  }
});

// POST /booking/vacate/:id - Mark a booking as cancelled and reverse charges
router.post('/vacate/:id', async (req, res) => {
  const bookingId = req.params.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot cancel a booking in an archived session.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }

  // Use a transaction to ensure atomicity
  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // 1. Get the booking to ensure it's active
      const booking = await get("SELECT id, client_id, rent_amount, discount, booking_status FROM bookings WHERE id = ?", [bookingId]);
      if (!booking || booking.booking_status !== 'active') {
        db.run('ROLLBACK');
        req.session.flash = { type: 'info', message: 'This booking is not active and cannot be cancelled.' };
        return res.redirect(`/booking/details-full/${bookingId}`);
      }

      // 2. Delete associated charge records
      await run('DELETE FROM electric_bills WHERE booking_id = ?', [bookingId]);
      // Note: Material issues are linked to client_id, this will delete all for that client in the session.
      // This is based on the previous logic. If a client can have multiple bookings, this might need refinement.
      await run('DELETE FROM material_issues WHERE client_id = ? AND event_session_id = ?', [booking.client_id, res.locals.activeSession.id]);
      await run('DELETE FROM shed_allocations WHERE booking_id = ?', [bookingId]);
      await run('DELETE FROM shed_bills WHERE booking_id = ?', [bookingId]);

      // 3. Update the booking status and reverse the charges from its due amount
      // We set due_amount to 0 to clear any remaining rent/discount balance as well.
      await run("UPDATE bookings SET booking_status = 'cancelled', vacated_date = date('now'), due_amount = 0 WHERE id = ?", [bookingId]);

      db.run('COMMIT');
      req.session.flash = { type: 'success', message: 'Booking has been cancelled, charges reversed, and space is now available.' };
      res.redirect(`/booking/details-full/${bookingId}`);
    } catch (err) {
      db.run('ROLLBACK');
      console.error('Error cancelling booking:', err);
      req.session.flash = { type: 'danger', message: 'Failed to cancel the booking due to a server error.' };
      res.redirect(`/booking/details-full/${bookingId}`);
    }
  });
});

// GET: Delete booking
router.get('/delete/:id', async (req, res) => {
  const bookingId = req.params.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot delete data from an archived session.' };
    return res.redirect('/booking/list');
  }

  try {
    // Find the space_id before deleting the booking
    const booking = await get('SELECT space_id FROM bookings WHERE id = ?', [bookingId]);
    if (!booking) return res.status(404).send('Booking not found');

    // Use a transaction to ensure both operations succeed or fail together
    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');
      await run('DELETE FROM bookings WHERE id = ?', [bookingId]);
      db.run('COMMIT');
      res.redirect('/booking/list');
    });
  } catch (err) {
    console.error("Error deleting booking:", err.message);
    db.run('ROLLBACK');
    res.status(500).send('Error deleting booking.');
  }
});

// GET: Report of all cancelled/vacated bookings for the session
router.get('/report/cancelled', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;

    const cancelledBookings = await all(`
      SELECT
        b.id,
        b.exhibitor_name,
        s.name AS space_name,
        b.vacated_date,
        b.rent_amount AS rent_charged,
        b.discount,
        (b.advance_amount + COALESCE(p.total_rent_paid, 0)) AS rent_paid,
        COALESCE(p.total_electric_paid, 0) AS electric_paid,
        COALESCE(p.total_material_paid, 0) AS material_paid,
        COALESCE(p.total_shed_paid, 0) AS shed_paid
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      LEFT JOIN (
        SELECT 
          booking_id,
          SUM(rent_paid) as total_rent_paid,
          SUM(electric_paid) as total_electric_paid,
          SUM(material_paid) as total_material_paid,
          SUM(shed_paid) as total_shed_paid
        FROM payments
        GROUP BY booking_id
      ) p ON b.id = p.booking_id
      WHERE b.event_session_id = ? AND b.booking_status IN ('cancelled', 'vacated')
      ORDER BY b.vacated_date DESC
    `, [viewingSessionId]);

    res.render('cancelledBookingsReport', {
      title: 'Cancelled & Vacated Bookings',
      bookings: cancelledBookings
    });
  } catch (err) {
    console.error('Error fetching cancelled bookings report:', err.message);
    res.status(500).send('Failed to generate report.');
  }
});

module.exports = router;