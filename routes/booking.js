const express = require('express');
const router = express.Router();
const { db, all, get, run } = require('../db-helpers');

// GET: Show unified booking form, load ALL spaces
router.get('/add', async (req, res) => {
  try {
    // Fetch suggestion data in parallel
    const [exhibitors, productCategories, faciaNames] = await Promise.all([
      all('SELECT DISTINCT name FROM clients ORDER BY name'),
      all('SELECT DISTINCT product_category FROM bookings WHERE product_category IS NOT NULL ORDER BY product_category'),
      all('SELECT DISTINCT facia_name FROM bookings WHERE facia_name IS NOT NULL ORDER BY facia_name')
    ]);

    // This form is now for registering an exhibitor, not booking a specific space.
    res.render('registerExhibitor', {
      title: 'Register New Exhibitor',
      suggestions: {
        exhibitors: exhibitors.map(e => e.name),
        productCategories: productCategories.map(pc => pc.product_category),
        faciaNames: faciaNames.map(fn => fn.facia_name)
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading registration page');
  }
});

// POST: Save booking
router.post('/add', async (req, res) => {
  const {
    exhibitor_name, facia_name, product_category,
    contact_person, full_address, contact_number, secondary_number,
    id_proof, advance_amount, form_submitted
  } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add bookings to an archived session. Please switch to the active session.' };
    return res.redirect('/booking/list');
  }

  const activeSessionId = res.locals.activeSession.id;

  const formSubmittedStatus = form_submitted ? 1 : 0;
  if (!exhibitor_name || !contact_person || !contact_number) { // Basic validation
    req.session.flash = { type: 'danger', message: 'Exhibitor Name, Contact Person, and Contact Number are required.' };
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
          client_id, booking_date, exhibitor_name, facia_name, product_category,
          contact_person, full_address, contact_number, secondary_number, id_proof, event_session_id,
          rent_amount, discount, advance_amount, due_amount, form_submitted, booking_status
        ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, 'unallocated')
      `;
      const bookingParams = [clientId, exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, activeSessionId, advance_amount || 0, formSubmittedStatus];
      await run(bookingSql, bookingParams);

      db.run('COMMIT');
      req.session.flash = { type: 'success', message: `Exhibitor "${exhibitor_name}" has been registered and is awaiting space allocation.` };
      res.redirect('/booking/list');

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
  const { form_status = 'all', q, booking_status = 'all' } = req.query;
  const whereClauses = ['b.event_session_id = ?'];
  const params = [viewingSessionId];

  if (q) {
    whereClauses.push('(b.exhibitor_name LIKE ? OR b.facia_name LIKE ? OR s.space_name LIKE ? OR b.id LIKE ?)');
    const searchTerm = `%${q}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  if (form_status === 'submitted') {
    whereClauses.push('b.form_submitted = 1');
  } else if (form_status === 'not_submitted') {
    whereClauses.push('b.form_submitted = 0');
  }

  if (booking_status && booking_status !== 'all') {
    whereClauses.push('b.booking_status = ?');
    params.push(booking_status);
  }

  // Simplified query to fetch booking list without calculating due amounts.
  const sql = `
    SELECT
      b.id, b.booking_status,
      b.exhibitor_name AS client_name,
      b.facia_name,
      b.contact_number,
      b.secondary_number,
      GROUP_CONCAT(s.name, ', ') AS space_name,
      GROUP_CONCAT(s.size, ', ') as space_size,
      GROUP_CONCAT(s.type, ', ') as space_type,
      b.form_submitted
    FROM bookings b
    LEFT JOIN booking_spaces bs ON b.id = bs.booking_id
    LEFT JOIN spaces s ON bs.space_id = s.id
    WHERE ${whereClauses.join(' AND ')}
    GROUP BY b.id
    ORDER BY b.id DESC
  `;
  try {
    const bookings = await all(sql, params);
    res.render('bookings', { 
      title: 'View Bookings', 
      bookings,
      filters: { 
        q: q || '',
        form_status,
        booking_status
      },
      message: req.query.message 
    });
  } catch (err) {
    console.error("Error fetching bookings:", err.message);
    const filters = { q: q || '', form_status, booking_status };
    res.render('bookings', { title: 'View Bookings', bookings: [], filters, message: null });
  }
});

// GET: Show booking confirmation page
router.get('/confirmation/:id', async (req, res) => {
  const bookingId = req.params.id;
  const sql = `
    SELECT b.id, b.exhibitor_name, b.rent_amount, b.due_amount, s.name AS space_name, s.type as space_type
    FROM bookings b
    LEFT JOIN booking_spaces bs ON b.id = bs.booking_id LEFT JOIN spaces s ON bs.space_id = s.id
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
      LEFT JOIN booking_spaces bs ON b.id = bs.booking_id
      LEFT JOIN spaces s ON bs.space_id = s.id
      WHERE b.event_session_id = ? AND b.booking_status <> 'cancelled'
      GROUP BY b.id
      ORDER BY
        CASE WHEN MIN(s.id) IS NULL THEN 1 ELSE 0 END,
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
      SELECT b.*, c.name as client_name, s.space_name, s.space_type
      FROM bookings b
      JOIN clients c ON b.client_id = c.id
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name, GROUP_CONCAT(s.type, ', ') as space_type FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s ON b.id = s.booking_id
      WHERE b.id = ? AND b.event_session_id = ?
    `;
    const booking = await get(bookingSql, [bookingId, viewingSessionId]);

    if (!booking) {
      return res.status(404).send('Booking not found.');
    }

    // Check if this booking was re-booked from a previous one
    let rebookedFromInfo = null;
    if (booking.rebooked_from_booking_id) {
      rebookedFromInfo = await get(`
        SELECT b.id as original_booking_id, es.name as session_name, b.event_session_id as original_session_id
        FROM bookings b
        JOIN event_sessions es ON b.event_session_id = es.id
        WHERE b.id = ?
      `, [booking.rebooked_from_booking_id]);
    }


    // If the booking is unallocated, fetch available spaces for the allocation form
    let availableSpaces = [];
    if (booking.booking_status === 'unallocated') {
      availableSpaces = await all(`
        SELECT id, name, type, rent_amount 
        FROM spaces 
        WHERE is_active = 1 AND id NOT IN (
          SELECT bs.space_id FROM booking_spaces bs JOIN bookings b ON bs.booking_id = b.id WHERE b.event_session_id = ? AND b.booking_status = 'active' AND bs.space_id IS NOT NULL
        )
        ORDER BY type, name`, [viewingSessionId]);
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
        amount,
        remarks: p.remarks
      };
    });


    // --- Detailed Financial Calculations ---
    const financialSummarySql = `
      SELECT
        -- Rent
        (b.rent_amount - COALESCE(b.discount, 0)) as rent_charged,
        (COALESCE(p.total_rent_paid, 0) + COALESCE(b.advance_amount, 0)) as rent_paid,
        -- Electric
        COALESCE(eb.total_electric_charge, 0) as electric_charged,
        COALESCE(p.total_electric_paid, 0) as electric_paid,
        -- Material
        COALESCE(mi.total_material_charge, 0) as material_charged,
        COALESCE(p.total_material_paid, 0) as material_paid,
        -- Shed
        COALESCE(sh.total_shed_charge, 0) as shed_charged,
        COALESCE(p.total_shed_paid, 0) as shed_paid,
        -- Write Offs
        COALESCE(wo.total_write_offs, 0) as write_offs
      FROM bookings b
      LEFT JOIN (
        SELECT booking_id, SUM(rent_paid) as total_rent_paid, SUM(electric_paid) as total_electric_paid, SUM(material_paid) as total_material_paid, SUM(shed_paid) as total_shed_paid
        FROM payments WHERE booking_id = ? AND event_session_id = ? GROUP BY booking_id
      ) p ON b.id = p.booking_id
      LEFT JOIN (SELECT booking_id, SUM(total_amount) as total_electric_charge FROM electric_bills WHERE booking_id = ? AND event_session_id = ? GROUP BY booking_id) eb ON b.id = eb.booking_id
      LEFT JOIN (SELECT client_id, SUM(total_payable) as total_material_charge FROM material_issues WHERE client_id = ? AND event_session_id = ? GROUP BY client_id) mi ON b.client_id = mi.client_id
      LEFT JOIN (SELECT booking_id, SUM(rent) as total_shed_charge FROM (SELECT sa.booking_id, s.rent FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = ? AND sa.event_session_id = ? UNION ALL SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb WHERE sb.booking_id = ? AND sb.event_session_id = ?) GROUP BY booking_id) sh ON b.id = sh.booking_id
      LEFT JOIN (SELECT booking_id, SUM(amount) as total_write_offs FROM write_offs WHERE booking_id = ? AND event_session_id = ? GROUP BY booking_id) wo ON b.id = wo.booking_id
      WHERE b.id = ?
    `;
    const financialParams = [bookingId, viewingSessionId, bookingId, viewingSessionId, booking.client_id, viewingSessionId, bookingId, viewingSessionId, bookingId, viewingSessionId, bookingId, viewingSessionId, bookingId];
    const financials = await get(financialSummarySql, financialParams);

    // 3. Attach financial summary to booking object
    booking.financials = {
      rent: { charged: financials.rent_charged, paid: financials.rent_paid, due: financials.rent_charged - (booking.discount || 0) - financials.rent_paid },
      electric: { charged: financials.electric_charged, paid: financials.electric_paid, due: financials.electric_charged - financials.electric_paid },
      material: { charged: financials.material_charged, paid: financials.material_paid, due: financials.material_charged - financials.material_paid },
      shed: { charged: financials.shed_charged, paid: financials.shed_paid, due: financials.shed_charged - financials.shed_paid },
      write_offs: { amount: financials.write_offs }
    };

    // Fetch count of issued materials for the link
    const issuedMaterialCount = (await get('SELECT COUNT(id) as count FROM material_stock WHERE issued_to_client_id = ? AND status = ?', [booking.client_id, 'Issued']))?.count || 0;

    res.render('bookingDetailsFull', {
      title: `Details for Booking #${booking.id}`,
      booking,
      materials,
      electricBills,
      availableSpaces,
      shedAllocations,
      previousId,
      nextId,
      issuedMaterialCount,
      rebookedFromInfo
    });

    // After rendering, mark any user notifications as read
    if (rebookedFromInfo) {
      await run(
        'UPDATE bookings SET rebooked_from_booking_id = NULL WHERE id = ? AND rebooked_from_booking_id IS NOT NULL',
        [bookingId]
      );
    }
  } catch (err) {
    console.error('Error fetching full booking details:', err.message);
    res.status(500).send('Error loading booking details.');
  }
});

