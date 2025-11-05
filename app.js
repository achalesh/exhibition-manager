console.log("Starting Exhibition Rental App...");

require('dotenv').config(); // Load environment variables
const express = require('express');
const path = require('path');
const fs = require('fs');
const { all, get } = require('./db-helpers');
const session = require('express-session');

const app = express();

// Ensure upload directory exists
const staffUploadDir = path.join(__dirname, 'public/uploads/staff_photos');
if (!fs.existsSync(staffUploadDir)) {
    fs.mkdirSync(staffUploadDir, { recursive: true });
}
const logoUploadDir = path.join(__dirname, 'public/uploads/logos');
if (!fs.existsSync(logoUploadDir)) {
    fs.mkdirSync(logoUploadDir, { recursive: true });
}

// Middleware
app.use(express.json()); // For future API endpoints
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Route imports
const spaceRoutes = require('./routes/space');
const bookingRoutes = require('./routes/booking');
const electricRoutes = require('./routes/electric');
const materialRoutes = require('./routes/material');
const materialsRoutes = require('./routes/materials'); // For material stock management
const settingsRoutes = require('./routes/settings'); // Ensure this line exists
const chargesRoutes = require('./routes/charges');
const electricItemsRoutes = require('./routes/electric-items');
const shedRoutes = require('./routes/shed');
const reportRoutes = require('./routes/report');
const staffRoutes = require('./routes/staff');
const userRoutes = require('./routes/users');
const accountingRoutes = require('./routes/accounting');
const notificationRoutes = require('./routes/notification');
const sessionHandler = require('./sessionHandler');
const sessionRoutes = require('./routes/sessions');
const ticketingRoutes = require('./routes/ticketing');

// Middleware to handle flash messages
app.use((req, res, next) => {
  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
});

// Middleware to make user session available in all views
app.use((req, res, next) => {
  res.locals.appName = "Exhibition Manager"; // Set global app name
  res.locals.user = req.session.user;
  res.locals.currentPath = req.path;
  next();
});

// Middleware to handle event sessions
app.use(sessionHandler);

// --- Protected Routes ---
const { isAuthenticated, hasRole, isAdmin } = require('./routes/auth');

// --- Public Routes ---
// The auth routes for login/logout should be defined in a separate file or here.
// Assuming they are now missing, I'll add a placeholder. If you have them elsewhere, you can adjust.
app.use('/', require('./routes/authRoutes')); // We will create this file.

// Route usage
app.use('/space', isAuthenticated, hasRole(['booking_manager']), spaceRoutes);
app.use('/booking', isAuthenticated, hasRole(['booking_manager']), bookingRoutes);
app.use('/electric', isAuthenticated, hasRole(['booking_manager']), electricRoutes);
app.use('/material', isAuthenticated, hasRole(['booking_manager', 'admin']), materialRoutes); // Old form-based system
app.use('/materials', isAuthenticated, hasRole(['admin', 'material_handler']), materialsRoutes); // QR-based system
app.use('/charges', isAuthenticated, hasRole(['accountant']), chargesRoutes);
app.use('/shed', isAuthenticated, hasRole(['booking_manager']), shedRoutes);
app.use('/staff', isAuthenticated, isAdmin, staffRoutes);
app.use('/ticketing', isAuthenticated, hasRole(['ticketing_manager', 'admin']), ticketingRoutes);
app.use('/accounting', isAuthenticated, hasRole(['accountant']), accountingRoutes);

app.use('/report', isAuthenticated, isAdmin, reportRoutes); // Reports for admins only for now
app.use('/users', isAuthenticated, isAdmin, userRoutes);
app.use('/sessions', isAuthenticated, isAdmin, sessionRoutes);
app.use('/settings', isAuthenticated, isAdmin, settingsRoutes);
app.use('/electric-items', isAuthenticated, isAdmin, electricItemsRoutes);
app.use('/notification', isAuthenticated, notificationRoutes);

