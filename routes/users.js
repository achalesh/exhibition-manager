const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db-helpers');
const bcrypt = require('bcrypt');

// Note: All routes in this file are already protected by `isAdmin` in app.js

const availableRoles = ['admin', 'accountant', 'booking_manager', 'ticketing_manager', 'material_handler', 'user'];

// GET /users/manage - Show user management page
router.get('/manage', async (req, res) => {
  try {
    const users = await all('SELECT id, username, role FROM users ORDER BY username');
    res.render('manageUsers', {
      title: 'Manage Users',
      users,
      roles: availableRoles
    });
  } catch (err) {
    console.error('Error loading user management page:', err);
    req.session.flash = { type: 'danger', message: 'Could not load users.' };
    res.redirect('/dashboard');
  }
});

// POST /users/add - Create a new user
router.post('/add', async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
        req.session.flash = { type: 'danger', message: 'Username, password, and role are required.' };
        return res.redirect('/users/manage');
    }

    if (!availableRoles.includes(role)) {
        req.session.flash = { type: 'danger', message: 'Invalid role selected.' };
        return res.redirect('/users/manage');
    }

    try {
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        await run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, role]);
        req.session.flash = { type: 'success', message: `User '${username}' created successfully.` };
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            req.session.flash = { type: 'danger', message: `Username '${username}' already exists.` };
        } else {
            req.session.flash = { type: 'danger', message: 'Error creating user.' };
        }
    }
    res.redirect('/users/manage');
});

// POST /users/update-role/:id - Update a user's role
router.post('/update-role/:id', async (req, res) => {
  const userId = req.params.id;
  const { role } = req.body;

  if (!availableRoles.includes(role)) {
    req.session.flash = { type: 'danger', message: 'Invalid role selected.' };
    return res.redirect('/users/manage');
  }

  try {
    // Prevent admin from demoting themselves if they are the only admin
    if (String(req.session.user.id) === String(userId) && req.session.user.role === 'admin' && role !== 'admin') {
        const adminCount = await get('SELECT COUNT(*) as count FROM users WHERE role = ?', ['admin']);
        if (adminCount.count <= 1) {
            req.session.flash = { type: 'warning', message: 'Cannot change role. You are the only administrator.' };
            return res.redirect('/users/manage');
        }
    }
    await run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    req.session.flash = { type: 'success', message: 'User role updated successfully.' };
  } catch (err) {
    req.session.flash = { type: 'danger', message: 'Error updating user role.' };
  }
  res.redirect('/users/manage');
});

module.exports = router;