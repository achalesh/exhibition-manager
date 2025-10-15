const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { get, run, logAction } = require('../db-helpers');

// GET: Show login page
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login', error: null });
});

// POST: Handle login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      await logAction(null, username, 'Login Failed', 'Attempted login with non-existent username.');
      return res.render('login', { title: 'Login', error: 'Invalid username or password.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      // Store user in session
      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };
      await logAction(user.id, user.username, 'Login Success', 'User successfully logged in.');
      res.redirect('/dashboard'); // Redirect to the dashboard on successful login
    } else {
      await logAction(null, username, 'Login Failed', 'Attempted login with incorrect password.');
      res.render('login', { title: 'Login', error: 'Invalid username or password.' });
    }
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).send('An error occurred during login.');
  }
});

// GET: Handle logout
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/dashboard');
    }
    res.redirect('/login');
  });
});

// GET: Show change password form
router.get('/change-password', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  res.render('changePassword', {
    title: 'Change Password',
    error: null,
    success: null
  });
});

// POST: Handle change password
router.post('/change-password', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (newPassword !== confirmPassword) {
    return res.render('changePassword', { title: 'Change Password', error: 'New passwords do not match.', success: null });
  }

  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const match = await bcrypt.compare(currentPassword, user.password);

    if (!match) {
      return res.render('changePassword', { title: 'Change Password', error: 'Incorrect current password.', success: null });
    }

    const saltRounds = 10;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
    await run('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, req.session.user.id]);

    res.render('changePassword', { title: 'Change Password', error: null, success: 'Password updated successfully!' });
  } catch (err) {
    console.error('Error changing password:', err.message);
    res.render('changePassword', { title: 'Change Password', error: 'An error occurred. Please try again.', success: null });
  }
});

module.exports = router;