// Dashboard route
app.get('/dashboard', isAuthenticated, (req, res, next) => {
  // If the user is a material_handler, redirect them away from the dashboard
  if (req.session.user && req.session.user.role === 'material_handler') {
    return res.redirect('/materials/issue');
  }
  next();
}, async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;

    // --- Backup Alert Logic ---
    let showBackupAlert = false;
    if (req.session.user && req.session.user.role === 'admin') {
      const lastBackup = await get("SELECT value FROM app_meta WHERE key = 'last_backup_date'");
      const lastBackupDate = lastBackup ? lastBackup.value : '2000-01-01';
      const today = new Date().toISOString().split('T')[0];
      if (lastBackupDate !== today) {
        showBackupAlert = true;
      }
    }

    // --- Space/Stall Summary Queries (now session-aware) ---
    const categoryQuery = 'SELECT type, COUNT(*) as count FROM spaces GROUP BY type';
    const totalQuery = 'SELECT COUNT(*) as count FROM spaces';
    const bookedSpacesQuery = get("SELECT COUNT(DISTINCT space_id) as count FROM bookings WHERE event_session_id = ? AND booking_status = 'active'", [viewingSessionId]);
    const spacesQuery = `
      SELECT 
        s.*, 
        b.facia_name,
        CASE WHEN b.space_id IS NOT NULL THEN 'Booked' ELSE 'Available' END as session_status
      FROM spaces s
      LEFT JOIN (
        SELECT space_id, facia_name FROM bookings 
        WHERE event_session_id = ? AND booking_status = 'active'
      ) b ON s.id = b.space_id
      ORDER BY s.type, s.name;
    `;

    // --- Financial Summary Queries ---
    const financialQueries = [
      get('SELECT SUM(rent_amount - COALESCE(discount, 0)) as charged FROM bookings WHERE event_session_id = ?', [viewingSessionId]),
      get('SELECT SUM(advance_amount) as paid_advance FROM bookings WHERE event_session_id = ?', [viewingSessionId]),
      get('SELECT SUM(p.rent_paid) as paid_rent, SUM(p.electric_paid) as paid_electric, SUM(p.material_paid) as paid_material, SUM(p.shed_paid) as paid_shed FROM payments p WHERE p.event_session_id = ?', [viewingSessionId]),
      get('SELECT SUM(total_amount) as charged FROM electric_bills WHERE event_session_id = ?', [viewingSessionId]),
      get('SELECT SUM(total_payable) as charged FROM material_issues WHERE event_session_id = ?', [viewingSessionId]),
      get('SELECT SUM(s.rent) as charged FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.event_session_id = ?', [viewingSessionId])
    ];
    // Fetch pending approvals for admins
    if (req.session.user && req.session.user.role === 'admin') {
      const bookingEditsQuery = all("SELECT be.*, b.exhibitor_name, 'Booking' as edit_type FROM booking_edits be JOIN bookings b ON be.booking_id = b.id WHERE be.status = 'pending'");
      const paymentEditsQuery = all("SELECT pe.*, b.exhibitor_name, 'Payment' as edit_type FROM payment_edits pe JOIN payments p ON pe.payment_id = p.id JOIN bookings b ON p.booking_id = b.id WHERE pe.status = 'pending'");
      const materialEditsQuery = all("SELECT me.*, c.name as exhibitor_name, 'Material' as edit_type FROM material_issue_edits me JOIN material_issues mi ON me.material_issue_id = mi.id JOIN clients c ON mi.client_id = c.id WHERE me.status = 'pending'");
      const electricEditsQuery = all("SELECT ee.*, b.exhibitor_name, 'Electric' as edit_type FROM electric_bill_edits ee JOIN electric_bills eb ON ee.electric_bill_id = eb.id JOIN bookings b ON eb.booking_id = b.id WHERE ee.status = 'pending'");
      
      const allApprovals = await Promise.all([bookingEditsQuery, paymentEditsQuery, materialEditsQuery, electricEditsQuery]);
      const pendingApprovals = [].concat(...allApprovals).sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
      financialQueries.push(Promise.resolve(pendingApprovals));
    } else if (req.session.user) {
      // Fetch notifications for non-admins
      const bookingNotificationsQuery = all("SELECT be.*, b.exhibitor_name, 'Booking' as edit_type FROM booking_edits be JOIN bookings b ON be.booking_id = b.id WHERE be.user_id = ? AND (be.status = 'pending' OR (be.status IN ('approved', 'rejected') AND be.user_notified = 0))", [req.session.user.id]);
      const paymentNotificationsQuery = all("SELECT pe.*, b.exhibitor_name, 'Payment' as edit_type FROM payment_edits pe JOIN payments p ON pe.payment_id = p.id JOIN bookings b ON p.booking_id = b.id WHERE pe.user_id = ? AND (pe.status = 'pending' OR (pe.status IN ('approved', 'rejected') AND pe.user_notified = 0))", [req.session.user.id]);
      const materialNotificationsQuery = all("SELECT me.*, c.name as exhibitor_name, 'Material' as edit_type FROM material_issue_edits me JOIN material_issues mi ON me.material_issue_id = mi.id JOIN clients c ON mi.client_id = c.id WHERE me.user_id = ? AND (me.status = 'pending' OR (me.status IN ('approved', 'rejected') AND me.user_notified = 0))", [req.session.user.id]);
      const electricNotificationsQuery = all("SELECT ee.*, b.exhibitor_name, 'Electric' as edit_type FROM electric_bill_edits ee JOIN electric_bills eb ON ee.electric_bill_id = eb.id JOIN bookings b ON eb.booking_id = b.id WHERE ee.user_id = ? AND (be.status = 'pending' OR (be.status IN ('approved', 'rejected') AND ee.user_notified = 0))", [req.session.user.id]);

      const allNotifications = await Promise.all([bookingNotificationsQuery, paymentNotificationsQuery, materialNotificationsQuery, electricNotificationsQuery]);
      const userNotifications = [].concat(...allNotifications).sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
      financialQueries.push(Promise.resolve(userNotifications));
    } else {
      financialQueries.push(Promise.resolve(null)); // Placeholder for non-logged-in users
    }

    // Run all queries in parallel for better performance
    const [
      categories, 
      total, 
      bookedSpacesResult,
      allSpaces,
      rentStats,
      advanceStats,
      paymentStats,
      electricStats,
      materialStats,
      shedStats,
      contextualData, // This will be pendingApprovals for admins, or userNotifications for users
      recentActivities
    ] = await Promise.all([
      all(categoryQuery),
      get(totalQuery),
      bookedSpacesQuery,
      all(spacesQuery, [viewingSessionId]),
      ...financialQueries,
      all('SELECT timestamp, username, action, details FROM logs WHERE event_session_id = ? ORDER BY timestamp DESC LIMIT 10', [viewingSessionId])
    ]);

    const categoryCounts = (categories || []).reduce((acc, row) => {
      acc[row.type] = row.count;
      return acc;
    }, {});

    const totalSpacesCount = total ? total.count : 0;
    const bookedCount = bookedSpacesResult ? bookedSpacesResult.count : 0;
    const statusCounts = { Booked: bookedCount, Available: totalSpacesCount - bookedCount };

    // Group spaces by type for the layout view
    const spacesByType = (allSpaces || []).reduce((acc, space) => {
      if (!acc[space.type]) {
        acc[space.type] = [];
      }
      acc[space.type].push(space);
      return acc;
    }, {});

    // --- Process Financial Summary ---
    const formatCurrency = (num) => {
      if (typeof num !== 'number') return '0.00';
      return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const financials = {
      rent: {
        charged: rentStats?.charged || 0,
        paid: (advanceStats?.paid_advance || 0) + (paymentStats?.paid_rent || 0)
      },
      electric: {
        charged: electricStats?.charged || 0,
        paid: paymentStats?.paid_electric || 0
      },
      material: {
        charged: materialStats?.charged || 0,
        paid: paymentStats?.paid_material || 0
      },
      shed: {
        charged: shedStats?.charged || 0,
        paid: paymentStats?.paid_shed || 0
      }
    };
    Object.values(financials).forEach(cat => {
      cat.due = cat.charged - cat.paid;
      cat.chargedFormatted = formatCurrency(cat.charged);
      cat.paidFormatted = formatCurrency(cat.paid);
      cat.dueFormatted = formatCurrency(cat.due);
    });

    res.render('dashboard', {
      title: 'Dashboard',
      totalSpaces: totalSpacesCount,
      categoryCounts,
      statusCounts,
      spacesByType,
      financials,
      pendingApprovals: (req.session.user && req.session.user.role === 'admin') ? (contextualData || []) : [],
      userNotifications: (req.session.user && req.session.user.role !== 'admin') ? (contextualData || []) : [],
      recentActivities,
      showBackupAlert,
      message: req.query.message
    });
  } catch (err) {
    console.error("Error loading dashboard:", err);
    res.status(500).send('Error loading dashboard data.');
  }
});