// POST /booking/allocate/:id - Allocate a space to an unallocated booking
router.post('/allocate/:id', async (req, res) => {
  const bookingId = req.params.id;
  let { space_ids, discount } = req.body;
  const activeSessionId = res.locals.activeSession.id;

  if (res.locals.viewingSession.id !== activeSessionId) {
    req.session.flash = { type: 'warning', message: 'Cannot allocate spaces in an archived session.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }

  // Ensure space_ids is an array
  if (!space_ids) {
    req.session.flash = { type: 'danger', message: 'You must select a space to allocate.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }
  if (!Array.isArray(space_ids)) {
    space_ids = [space_ids];
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      let totalRent = 0;
      for (const spaceId of space_ids) {
        // Concurrency check: Make sure each space is still available
        const existingAllocation = await get("SELECT bs.id FROM booking_spaces bs JOIN bookings b ON bs.booking_id = b.id WHERE bs.space_id = ? AND b.event_session_id = ? AND b.booking_status = 'active'", [spaceId, activeSessionId]);
        if (existingAllocation) {
          throw new Error(`Space ID ${spaceId} was just booked by someone else. Please try again.`);
        }

        // Add to new booking_spaces table
        await run('INSERT INTO booking_spaces (booking_id, space_id) VALUES (?, ?)', [bookingId, spaceId]);

        // Add rent to total
        const space = await get('SELECT rent_amount FROM spaces WHERE id = ?', [spaceId]);
        totalRent += space.rent_amount || 0;
      }

      const booking = await get('SELECT advance_amount FROM bookings WHERE id = ?', [bookingId]);

      const discountAmount = parseFloat(discount) || 0;
      const advanceAmount = booking.advance_amount || 0;
      const dueAmount = totalRent - discountAmount - advanceAmount;

      await run(
        "UPDATE bookings SET rent_amount = ?, discount = ?, due_amount = ?, booking_status = 'active' WHERE id = ?",
        [totalRent, discountAmount, dueAmount, bookingId]
      );

      db.run('COMMIT');
      req.session.flash = { type: 'success', message: 'Space allocated successfully!' };
      res.redirect(`/booking/details-full/${bookingId}`);
    } catch (err) {
      db.run('ROLLBACK');
      req.session.flash = { type: 'danger', message: err.message || 'Failed to allocate space due to a server error.' };
      res.redirect(`/booking/details-full/${bookingId}`);
    }
  });
});

// POST /booking/deallocate-space/:booking_id/:space_id - De-allocate a single space from a multi-space booking
router.post('/deallocate-space/:booking_id/:space_id', async (req, res) => {
  const { booking_id, space_id } = req.params;
  const activeSessionId = res.locals.activeSession.id;

  if (res.locals.viewingSession.id !== activeSessionId) {
    req.session.flash = { type: 'warning', message: 'Cannot de-allocate spaces in an archived session.' };
    return res.redirect(`/booking/details-full/${booking_id}`);
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      // 1. Check how many spaces are currently allocated
      const allocatedSpaces = await all('SELECT space_id FROM booking_spaces WHERE booking_id = ?', [booking_id]);
      if (allocatedSpaces.length <= 1) {
        throw new Error('Cannot de-allocate the last space. Use the "De-allocate All" button instead.');
      }

      // 2. Get the rent of the space being removed
      const spaceToDeallocate = await get('SELECT rent_amount FROM spaces WHERE id = ?', [space_id]);
      if (!spaceToDeallocate) {
        throw new Error('The space you are trying to de-allocate does not exist.');
      }
      const rentToSubtract = spaceToDeallocate.rent_amount || 0;

      // 3. Get current booking financials
      const booking = await get('SELECT rent_amount, discount, due_amount FROM bookings WHERE id = ?', [booking_id]);

      // 4. Remove the specific space from the booking
      const result = await run('DELETE FROM booking_spaces WHERE booking_id = ? AND space_id = ?', [booking_id, space_id]);
      if (result.changes === 0) {
        throw new Error('Space was not allocated to this booking.');
      }

      // 5. Update the booking's financials
      // When a space is removed, we also remove any existing discount.
      const existingDiscount = booking.discount || 0;
      const newRentAmount = (booking.rent_amount || 0) - rentToSubtract;
      // The due amount is reduced by the rent of the removed space, but increased by the removed discount.
      const newDueAmount = (booking.due_amount || 0) - rentToSubtract + existingDiscount;

      await run(
        'UPDATE bookings SET rent_amount = ?, discount = 0, due_amount = ? WHERE id = ?',
        [newRentAmount, newDueAmount, booking_id]
      );

      db.run('COMMIT');
      req.session.flash = { type: 'success', message: 'One space has been de-allocated successfully.' };
      res.redirect(`/booking/details-full/${booking_id}`);
    } catch (err) {
      db.run('ROLLBACK');
      req.session.flash = { type: 'danger', message: err.message || 'Failed to de-allocate space due to a server error.' };
      res.redirect(`/booking/details-full/${booking_id}`);
    }
  });
});

