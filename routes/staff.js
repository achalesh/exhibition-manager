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
  const activeSessionId = res.locals.activeSession.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot add staff in an archived session.' };
    return res.redirect('/staff/add');
  }

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

    const sql = `INSERT INTO booking_staff (name, dob, address, phone, secondary_phone, aadhaar, photo_path, role, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await run(sql, [name, dob, address, phone, secondary_phone, aadhaarValue, photo_path, role, activeSessionId]);
    res.redirect('/staff/list');
  } catch (err) {
    console.error('Error adding booking staff:', err.message);
    res.render('addStaff', { title: 'Add Booking Staff', error: 'An unexpected error occurred. Please try again.', staff: req.body });
  }
});

// GET: List all staff members
router.get('/list', async (req, res) => {
  const viewingSessionId = res.locals.viewingSession.id;
  const filterRole = req.query.role || 'all';
  let sql = 'SELECT * FROM booking_staff WHERE event_session_id = ?';
  const params = [viewingSessionId];

  if (filterRole !== 'all') {
    sql += ' AND role = ?';
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

// GET: Show form to edit a staff member
router.get('/edit/:id', async (req, res) => {
  const staffId = req.params.id;
  try {
    const staff = await get('SELECT * FROM booking_staff WHERE id = ?', [staffId]);
    if (!staff) {
      req.session.flash = { type: 'danger', message: 'Staff member not found.' };
      return res.redirect('/staff/list');
    }
    res.render('editStaff', { title: `Edit Staff: ${staff.name}`, staff, error: null });
  } catch (err) {
    console.error('Error loading staff for editing:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Update a staff member
router.post('/edit/:id', upload.single('photo'), async (req, res) => {
  const staffId = req.params.id;
  const { name, dob, address, phone, secondary_phone, aadhaar, role, existing_photo_path } = req.body;
  let photo_path = existing_photo_path;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot edit staff in an archived session.' };
    return res.redirect('/staff/list');
  }

  if (req.file) {
    photo_path = `/uploads/staff_photos/${req.file.filename}`;
    // If a new photo is uploaded and an old one exists, delete the old one.
    if (existing_photo_path) {
      const oldPhoto = path.join(__dirname, '..', 'public', existing_photo_path);
      if (fs.existsSync(oldPhoto)) {
        fs.unlinkSync(oldPhoto);
      }
    }
  }

  try {
    // Check for duplicate Aadhaar, excluding the current staff member
    if (aadhaar) {
      const existingStaff = await get('SELECT id FROM booking_staff WHERE aadhaar = ? AND id != ?', [aadhaar, staffId]);
      if (existingStaff) {
        const staff = { ...req.body, id: staffId }; // Re-create staff object for the form
        return res.render('editStaff', { title: `Edit Staff: ${name}`, staff, error: 'This Aadhaar number is already registered to another staff member.' });
      }
    }

    const sql = `UPDATE booking_staff SET name = ?, dob = ?, address = ?, phone = ?, secondary_phone = ?, aadhaar = ?, photo_path = ?, role = ? WHERE id = ?`;
    await run(sql, [name, dob, address, phone, secondary_phone, aadhaar || null, photo_path, role, staffId]);
    req.session.flash = { type: 'success', message: 'Staff member updated successfully.' };
    res.redirect('/staff/list');
  } catch (err) {
    console.error('Error updating staff member:', err.message);
    req.session.flash = { type: 'danger', message: 'An unexpected error occurred. Please try again.' };
    res.redirect(`/staff/edit/${staffId}`);
  }
});

// POST: Delete a staff member
router.post('/delete/:id', async (req, res) => {
  const staffId = req.params.id;

  if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
    req.session.flash = { type: 'warning', message: 'Cannot delete staff from an archived session.' };
    return res.redirect('/staff/list');
  }

  try {
    // Check if staff is linked to any ticket distributions
    const distribution = await get('SELECT id FROM ticket_distributions WHERE staff_id = ?', [staffId]);
    if (distribution) {
      req.session.flash = { type: 'danger', message: 'Cannot delete staff member. They are associated with existing ticket distributions.' };
      return res.redirect('/staff/list');
    }

    const staff = await get('SELECT photo_path FROM booking_staff WHERE id = ?', [staffId]);
    await run('DELETE FROM booking_staff WHERE id = ?', [staffId]);

    // If a photo exists, delete it from the filesystem
    if (staff && staff.photo_path) {
      const photoFile = path.join(__dirname, '..', 'public', staff.photo_path);
      if (fs.existsSync(photoFile)) {
        fs.unlinkSync(photoFile);
      }
    }

    req.session.flash = { type: 'success', message: 'Staff member deleted successfully.' };
    res.redirect('/staff/list');
  } catch (err) {
    console.error('Error deleting staff member:', err.message);
    req.session.flash = { type: 'danger', message: 'Failed to delete staff member.' };
    res.redirect('/staff/list');
  }
});

module.exports = router;