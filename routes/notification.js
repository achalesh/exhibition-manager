const express = require('express');
const router = express.Router();
const { run } = require('../db-helpers');

// POST: Dismiss a user notification
router.post('/dismiss/:type/:edit_id', async (req, res) => {
  if (!req.session.user) {
    return res.status(403).send('Access Denied.');
  }

  const { type, edit_id } = req.params;
  const userId = req.session.user.id;

  const tableMap = {
    'Booking': 'booking_edits',
    'Payment': 'payment_edits',
    'Material': 'material_issue_edits',
    'Electric': 'electric_bill_edits'
  };

  const tableName = tableMap[type];
  if (!tableName) {
    return res.status(400).send('Invalid notification type.');
  }

  await run(`UPDATE ${tableName} SET user_notified = 1 WHERE id = ? AND user_id = ?`, [edit_id, userId]);
  res.redirect('/dashboard');
});

module.exports = router;