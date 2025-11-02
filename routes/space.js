const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db-helpers');
const { isAdmin } = require('./auth');

// GET: Show form to add/manage spaces
router.get('/add', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const spaces = await all(`
      SELECT 
        s.*,
        CASE WHEN b.id IS NOT NULL THEN 'Booked' ELSE 'Available' END as session_status
      FROM spaces s 
      LEFT JOIN bookings b ON s.id = b.space_id AND b.event_session_id = ? AND b.booking_status = 'active'
      ORDER BY s.type, s.name
    `, [viewingSessionId]);
    res.render('manageSpaces', {
      title: 'Manage Spaces',
      spaces: spaces || [],
      space: null, // For the add form
      report_url: '/space/add'
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
      FROM spaces s 
      LEFT JOIN bookings b ON s.id = b.space_id AND b.event_session_id = ? AND b.booking_status = 'active'
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

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot delete spaces from an archived session.' };
    return res.redirect('/space/add');
  }

  try {
    // Check if the space is currently booked
    const booking = await get("SELECT id FROM bookings WHERE space_id = ? AND booking_status = 'active'", [id]);
    if (booking) {
      req.session.flash = { type: 'danger', message: 'Cannot delete a space that is currently booked. Please cancel the booking first.' };
      return res.redirect('/space/add');
    }
    await run('DELETE FROM spaces WHERE id = ?', [id]);
    req.session.flash = { type: 'success', message: 'Space deleted successfully.' };
    res.redirect('/space/add');
  } catch (err) {
    console.error(`Error deleting space #${id}:`, err.message);
    res.status(500).send('Failed to delete space.');
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
      FROM spaces s
      LEFT JOIN (SELECT id, space_id FROM bookings WHERE event_session_id = ? AND booking_status = 'active') b 
        ON s.id = b.space_id
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

    const diagnosticPromises = allSpaces.map(async (space) => {
      // 2. For each space, run multiple checks
      const [
        activeBookings,
        inactiveBookings,
        dashboardStatusResult,
        bookingFormResult
      ] = await Promise.all([
        get("SELECT COUNT(*) as count FROM bookings WHERE space_id = ? AND event_session_id = ? AND booking_status = 'active'", [space.id, viewingSessionId]),
        get("SELECT COUNT(*) as count FROM bookings WHERE space_id = ? AND event_session_id = ? AND booking_status IN ('cancelled', 'vacated')", [space.id, viewingSessionId]),
        get("SELECT CASE WHEN b.id IS NOT NULL THEN 'Booked' ELSE 'Available' END as status FROM spaces s LEFT JOIN (SELECT id, space_id FROM bookings WHERE event_session_id = ? AND booking_status = 'active') b ON s.id = b.space_id WHERE s.id = ?", [viewingSessionId, space.id]),
        get("SELECT CASE WHEN EXISTS (SELECT 1 FROM bookings WHERE space_id = ? AND event_session_id = ? AND booking_status = 'active') THEN 'Booked' ELSE 'Available' END as status", [space.id, viewingSessionId])
      ]);

      const dashboardStatus = dashboardStatusResult.status;
      // The booking form logic is "is it available?", so if it's booked, it's not available.
      const bookingFormStatus = bookingFormResult.status;

      const isConflict = (dashboardStatus !== bookingFormStatus) || (activeBookings.count > 1);

      return {
        ...space,
        active_bookings_count: activeBookings.count,
        inactive_bookings_count: inactiveBookings.count,
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