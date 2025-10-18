const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { get, run } = require('../db-helpers');

// Configure storage for logo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/logos/');
  },
  filename: function (req, file, cb) {
    // Use a fixed name for the logo to easily reference it
    cb(null, 'exhibition-logo' + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// GET: Show form to manage exhibition address and logo
router.get('/address', async (req, res) => {
  try {
    const details = await get('SELECT * FROM exhibition_details WHERE id = 1');
    res.render('exhibitionAddress', {
      title: 'Exhibition Details',
      details: details || {},
      report_url: '/settings/address'
    });
  } catch (err) {
    console.error('Error fetching exhibition details:', err.message);
    res.status(500).send('Error loading settings page.');
  }
});

// POST: Update exhibition address and logo
router.post('/address', upload.single('logo'), async (req, res) => {
  const { name, address, location, place } = req.body;
  let logo_path = req.body.existing_logo_path; // Keep old logo if new one isn't uploaded

  if (req.file) {
    logo_path = `/uploads/logos/${req.file.filename}`;
  }

  try {
    await run(
      'UPDATE exhibition_details SET name = ?, address = ?, location = ?, place = ?, logo_path = ? WHERE id = 1',
      [name, address, location, place, logo_path]
    );
    req.session.flash = { type: 'success', message: 'Exhibition details updated successfully.' };
    res.redirect('/settings/address');
  } catch (err) {
    console.error('Error updating exhibition details:', err.message);
    res.status(500).send('Error saving settings.');
  }
});

// GET: Show form to manage material defaults
router.get('/materials', async (req, res) => {
  try {
    const defaults = await get('SELECT * FROM material_defaults WHERE id = 1');
    res.render('manageMaterialDefaults', {
      title: 'Manage Material Defaults',
      defaults: defaults || { free_tables: 1, free_chairs: 2 },
      report_url: '/settings/materials'
    });
  } catch (err) {
    console.error('Error fetching material defaults:', err.message);
    res.status(500).send('Error loading settings page.');
  }
});

// POST: Update material defaults
router.post('/materials', async (req, res) => {
  const { free_tables, free_chairs } = req.body;
  await run('UPDATE material_defaults SET free_tables = ?, free_chairs = ? WHERE id = 1', [free_tables, free_chairs]);
  res.redirect('/material/issue');
});

// GET /settings/backup-db - Download a backup of the database
router.get('/backup-db', (req, res) => {
  // Ensure only admins can download the backup
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Access Denied. Only administrators can perform backups.');
  }

  const dbPath = path.join(__dirname, '..', 'production.db');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFilename = `exhibition-backup-${timestamp}.db`;

  res.download(dbPath, backupFilename);
});


module.exports = router;