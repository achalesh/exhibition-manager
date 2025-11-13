const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db-helpers');
const { isAdmin } = require('./auth');

// GET: Show form to add/manage spaces
router.get('/add', async (req, res) => {
  try {
    const { status = 'active' } = req.query;
    const viewingSessionId = res.locals.viewingSession.id;
    let sql = `
      SELECT 
        s.*,
        CASE WHEN b.id IS NOT NULL THEN 'Booked' ELSE 'Available' END as session_status
      FROM spaces s LEFT JOIN (
        SELECT b.id, bs.space_id 
        FROM bookings b 
        JOIN booking_spaces bs ON b.id = bs.booking_id 
        WHERE b.event_session_id = ? AND b.booking_status = 'active'
      ) b ON s.id = b.space_id
    `;
    const params = [viewingSessionId];

    if (status === 'active') {
      sql += ' WHERE s.is_active = 1';
    } else if (status === 'inactive') {
      sql += ' WHERE s.is_active = 0';
    }
    sql += ' ORDER BY s.type, s.name';

    const spaces = await all(sql, params);
    res.render('manageSpaces', {
      title: 'Manage Spaces',
      spaces: spaces || [],
      space: null, // For the add form
      report_url: '/space/add',
      filters: { status }
    });
  } catch (err) {
    console.error('Error loading space management page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Add a new space
router.post('/add', async (req, res) => {
  const { type, name, size, rent_amount, facilities, location } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add spaces in an archived session.' };
    return res.redirect('/space/add');
  }

  try {
    await run(
      'INSERT INTO spaces (type, name, size, rent_amount, facilities, location) VALUES (?, ?, ?, ?, ?, ?)',
      [type, name, size, rent_amount, facilities, location]
    );
    req.session.flash = { type: 'success', message: `Space '${name}' was added successfully.` };
    res.redirect('/space/add');
  } catch (err) {
    console.error('Error adding space:', err.message);
    res.status(500).send('Error saving space.');
  }
});

// GET: Show form to edit a space
router.get('/edit/:id', async (req, res) => {
  try {
    const spaceToEdit = await get('SELECT * FROM spaces WHERE id = ?', [req.params.id]);
    const viewingSessionId = res.locals.viewingSession.id;
    const allSpaces = await all(` 
      SELECT 
        s.*,
        CASE WHEN b.id IS NOT NULL THEN 'Booked' ELSE 'Available' END as session_status
      FROM spaces s LEFT JOIN (
        SELECT b.id, bs.space_id FROM bookings b JOIN booking_spaces bs ON b.id = bs.booking_id WHERE b.event_session_id = ? AND b.booking_status = 'active'
      ) b ON s.id = b.space_id
      ORDER BY s.type, name
    `, [viewingSessionId]);

    if (!spaceToEdit) {
      // Handle case where space is not found
      return res.redirect('/space/add');
    }

    res.render('manageSpaces', {
      title: 'Edit Space',
      spaces: allSpaces || [],
      space: spaceToEdit, // Pass the specific space to be edited
      report_url: `/space/edit/${req.params.id}`
    });
  } catch (err) {
    console.error('Error fetching space for editing:', err.message);
    res.status(500).send('Error loading edit page.');
  }
});

// POST: Update a space
router.post('/edit/:id', async (req, res) => {
  const { type, name, size, rent_amount, facilities, location } = req.body;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot edit spaces in an archived session.' };
    return res.redirect('/space/add');
  }

  try {
    await run('UPDATE spaces SET type=?, name=?, size=?, rent_amount=?, facilities=?, location=? WHERE id=?', [type, name, size, rent_amount, facilities, location, req.params.id]);
    req.session.flash = { type: 'success', message: `Space '${name}' was updated successfully.` };
    res.redirect('/space/add');
  } catch (err) {
    console.error('Error updating space:', err.message);
    res.status(500).send('Error updating space.');
  }
});

// POST: Delete a space
router.post('/delete/:id', async (req, res) => {
  const { id } = req.params;

  // This check is now more flexible. We check against all sessions.
  // if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
  //   req.session.flash = { type: 'warning', message: 'Cannot delete spaces from an archived session.' };
  //   return res.redirect('/space/add');
  // }

  try {
    // Check if the space is currently booked in ANY session.
    const booking = await get(`
      SELECT b.id FROM bookings b 
      JOIN booking_spaces bs ON b.id = bs.booking_id
      JOIN event_sessions es ON b.event_session_id = es.id 
      WHERE bs.space_id = ? AND b.booking_status = 'active' AND es.is_active = 1
    `, [id]);
    if (booking) {
      req.session.flash = { type: 'danger', message: 'Cannot deactivate a space that is currently booked in an active session. Please cancel the booking first.' };
      return res.redirect('/space/add');
    }
    await run('UPDATE spaces SET is_active = 0 WHERE id = ?', [id]);
    req.session.flash = { type: 'success', message: 'Space deactivated successfully. It will no longer be available for new bookings.' };
    return res.redirect('/space/add');
  } catch (err) {
    console.error(`Error deleting space #${id}:`, err.message);
    res.status(500).send('Failed to delete space.');
  }
});

// POST: Reactivate a space
router.post('/reactivate/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await run('UPDATE spaces SET is_active = 1 WHERE id = ?', [id]);
    req.session.flash = { type: 'success', message: 'Space reactivated successfully. It is now available for new bookings.' };
    return res.redirect('/space/add?status=inactive');
  } catch (err) {
    console.error(`Error reactivating space #${id}:`, err.message);
    req.session.flash = { type: 'danger', message: 'Failed to reactivate space.' };
    res.status(500).send('Failed to reactivate space.');
  }
});