// POST /booking/deallocate/:id - De-allocate a space from a booking, reverting it to 'unallocated' status
router.post('/deallocate/:id', async (req, res) => {
  const bookingId = req.params.id;
  const activeSessionId = res.locals.activeSession.id;

  if (res.locals.viewingSession.id !== activeSessionId) {
    req.session.flash = { type: 'warning', message: 'Cannot de-allocate spaces in an archived session.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');

      const booking = await get("SELECT advance_amount, booking_status FROM bookings WHERE id = ?", [bookingId]);
      if (!booking || booking.booking_status !== 'active') {
        throw new Error('This booking is not active and cannot be de-allocated.');
      }

      // Calculate the new due amount. It will be negative if an advance was paid.
      const advanceAmount = booking.advance_amount || 0;
      const newDueAmount = 0 - advanceAmount;

      await run("UPDATE bookings SET rent_amount = 0, discount = 0, due_amount = ?, booking_status = 'unallocated' WHERE id = ?", [newDueAmount, bookingId]);
      await run("DELETE FROM booking_spaces WHERE booking_id = ?", [bookingId]);

      db.run('COMMIT');
      req.session.flash = { type: 'success', message: 'Space de-allocated successfully. The exhibitor is now awaiting a new space.' };
      res.redirect(`/booking/details-full/${bookingId}`);
    } catch (err) {
      db.run('ROLLBACK');
      req.session.flash = { type: 'danger', message: err.message || 'Failed to de-allocate space due to a server error.' };
      res.redirect(`/booking/details-full/${bookingId}`);
    }
  });
});

