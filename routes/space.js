const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db-helpers');

// GET: Show form to add/manage spaces
router.get('/add', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const spaces = await all(`
      SELECT 
        s.*,
        CASE WHEN b.id IS NOT NULL THEN 'Booked' ELSE 'Available' END as session_status
      FROM spaces s
      LEFT JOIN bookings b ON s.id = b.space_id AND b.event_session_id = ?
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
      LEFT JOIN bookings b ON s.id = b.space_id AND b.event_session_id = ?
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
    const booking = await get('SELECT id FROM bookings WHERE space_id = ?', [id]);
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

module.exports = router;