console.log("Starting Exhibition Rental App...");

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
  secret: 'your-very-secret-key-change-this', // Change this to a random secret
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Route imports
const spaceRoutes = require('./routes/space');
const bookingRoutes = require('./routes/booking');
const electricRoutes = require('./routes/electric');
const materialRoutes = require('./routes/material');
const settingsRoutes = require('./routes/settings'); // Ensure this line exists
const chargesRoutes = require('./routes/charges');
const shedRoutes = require('./routes/shed');
const reportRoutes = require('./routes/report');
const staffRoutes = require('./routes/staff');
const userRoutes = require('./routes/users');
const authRoutes = require('./routes/auth');
const notificationRoutes = require('./routes/notification');

// Middleware to fetch exhibition details for all routes
app.use(async (req, res, next) => {
  res.locals.appName = "Exhibition Manager"; // Set global app name
  try {
    const details = await get('SELECT name, address, location, place, logo_path FROM exhibition_details WHERE id = 1');
    res.locals.exhibitionDetails = details || { name: 'Exhibition', address: 'N/A', location: 'N/A', place: 'N/A', logo_path: null };
  } catch (error) {
    console.error("Failed to fetch exhibition details:", error);
    res.locals.exhibitionDetails = { name: 'Exhibition', address: 'Error loading details', location: '', place: '', logo_path: null };
  }
  next();
});

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
  res.locals.user = req.session.user;
  res.locals.currentPath = req.path;
  next();
});

// --- Public Routes ---
app.use('/', authRoutes);

// --- Protected Routes ---
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    return next();
  }
  res.redirect('/login');
};

// Route usage
app.use('/space', isAuthenticated, spaceRoutes);
app.use('/booking', isAuthenticated, bookingRoutes);
app.use('/electric', isAuthenticated, electricRoutes);
app.use('/material', isAuthenticated, materialRoutes);
app.use('/settings', isAuthenticated, settingsRoutes);
app.use('/charges', isAuthenticated, chargesRoutes);
app.use('/shed', isAuthenticated, shedRoutes);
app.use('/report', isAuthenticated, reportRoutes);
app.use('/staff', isAuthenticated, staffRoutes);
app.use('/users', isAuthenticated, userRoutes);
app.use('/notification', isAuthenticated, notificationRoutes);

// Dashboard route
app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const categoryQuery = 'SELECT type, COUNT(*) as count FROM spaces GROUP BY type';
    const statusQuery = 'SELECT status, COUNT(*) as count FROM spaces GROUP BY status';
    const totalQuery = 'SELECT COUNT(*) as count FROM spaces';
    const spacesQuery = `
      SELECT s.*, b.facia_name 
      FROM spaces s 
      LEFT JOIN bookings b ON s.id = b.space_id 
      ORDER BY s.type, s.name
    `;

    // --- Financial Summary Queries ---
    const financialQueries = [
      get('SELECT SUM(rent_amount - COALESCE(discount, 0)) as charged FROM bookings'),
      get('SELECT SUM(advance_amount) as paid_advance FROM bookings'),
      get('SELECT SUM(rent_paid) as paid_rent, SUM(electric_paid) as paid_electric, SUM(material_paid) as paid_material, SUM(shed_paid) as paid_shed FROM payments'),
      get('SELECT SUM(total_amount) as charged FROM electric_bills'),
      get('SELECT SUM(total_payable) as charged FROM material_issues'),
      get('SELECT SUM(s.rent) as charged FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id')
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
      const electricNotificationsQuery = all("SELECT ee.*, b.exhibitor_name, 'Electric' as edit_type FROM electric_bill_edits ee JOIN electric_bills eb ON ee.electric_bill_id = eb.id JOIN bookings b ON eb.booking_id = b.id WHERE ee.user_id = ? AND (ee.status = 'pending' OR (ee.status IN ('approved', 'rejected') AND ee.user_notified = 0))", [req.session.user.id]);

      const allNotifications = await Promise.all([bookingNotificationsQuery, paymentNotificationsQuery, materialNotificationsQuery, electricNotificationsQuery]);
      const userNotifications = [].concat(...allNotifications).sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
      financialQueries.push(Promise.resolve(userNotifications));
    } else {
      financialQueries.push(Promise.resolve(null)); // Placeholder for non-logged-in users
    }

    // Run all queries in parallel for better performance
    const [
      categories, 
      statuses, 
      total, 
      allSpaces,
      rentStats,
      advanceStats,
      paymentStats,
      electricStats,
      materialStats,
      shedStats,
      contextualData // This will be pendingApprovals for admins, or userNotifications for users
    ] = await Promise.all([
      all(categoryQuery),
      all(statusQuery),
      get(totalQuery),
      all(spacesQuery),
      ...financialQueries
    ]);

    const categoryCounts = (categories || []).reduce((acc, row) => {
      acc[row.type] = row.count;
      return acc;
    }, {});

    const statusCounts = (statuses || []).reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, { Booked: 0, Available: 0 });

    // Group spaces by type for the layout view
    const spacesByType = (allSpaces || []).reduce((acc, space) => {
      if (!acc[space.type]) {
        acc[space.type] = [];
      }
      acc[space.type].push(space);
      return acc;
    }, {});

    // --- Process Financial Summary ---
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
    Object.values(financials).forEach(cat => cat.due = cat.charged - cat.paid);

    res.render('dashboard', {
      title: 'Dashboard',
      totalSpaces: total ? total.count : 0,
      categoryCounts,
      statusCounts,
      spacesByType,
      financials,
      pendingApprovals: (req.session.user && req.session.user.role === 'admin') ? (contextualData || []) : [],
      userNotifications: (req.session.user && req.session.user.role !== 'admin') ? (contextualData || []) : [],
      message: req.query.message
    });
  } catch (err) {
    console.error("Error loading dashboard:", err);
    res.status(500).send('Error loading dashboard data.');
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

// Start server
//app.listen(3000, () => {
//  console.log('Server running at http://localhost:3000');
//});