// GET: Show page to re-book an exhibitor for a new session
router.get('/rebook/:id', async (req, res) => {
  const bookingId = req.params.id;
  const currentSessionId = res.locals.viewingSession.id;

  try {
    const booking = await get(`
      SELECT b.id, b.client_id, b.exhibitor_name, b.facia_name, b.product_category, b.contact_person, b.full_address, b.contact_number, b.secondary_number, b.id_proof, b.form_submitted
      FROM bookings b
      WHERE b.id = ?
    `, [bookingId]);

    if (!booking) {
      req.session.flash = { type: 'danger', message: 'Booking not found.' };
      return res.redirect('/booking/list');
    }

    // Get all sessions except the one this booking is currently in
    const sessionsData = await all('SELECT id, name, is_active FROM event_sessions WHERE id != ? ORDER BY start_date DESC', [currentSessionId]);

    const sessions = sessionsData.map(s => ({
      ...s,
      status: s.is_active ? 'Active' : 'Archived'
    }));

    res.render('rebookExhibitor', {
      title: `Re-book ${booking.exhibitor_name}`,
      booking,
      sessions
    });
  } catch (err) {
    console.error('Error loading re-book page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Process the re-booking of an exhibitor to a new session
router.post('/rebook/:id', async (req, res) => {
  const originalBookingId = req.params.id;
  const { target_session_id } = req.body;

  if (!target_session_id) {
    req.session.flash = { type: 'danger', message: 'You must select a target session.' };
    return res.redirect(`/booking/rebook/${originalBookingId}`);
  }

  try {
    // 1. Get the original booking data to copy
    const originalBooking = await get(`
      SELECT client_id, exhibitor_name, facia_name, product_category, contact_person, full_address, contact_number, secondary_number, id_proof, form_submitted
      FROM bookings
      WHERE id = ?
    `, [originalBookingId]);

    if (!originalBooking) {
      req.session.flash = { type: 'danger', message: 'Original booking not found.' };
      return res.redirect('/booking/list');
    }

    // 2. Check if a booking for this client already exists in the target session to prevent duplicates
    const existingBookingInNewSession = await get(
      'SELECT id FROM bookings WHERE client_id = ? AND event_session_id = ?',
      [originalBooking.client_id, target_session_id]
    );

    if (existingBookingInNewSession) {
      req.session.flash = { type: 'warning', message: `This exhibitor already has a booking (ID: ${existingBookingInNewSession.id}) in the selected session.` };
      return res.redirect(`/booking/details-full/${existingBookingInNewSession.id}?view_session_id=${target_session_id}`);
    }

    // 3. Create the new booking record in the target session
    const newBookingSql = `
      INSERT INTO bookings (
        client_id, booking_date, exhibitor_name, facia_name, product_category,
        contact_person, full_address, contact_number, secondary_number, id_proof,
        event_session_id, booking_status,
        rent_amount, discount, advance_amount, due_amount, form_submitted, rebooked_from_booking_id
      ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unallocated', 0, 0, 0, 0, ?, ?)
    `;
    const params = [
      originalBooking.client_id, originalBooking.exhibitor_name, originalBooking.facia_name,
      originalBooking.product_category, originalBooking.contact_person, originalBooking.full_address,
      originalBooking.contact_number, originalBooking.secondary_number, originalBooking.id_proof,
      target_session_id, originalBooking.form_submitted, originalBookingId
    ];
    const { lastID: newBookingId } = await run(newBookingSql, params);

    req.session.flash = { type: 'success', message: `Successfully re-booked ${originalBooking.exhibitor_name} for the new session.` };
    res.redirect(`/booking/details-full/${newBookingId}?view_session_id=${target_session_id}`);
  } catch (err) {
    console.error('Error processing re-booking:', err.message);
    req.session.flash = { type: 'danger', message: 'Failed to re-book exhibitor.' };
    res.redirect(`/booking/rebook/${originalBookingId}`);
  }
});

// GET: Redirect from a space ID to its latest booking's full detail page
router.get('/details-full-by-space/:space_id', async (req, res) => {
  const spaceId = req.params.space_id;
  const viewingSessionId = res.locals.viewingSession.id;
  try {
    // Corrected query to join through booking_spaces and specify the space_id
    const booking = await get(`
      SELECT b.id 
      FROM bookings b
      JOIN booking_spaces bs ON b.id = bs.booking_id
      WHERE bs.space_id = ? AND b.event_session_id = ? AND b.booking_status = 'active' 
      ORDER BY b.booking_date DESC LIMIT 1`, [spaceId, viewingSessionId]);
    if (booking) {
      return res.redirect(`/booking/details-full/${booking.id}`);
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

// POST /booking/write-off/:id - Write off a due amount
router.post('/write-off/:id', async (req, res) => {
  const bookingId = req.params.id;
  const { amount, reason } = req.body;
  const writeOffAmount = parseFloat(amount);

  if (!writeOffAmount || writeOffAmount <= 0) {
    req.session.flash = { type: 'danger', message: 'Invalid write-off amount.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot perform write-offs in an archived session.' };
    return res.redirect(`/booking/details-full/${bookingId}`);
  }

  const activeSessionId = res.locals.activeSession.id;
  const user = req.session.user;

  db.serialize(async () => {
    try {
      db.run('BEGIN TRANSACTION');
      // 1. Record the write-off
      await run('INSERT INTO write_offs (booking_id, amount, reason, write_off_date, user_id, event_session_id) VALUES (?, ?, ?, date("now"), ?, ?)', [bookingId, writeOffAmount, reason, user.id, activeSessionId]);
      db.run('COMMIT');
      req.session.flash = { type: 'success', message: `Successfully wrote off ₹${writeOffAmount.toFixed(2)}.` };
    } catch (err) {
      db.run('ROLLBACK');
      console.error('Error processing write-off:', err);
      req.session.flash = { type: 'danger', message: 'Failed to process write-off.' };
    }
    res.redirect(`/booking/details-full/${bookingId}`);
  });
});

// GET: Rent Receipt view
router.get('/receipt/:id', async (req, res) => {
  const bookingId = req.params.id;
  const sql = `SELECT b.*, c.name AS client_name, c.full_address AS client_address, GROUP_CONCAT(s.name, ', ') AS space_name, GROUP_CONCAT(s.size, ', ') AS space_size FROM bookings b JOIN clients c ON b.client_id = c.id LEFT JOIN booking_spaces bs ON b.id = bs.booking_id LEFT JOIN spaces s ON bs.space_id = s.id WHERE b.id = ? GROUP BY b.id`;
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
  const sql = `SELECT b.*, c.name AS client_name, c.contact_number AS contact, GROUP_CONCAT(s.name, ', ') AS space_name, GROUP_CONCAT(s.facilities, '; ') as facilities FROM bookings b JOIN clients c ON b.client_id = c.id LEFT JOIN booking_spaces bs ON b.id = bs.booking_id LEFT JOIN spaces s ON bs.space_id = s.id WHERE b.id = ? GROUP BY b.id`;
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
      await run('DELETE FROM electric_bills WHERE booking_id = ? AND event_session_id = ?', [bookingId, res.locals.activeSession.id]);
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
        GROUP_CONCAT(s.name, ', ') as space_name,
        b.vacated_date,
        b.rent_amount AS rent_charged,
        b.discount,
        (b.advance_amount + COALESCE(p.total_rent_paid, 0)) AS rent_paid,
        COALESCE(p.total_electric_paid, 0) AS electric_paid,
        COALESCE(p.total_material_paid, 0) AS material_paid,
        COALESCE(p.total_shed_paid, 0) AS shed_paid
      FROM bookings b
      LEFT JOIN booking_spaces bs ON b.id = bs.booking_id LEFT JOIN spaces s ON bs.space_id = s.id
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
      GROUP BY b.id
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