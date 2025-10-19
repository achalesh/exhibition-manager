const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { get } = require('../db-helpers');

// GET /login - Show login page
router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'Login', error: null });
});

// POST /login - Handle login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };
      res.redirect('/dashboard');
    } else {
      res.render('login', { title: 'Login', error: 'Invalid username or password' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('An error occurred during login.');
  }
});

// GET /logout - Handle logout
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/dashboard');
    }
    res.clearCookie('connect.sid'); // The default session cookie name
    res.redirect('/login');
  });
});

module.exports = router;