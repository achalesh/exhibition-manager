const express = require('express');
const router = express.Router();
const { db, all, get, run } = require('../db-helpers');

// GET: Show unified booking form, load ALL spaces
router.get('/add', async (req, res) => {
  try {
    // Fetch spaces and suggestion data in parallel
    const [spaces, exhibitors, productCategories, faciaNames] = await Promise.all([
      all('SELECT * FROM spaces ORDER BY type, name'),
      all('SELECT DISTINCT name FROM clients ORDER BY name'),
      all('SELECT DISTINCT product_category FROM bookings WHERE product_category IS NOT NULL ORDER BY product_category'),
      all('SELECT DISTINCT facia_name FROM bookings WHERE facia_name IS NOT NULL ORDER BY facia_name')
    ]);

    res.render('bookSpace', {
      title: 'Book a Space',
      spaces: spaces || [],
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
    SELECT * FROM bookings WHERE space_id = ? ORDER BY booking_date DESC LIMIT 1
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

  const formSubmittedStatus = form_submitted ? 1 : 0;
  if (!space_id || !exhibitor_name || !contact_person || !contact_number) { // Basic validation
    return res.status(400).send('Missing required fields: space, exhibitor name, contact person, and contact number are required.');
  }

  // Use a transaction to ensure all or nothing is saved
  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // Step 1: Create client
      const clientSql = `INSERT INTO clients (name, contact_person, contact_number, full_address) VALUES (?, ?, ?, ?)`;
      const clientParams = [exhibitor_name, contact_person, contact_number, full_address];
      const { lastID: clientId } = await run(clientSql, clientParams);

      // Step 2: Create booking
      const bookingSql = `
        INSERT INTO bookings (
          space_id, client_id, booking_date, exhibitor_name, facia_name, product_category,
          contact_person, full_address, contact_number, secondary_number, id_proof,
          rent_amount, discount, advance_amount, due_amount, form_submitted
        ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const bookingParams = [space_id, clientId, exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, rent_amount, discount, advance_amount, due_amount, formSubmittedStatus];
      const { lastID: bookingId } = await run(bookingSql, bookingParams);

      // Step 3: Update space status
      await run('UPDATE spaces SET status = "Booked" WHERE id = ?', [space_id]);

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
  const filter = req.query.form_status || 'all';
  let whereClause = '';
  if (filter === 'submitted') {
    whereClause = 'WHERE b.form_submitted = 1';
  } else if (filter === 'not_submitted') {
    whereClause = 'WHERE b.form_submitted = 0';
  }

  const sql = `
    SELECT b.id, b.exhibitor_name AS client_name, b.facia_name, s.name AS space_name, s.size as space_size, s.type as space_type,
           b.rent_amount, b.discount, b.due_amount, b.form_submitted
    FROM bookings b
    JOIN spaces s ON b.space_id = s.id
    ${whereClause}
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
    const bookings = await all(sql);
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
  try {
    // --- Logic for Next/Back buttons ---
    const orderedBookingsSql = `
      SELECT b.id
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY
        CASE s.type
          WHEN 'Pavilion' THEN 1
          WHEN 'Stall' THEN 2
          WHEN 'Booth' THEN 3
          ELSE 4
        END,
        s.name
    `;
    const allBookingIds = (await all(orderedBookingsSql)).map(b => b.id);
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
      WHERE b.id = ?
    `;
    const booking = await get(bookingSql, [bookingId]);

    if (!booking) {
      return res.status(404).send('Booking not found.');
    }

    // Fetch related material issues
    const materials = await all('SELECT * FROM material_issues WHERE client_id = ?', [booking.client_id]);

    // Fetch related electric bills and parse items
    const electricBills = await all('SELECT * FROM electric_bills WHERE booking_id = ?', [bookingId]);
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
    const shedAllocations = await all('SELECT sa.id, s.name as shed_name, s.rent, sa.allocation_date FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ?', [bookingId]);

    // Fetch related payments and determine type
    const paymentsRaw = await all('SELECT * FROM payments WHERE booking_id = ? ORDER BY payment_date DESC', [bookingId]);
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
    const shedRentFromAllocation = (await get('SELECT SUM(s.rent) as total FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ?', [bookingId]))?.total || 0;
    const shedCharged = shedRentFromAllocation;
    
    // 2. Calculate total payments for each category (using the raw query result)
    const payments = await get('SELECT SUM(rent_paid) as rent, SUM(electric_paid) as electric, SUM(material_paid) as material, SUM(shed_paid) as shed FROM payments WHERE booking_id = ?', [bookingId]);
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

    res.render('bookingDetailsFull', {
      title: `Details for Booking #${booking.id}`,
      booking,
      materials,
      electricBills,
      shedAllocations,
      previousId,
      nextId
    });

  } catch (err) {
    console.error('Error fetching full booking details:', err.message);
    res.status(500).send('Error loading booking details.');
  }
});

// GET: Redirect from a space ID to its latest booking's full detail page
router.get('/details-full-by-space/:space_id', async (req, res) => {
  const spaceId = req.params.space_id;
  try {
    const booking = await get('SELECT id FROM bookings WHERE space_id = ? ORDER BY booking_date DESC LIMIT 1', [spaceId]);
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

// GET: Delete booking
router.get('/delete/:id', async (req, res) => {
  const bookingId = req.params.id;
  try {
    // Find the space_id before deleting the booking
    const booking = await get('SELECT space_id FROM bookings WHERE id = ?', [bookingId]);
    if (!booking) return res.status(404).send('Booking not found');

    // Use a transaction to ensure both operations succeed or fail together
    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');
      await run('DELETE FROM bookings WHERE id = ?', [bookingId]);
      await run('UPDATE spaces SET status = "Available" WHERE id = ?', [booking.space_id]);
      db.run('COMMIT');
      res.redirect('/booking/list');
    });
  } catch (err) {
    console.error("Error deleting booking:", err.message);
    db.run('ROLLBACK');
    res.status(500).send('Error deleting booking.');
  }
});

module.exports = router;