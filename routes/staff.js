const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { all, get, run } = require('../db-helpers');

// Configure storage for photo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/staff_photos/');
  },
  filename: function (req, file, cb) {
    // Create a unique filename to avoid conflicts
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// GET: Show form to add a new staff member
router.get('/add', (req, res) => {
  res.render('addStaff', { title: 'Add Booking Staff', error: null, staff: {} });
});

// POST: Save a new staff member
router.post('/add', upload.single('photo'), async (req, res) => {
  const { name, dob, address, phone, secondary_phone, aadhaar, role } = req.body;
  const photo_path = req.file ? `/uploads/staff_photos/${req.file.filename}` : null;
  const aadhaarValue = aadhaar || null; // Convert empty string to NULL for the database

  if (!name || !phone || !role) {
    return res.status(400).send('Name, Phone Number, and Role are required.');
  }

  try {
    // Explicitly check for duplicate Aadhaar before inserting
    if (aadhaarValue) {
      const existingStaff = await get('SELECT id FROM booking_staff WHERE aadhaar = ?', [aadhaarValue]);
      if (existingStaff) {
        // Re-render the form with an error message and the data the user entered
        return res.render('addStaff', { title: 'Add Booking Staff', error: 'This Aadhaar number is already registered.', staff: req.body });
      }
    }

    const sql = `INSERT INTO booking_staff (name, dob, address, phone, secondary_phone, aadhaar, photo_path, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await run(sql, [name, dob, address, phone, secondary_phone, aadhaarValue, photo_path, role]);
    res.redirect('/staff/list');
  } catch (err) {
    console.error('Error adding booking staff:', err.message);
    res.render('addStaff', { title: 'Add Booking Staff', error: 'An unexpected error occurred. Please try again.', staff: req.body });
  }
});

// GET: List all staff members
router.get('/list', async (req, res) => {
  const filterRole = req.query.role || 'all';
  let sql = 'SELECT * FROM booking_staff';
  const params = [];

  if (filterRole !== 'all') {
    sql += ' WHERE role = ?';
    params.push(filterRole);
  }
  sql += ' ORDER BY name';

  try {
    const staff = await all(sql, params);
    res.render('listStaff', {
      title: 'Booking Staff List',
      staff: staff || [],      
      currentRole: filterRole,
      report_url: '/staff/list'
    });
  } catch (err) {
    console.error('Error fetching staff list:', err.message);
    res.status(500).send('Error loading staff list.');
  }
});

// GET: Show a printable ID card for a staff member
router.get('/id-card/:id', async (req, res) => {
  const staffId = req.params.id;
  try {
    const staff = await get('SELECT * FROM booking_staff WHERE id = ?', [staffId]);
    if (!staff) {
      return res.status(404).send('Staff member not found.');
    }
    res.render('staffIdCard', {
      title: `ID Card - ${staff.name}`,
      staff
    });
  } catch (err) {
    console.error('Error fetching staff for ID card:', err.message);
    res.status(500).send('Error generating ID card.');
  }
});

module.exports = router;