// POST /dashboard/search - Handle search from the dashboard
app.post('/dashboard/search', isAuthenticated, async (req, res) => {
  const { q } = req.body;
  const viewingSessionId = res.locals.viewingSession.id;

  if (!q) {
    return res.redirect('/dashboard');
  }

  try {
    const searchSql = `
      SELECT b.id
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      WHERE b.event_session_id = ? AND (
        b.exhibitor_name LIKE ? OR
        b.facia_name LIKE ? OR
        s.name LIKE ?
      )
    `;
    const results = await all(searchSql, [viewingSessionId, `%${q}%`, `%${q}%`, `%${q}%`]);

    if (results.length === 1) {
      // Perfect match, go to details
      res.redirect(`/booking/details-full/${results[0].id}`);
    } else {
      // No results or multiple results, redirect to booking list with a filter (future enhancement)
      // For now, show a message on the dashboard.
      const message = results.length === 0 ? `No exhibitor found for "${q}".` : `${results.length} exhibitors found for "${q}". Please check the booking list.`;
      req.session.flash = { type: 'info', message: message };
      res.redirect('/dashboard');
    }
  } catch (err) {
    console.error('Dashboard search error:', err);
    req.session.flash = { type: 'danger', message: 'An error occurred during the search.' };
    res.redirect('/dashboard');
  }
});

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

//Port configuration
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
