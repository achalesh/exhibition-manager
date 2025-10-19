const express = require('express');
const router = express.Router();
const { all, run, get } = require('../db-helpers');
const { isAdmin } = require('./auth');

// Use the isAdmin middleware for all routes in this file
router.use(isAdmin);

// GET /sessions - Main page to manage event sessions
router.get('/', async (req, res) => {
  try {
    const sessions = await all('SELECT * FROM event_sessions ORDER BY is_active DESC, start_date DESC, name');
    res.render('manageSessions', {
      title: 'Manage Event Sessions',
      sessions
    });
  } catch (err) {
    console.error('Error loading event sessions page:', err);
    req.session.flash = { type: 'danger', message: 'Could not load sessions page.' };
    res.redirect('/dashboard');
  }
});

// POST /sessions/add - Create a new event session
router.post('/add', async (req, res) => {
  const { name, location, start_date, end_date, address, place } = req.body;
  if (!name) {
    req.session.flash = { type: 'danger', message: 'Session Name is required.' };
    return res.redirect('/sessions');
  }

  try {
    await run(
      'INSERT INTO event_sessions (name, location, start_date, end_date, address, place, is_active) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [name, location || null, start_date || null, end_date || null, address || null, place || null]
    );
    req.session.flash = { type: 'success', message: 'New event session created successfully.' };
  } catch (err) {
    console.error('Error creating new event session:', err);
    req.session.flash = { type: 'danger', message: 'Failed to create session. The name might already exist.' };
  }
  res.redirect('/sessions');
});

// GET /sessions/edit/:id - Show form to edit a session
router.get('/edit/:id', async (req, res) => {
  try {
    const session = await get('SELECT * FROM event_sessions WHERE id = ?', [req.params.id]);
    if (!session) {
      req.session.flash = { type: 'danger', message: 'Session not found.' };
      return res.redirect('/sessions');
    }
    res.render('editSession', {
      title: `Edit Session: ${session.name}`,
      session
    });
  } catch (err) {
    console.error('Error loading session edit page:', err);
    req.session.flash = { type: 'danger', message: 'Could not load session for editing.' };
    res.redirect('/sessions');
  }
});

// POST /sessions/edit/:id - Update a session
router.post('/edit/:id', async (req, res) => {
  const sessionId = req.params.id;
  const { name, location, start_date, end_date, address, place } = req.body;
  if (!name) {
    req.session.flash = { type: 'danger', message: 'Session Name is required.' };
    return res.redirect(`/sessions/edit/${sessionId}`);
  }

  try {
    await run(
      'UPDATE event_sessions SET name = ?, location = ?, start_date = ?, end_date = ?, address = ?, place = ? WHERE id = ?',
      [name, location || null, start_date || null, end_date || null, address || null, place || null, sessionId]
    );
    req.session.flash = { type: 'success', message: 'Session details updated successfully.' };
  } catch (err) {
    console.error('Error updating event session:', err);
    req.session.flash = { type: 'danger', message: 'Failed to update session. The name might already exist.' };
  }
  res.redirect('/sessions');
});

// POST /sessions/activate/:id - Set a session as the active one
router.post('/activate/:id', async (req, res) => {
  const sessionIdToActivate = req.params.id;
  try {
    await run('BEGIN TRANSACTION');
    // Deactivate any currently active session
    await run('UPDATE event_sessions SET is_active = 0 WHERE is_active = 1');
    // Activate the selected session
    await run('UPDATE event_sessions SET is_active = 1 WHERE id = ?', [sessionIdToActivate]);
    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Active session has been switched successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error activating session:', err);
    req.session.flash = { type: 'danger', message: 'Failed to switch active session.' };
  }
  res.redirect('/sessions');
});

module.exports = router;