// GET: API endpoint to fetch spaces and their current booking status.
// Used by dropdowns and dynamic UI elements.
router.get('/api/spaces-with-status', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;

    const spaces = await all(`
      SELECT 
        s.id, s.name, s.type, s.rent_amount,
        CASE WHEN b.id IS NOT NULL THEN 'Booked' ELSE 'Available' END as status
      FROM spaces s LEFT JOIN (
        SELECT b.id, bs.space_id 
        FROM bookings b 
        JOIN booking_spaces bs ON b.id = bs.booking_id 
        WHERE b.event_session_id = ? AND b.booking_status = 'active'
      ) b ON s.id = b.space_id
      ORDER BY s.type, s.name;
    `, [viewingSessionId]);

    res.json(spaces);
  } catch (err) {
    console.error('API Error fetching spaces with status:', err.message);
    res.status(500).json({ error: 'Failed to fetch space statuses' });
  }
});

// GET: Diagnostic route to find spaces with conflicting booking statuses
router.get('/diagnostics/conflicts', isAdmin, async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;

    // 1. Get all spaces
    const allSpaces = await all('SELECT id, name, type FROM spaces ORDER BY type, name');

    // Pre-fetch all booked space IDs for the current session to avoid N+1 queries
    const bookedSpaceIdsResult = await all(
      `SELECT DISTINCT bs.space_id as id 
       FROM booking_spaces bs 
       JOIN bookings b ON bs.booking_id = b.id 
       WHERE b.event_session_id = ? AND b.booking_status = 'active'`,
      [viewingSessionId]
    );
    const bookedSpaceIds = new Set(bookedSpaceIdsResult.map(r => r.id));

    const diagnosticPromises = allSpaces.map(async (space) => {
      const isBooked = bookedSpaceIds.has(space.id);
      const dashboardStatus = isBooked ? 'Booked' : 'Available';
      const bookingFormStatus = isBooked ? 'Booked' : 'Available';

      const isConflict = (dashboardStatus !== bookingFormStatus);

      return {
        ...space,
        dashboard_status: dashboardStatus,
        booking_form_status: bookingFormStatus,
        is_conflict: isConflict
      };
    });

    const diagnosticResults = await Promise.all(diagnosticPromises);
    const conflictingSpaces = diagnosticResults.filter(s => s.is_conflict);

    res.render('diagnosticConflicts', {
      title: 'Booking Status Conflicts',
      conflictingSpaces,
      totalSpacesChecked: allSpaces.length
    });

  } catch (err) {
    console.error('Error running diagnostic check:', err.message);
    res.status(500).send('Error running diagnostic check.');
  }
});

module.exports = router;