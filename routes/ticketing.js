const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db-helpers');
const multer = require('multer');
const fs = require('fs');

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).send('Access Denied: Admins only.');
};

// Multer setup for file uploads
const upload = multer({ dest: 'uploads/' });

// GET /ticketing - Main ticketing dashboard
router.get('/', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const { start_date, end_date } = req.query;

    let sql = `
      SELECT td.*, u.username as settled_by, s.name as staff_name, r.name as ride_name, r.rate
      FROM ticket_distributions td
      LEFT JOIN users u ON td.settled_by_user_id = u.id
      LEFT JOIN booking_staff s ON td.staff_id = s.id
      JOIN rides r ON td.ride_id = r.id
    `;
    const params = [activeSessionId];
    const whereClauses = ["td.status = 'Settled'", "td.event_session_id = ?"];

    if (start_date) {
      whereClauses.push('td.settlement_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('td.settlement_date <= ?');
      params.push(end_date);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY td.settlement_date DESC, td.id DESC`;

    const sales = await all(sql, params);

    // Calculate summary stats
    const summary = sales.reduce((acc, sale) => {
      acc.total_revenue += sale.calculated_revenue || 0;
      acc.total_tickets_sold += sale.tickets_sold || 0;
      acc.total_cash += sale.cash_amount || 0;
      acc.total_upi += sale.upi_amount || 0;
      return acc;
    }, { total_revenue: 0, total_tickets_sold: 0, total_cash: 0, total_upi: 0 });

    // Prepare data for the chart (sales by date)
    const salesByDate = sales.reduce((acc, sale) => {
      const date = sale.settlement_date;
      if (!acc[date]) {
        acc[date] = 0;
      }
      acc[date] += sale.calculated_revenue;
      return acc;
    }, {});

    // Prepare data for the full daily sales trend chart (unfiltered)
    const trendDataRaw = await all(`
      SELECT settlement_date, SUM(calculated_revenue) as daily_revenue
      FROM ticket_distributions
      WHERE event_session_id = ? AND status = 'Settled' AND settlement_date IS NOT NULL
      GROUP BY settlement_date
      ORDER BY settlement_date ASC
    `, [activeSessionId]);

    const trendChartData = {
      labels: trendDataRaw.map(row => row.settlement_date),
      data: trendDataRaw.map(row => row.daily_revenue)
    };

    // Prepare data for sales by ride pie chart
    const salesByRide = sales.reduce((acc, sale) => {
      const rideName = sale.ride_name;
      if (!acc[rideName]) {
        acc[rideName] = 0;
      }
      acc[rideName] += sale.calculated_revenue;
      return acc;
    }, {});

    const pieChartData = {
      labels: Object.keys(salesByRide),
      data: Object.values(salesByRide)
    };

    const topRides = Object.entries(salesByRide)
      .map(([name, revenue]) => ({ name, revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Prepare data for sales by staff bar chart
    const salesByStaff = sales.reduce((acc, sale) => {
      const staffName = sale.staff_name || 'N/A'; // Handle cases with no staff name
      if (!acc[staffName]) {
        acc[staffName] = 0;
      }
      acc[staffName] += sale.calculated_revenue;
      return acc;
    }, {});

    const staffChartData = {
      labels: Object.keys(salesByStaff),
      data: Object.values(salesByStaff)
    };

    res.render('ticketing', {
      title: 'Ticketing Sales Dashboard', sales, summary, trendChartData, pieChartData, topRides, staffChartData, filters: { start_date, end_date }
    });
  } catch (err) {
    console.error('Error loading ticketing page:', err);
    res.status(500).send('Error loading ticketing data.');
  }
});

// GET /ticketing/rides - Show form to manage rides
router.get('/rides', isAdmin, async (req, res) => {
  try {
    const rides = await all(`
      SELECT id, name, rate, is_active
      FROM rides
      ORDER BY name`);
    res.render('ticketingRides', { title: 'Manage Rides & Rates', rides });
  } catch (err) {
    console.error('Error loading rides page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/rides/add - Add a new ride
router.post('/rides/add', isAdmin, async (req, res) => {
  let { name, rate } = req.body;
  if (!name || !rate) {
    req.session.flash = { type: 'danger', message: 'Ride Name and Rate are required.' };
    return res.redirect('/ticketing/rides');
  }

  try {
    await run('BEGIN TRANSACTION');
    await run('INSERT INTO rides (name, rate) VALUES (?, ?)', [name, parseFloat(rate)]);
    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Ride added successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    req.session.flash = { type: 'danger', message: 'Failed to add ride. It might already exist.' };
  }
  res.redirect('/ticketing/rides');
});

// POST /ticketing/rides/delete/:id - Delete a ride
router.post('/rides/delete/:id', isAdmin, async (req, res) => {
  // The ON DELETE CASCADE on the ticket_rates table will handle cleanup.
  await run('DELETE FROM rides WHERE id = ?', [req.params.id]);
  res.redirect('/ticketing/rides');
});

// POST /ticketing/rides/toggle-active/:id - Toggle ride active status
router.post('/rides/toggle-active/:id', isAdmin, async (req, res) => {
  await run('UPDATE rides SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
  res.redirect('/ticketing/rides');
});

// GET /ticketing/stock - Show form to manage stock
router.get('/stock', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const { q } = req.query;

    let sql = `
      SELECT ts.*
      FROM ticket_stock ts
    `;
    const params = [activeSessionId];
    const whereClauses = ['ts.event_session_id = ?'];

    if (q) {
      whereClauses.push('(ts.color LIKE ? OR ts.start_number LIKE ? OR ts.end_number LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY ts.created_at DESC, ts.rate, ts.start_number`;

    const stock = await all(sql, params);

    res.render('ticketingStock', { title: 'Manage Ticket Stock', stock, filters: { q: q || '' } });
  } catch (err) {
    console.error('Error loading ticket stock page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/stock/add - Add a new stock entry
router.post('/stock/add', isAdmin, async (req, res) => {
  const { rate, color, start_number, end_number } = req.body;
  if (!rate || !color || !start_number || !end_number) {
    req.session.flash = { type: 'danger', message: 'All fields are required.' };
    return res.redirect('/ticketing/stock');
  }
  const activeSessionId = res.locals.activeSession.id;
  try {
    await run('INSERT INTO ticket_stock (rate, color, start_number, end_number, status, event_session_id) VALUES (?, ?, ?, ?, ?, ?)', [parseFloat(rate), color, parseInt(start_number), parseInt(end_number), 'Available', activeSessionId]);
    req.session.flash = { type: 'success', message: 'Ticket stock added successfully.' };
  } catch (err) {
    console.error('Error adding ticket stock:', err);
    req.session.flash = { type: 'danger', message: 'Failed to add stock.' };
  }
  res.redirect('/ticketing/stock');
});

// GET /ticketing/stock/bulk-upload - Show bulk upload form
router.get('/stock/bulk-upload', isAdmin, (req, res) => {
  res.render('ticketingStockBulk', { title: 'Bulk Upload Stock' });
});

// POST /ticketing/stock/bulk-upload - Process the uploaded CSV
router.post('/stock/bulk-upload', isAdmin, upload.single('stockFile'), async (req, res) => {
  if (!req.file) {
    req.session.flash = { type: 'danger', message: 'No file was uploaded.' };
    return res.redirect('/ticketing/stock/bulk-upload');
  }

  const filePath = req.file.path;
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const rows = fileContent.split('\n').filter(row => row.trim() !== '');

  const activeSessionId = res.locals.activeSession.id;
  try {
    await run('BEGIN TRANSACTION');

    for (const [index, row] of rows.entries()) {
      const [rate, color, start_number, end_number] = row.split(',').map(field => field.trim());

      if (!rate || !color || !start_number || !end_number) {
        throw new Error(`Row ${index + 1} is incomplete. All four fields are required.`);
      }
      if (isNaN(parseFloat(rate))) {
        throw new Error(`Row ${index + 1} has an invalid (non-numeric) rate: '${rate}'.`);
      }

      await run(
        'INSERT INTO ticket_stock (rate, color, start_number, end_number, status, event_session_id) VALUES (?, ?, ?, ?, ?, ?)',
        [parseFloat(rate), color, parseInt(start_number), parseInt(end_number), 'Available', activeSessionId]
      );
    }

    await run('COMMIT');
    req.session.flash = { type: 'success', message: `Successfully imported ${rows.length} stock bundles.` };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error during bulk stock upload:', err);
    req.session.flash = { type: 'danger', message: `Import failed: ${err.message}` };
  } finally {
    // Clean up the uploaded file
    fs.unlinkSync(filePath);
  }

  if (req.session.flash.type === 'success') {
    res.redirect('/ticketing/stock');
  } else {
    res.redirect('/ticketing/stock/bulk-upload');
  }
});

// GET /ticketing/stock/edit/:id - Show form to edit a stock entry
router.get('/stock/edit/:id', isAdmin, async (req, res) => {
  try {
    const stock = await get(`
      SELECT ts.*
      FROM ticket_stock ts 
      WHERE ts.id = ?
    `, [req.params.id]);

    if (!stock) {
      req.session.flash = { type: 'danger', message: 'Stock entry not found.' };
      return res.redirect('/ticketing/stock');
    }
    if (stock.status === 'Distributed') {
      req.session.flash = { type: 'danger', message: 'Cannot edit stock that is currently distributed. Please recall it first.' };
      return res.redirect('/ticketing/stock');
    }

    res.render('editTicketingStock', { title: 'Edit Ticket Stock', stock });
  } catch (err) {
    console.error('Error loading stock edit page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/stock/edit/:id - Update a stock entry
router.post('/stock/edit/:id', isAdmin, async (req, res) => {
  const stockId = req.params.id;
  const { rate, color, start_number, end_number } = req.body;

  try {
    await run('UPDATE ticket_stock SET rate = ?, color = ?, start_number = ?, end_number = ? WHERE id = ? AND (status = \'Available\' OR status = \'Settled\')', [parseFloat(rate), color, parseInt(start_number), parseInt(end_number), stockId]);
    req.session.flash = { type: 'success', message: 'Stock entry updated successfully.' };
  } catch (err) {
    console.error('Error updating stock:', err);
    req.session.flash = { type: 'danger', message: 'Failed to update stock entry.' };
  }
  res.redirect('/ticketing/stock');
});

// POST /ticketing/stock/delete/:id - Delete a stock entry
router.post('/stock/delete/:id', isAdmin, async (req, res) => {
  const stockId = req.params.id;
  try {
    const result = await run('DELETE FROM ticket_stock WHERE id = ? AND status = \'Available\'', [stockId]);
    if (result.changes > 0) {
      req.session.flash = { type: 'success', message: 'Stock entry deleted successfully.' };
    } else {
      req.session.flash = { type: 'danger', message: 'Could not delete stock. It may have already been distributed.' };
    }
  } catch (err) {
    console.error('Error deleting stock:', err);
    req.session.flash = { type: 'danger', message: 'Failed to delete stock entry.' };
  }
  res.redirect('/ticketing/stock');
});

// POST /ticketing/stock/clear-all - Clear all ticketing history
router.post('/stock/clear-all', isAdmin, async (req, res) => {
  try {
    await run('BEGIN TRANSACTION');

    // 1. Delete all accounting entries related to ticket sales
    await run("DELETE FROM accounting_transactions WHERE category = 'Ticket Sales'");

    // 2. Delete all ticket distributions (both stock-based and imported)
    await run("DELETE FROM ticket_distributions");

    // 3. Delete all ticket stock
    await run("DELETE FROM ticket_stock");

    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'All ticket stock and sales history has been cleared.' };
  } catch (err) {
    await run('ROLLBACK');
    req.session.flash = { type: 'danger', message: 'Failed to clear history.' };
    console.error('Error clearing all ticket history:', err);
  }
  res.redirect('/ticketing/stock');
});

// GET /ticketing/distribute - Show form to distribute tickets
router.get('/distribute', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const rides = await all(`
      SELECT id, name, rate
      FROM rides
      WHERE is_active = 1 ORDER BY name`);
    const staff = await all('SELECT id, name FROM booking_staff ORDER BY name');
    const stock = await all(`
      SELECT ts.id, ts.start_number, ts.end_number, ts.color, ts.rate 
      FROM ticket_stock ts
      WHERE ts.status = 'Available' AND ts.event_session_id = ?
      ORDER BY ts.rate, ts.start_number
    `, [activeSessionId]);
    const distributedTickets = await all(`
      SELECT td.id, td.distribution_date, s.name as staff_name, r.name as ride_name, ts.color, ts.start_number, ts.end_number
      FROM ticket_distributions td
      JOIN ticket_stock ts ON td.stock_id = ts.id
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN rides r ON td.ride_id = r.id
      WHERE td.status = 'Distributed' AND td.event_session_id = ?
      ORDER BY td.distribution_date DESC
    `, [activeSessionId]);
    res.render('ticketingDistribute', { title: 'Distribute Tickets', rides, staff, stock, distributedTickets });
  } catch (err) {
    console.error('Error loading distribute tickets page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/distribute - Record a new ticket distribution from stock
router.post('/distribute', isAdmin, async (req, res) => {
  const { staff_id, ride_id, stock_id, distribution_date } = req.body;
  if (!staff_id || !ride_id || !stock_id || !distribution_date) {
    req.session.flash = { type: 'danger', message: 'All fields are required.' };
    return res.redirect('/ticketing/distribute');
  }
  const activeSessionId = res.locals.activeSession.id;
  try {
    const stockItem = await get('SELECT * FROM ticket_stock WHERE id = ?', [stock_id]);
    const sql = 'INSERT INTO ticket_distributions (distribution_date, staff_id, ride_id, stock_id, distributed_start_number, distributed_end_number, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await run(sql, [distribution_date, staff_id, ride_id, stock_id, stockItem.start_number, stockItem.end_number, activeSessionId]);
    await run("UPDATE ticket_stock SET status = 'Distributed' WHERE id = ?", [stock_id]);
    req.session.flash = { type: 'success', message: 'Tickets distributed successfully.' };
    res.redirect('/ticketing/distribute');
  } catch (err) {
    console.error('Error distributing tickets:', err);
    req.session.flash = { type: 'danger', message: 'Failed to distribute tickets.' };
    res.redirect('/ticketing/distribute');
  }
});

// GET /ticketing/distribute/edit/:id - Show form to edit a distribution
router.get('/distribute/edit/:id', isAdmin, async (req, res) => {
  try {
    const distribution = await get('SELECT * FROM ticket_distributions WHERE id = ?', [req.params.id]);
    if (!distribution || distribution.status !== 'Distributed') {
      req.session.flash = { type: 'danger', message: 'This distribution cannot be edited.' };
      return res.redirect('/ticketing/distribute');
    }
    const [staff, rides, availableStock] = await Promise.all([
      all('SELECT id, name FROM booking_staff ORDER BY name'),
      all(`
        SELECT id, name, rate
        FROM rides
        WHERE is_active = 1 ORDER BY name`),
      // Fetch all stock that is either 'Available' or is the one currently assigned to this distribution
      all(`
        SELECT ts.id, ts.start_number, ts.end_number, ts.color, ts.rate 
        FROM ticket_stock ts
        WHERE (ts.status = 'Available' OR ts.id = ?) AND ts.event_session_id = ?
        ORDER BY ts.rate, ts.start_number
      `, [distribution.stock_id, res.locals.activeSession.id])
    ]);
    res.render('editTicketingDistribution', {
      title: 'Edit Distribution',
      distribution,
      staff,
      rides,
      availableStock
    });
  } catch (err) {
    console.error('Error loading distribution edit page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/distribute/edit/:id - Update a distribution
router.post('/distribute/edit/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  const { staff_id, ride_id, stock_id } = req.body;
  try {
    await run('BEGIN TRANSACTION');

    // Get the original distribution to find the old stock ID
    const originalDistribution = await get('SELECT stock_id FROM ticket_distributions WHERE id = ?', [distributionId]);
    const old_stock_id = originalDistribution.stock_id;

    // Release the old stock bundle
    await run('UPDATE ticket_stock SET status = "Available" WHERE id = ?', [old_stock_id]);

    // Mark the new stock bundle as Distributed
    await run('UPDATE ticket_stock SET status = "Distributed" WHERE id = ?', [stock_id]);

    // Get details from the new stock to update the distribution record
    const newStock = await get('SELECT start_number, end_number FROM ticket_stock WHERE id = ?', [stock_id]);

    await run('UPDATE ticket_distributions SET staff_id = ?, ride_id = ?, stock_id = ?, distributed_start_number = ?, distributed_end_number = ? WHERE id = ? AND status = \'Distributed\'', [staff_id, ride_id, stock_id, newStock.start_number, newStock.end_number, distributionId]);
    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Distribution updated successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error updating distribution:', err);
    req.session.flash = { type: 'danger', message: 'Failed to update distribution.' };
  }
  res.redirect('/ticketing/distribute');
});

// POST /ticketing/distribute/delete/:id - Recall a distributed ticket book
router.post('/distribute/delete/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  try {
    const distribution = await get('SELECT stock_id FROM ticket_distributions WHERE id = ? AND status = \'Distributed\'', [distributionId]);
    if (!distribution) {
      req.session.flash = { type: 'danger', message: 'Distribution not found or cannot be recalled.' };
      return res.redirect('/ticketing/distribute');
    }
    await run('BEGIN TRANSACTION');
    await run('UPDATE ticket_stock SET status = \'Available\' WHERE id = ?', [distribution.stock_id]);
    await run('DELETE FROM ticket_distributions WHERE id = ?', [distributionId]);
    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Ticket bundle has been recalled and is now available.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error recalling distribution:', err);
    req.session.flash = { type: 'danger', message: 'Failed to recall ticket bundle.' };
  }
  res.redirect('/ticketing/distribute');
});

// GET /ticketing/distribute/bulk - Show form for bulk distribution
router.get('/distribute/bulk', isAdmin, (req, res) => {
  res.render('ticketingDistributeBulk', { title: 'Bulk Distribute Tickets' });
});

// POST /ticketing/distribute/bulk - Process bulk distribution CSV
router.post('/distribute/bulk', isAdmin, upload.single('distributeFile'), async (req, res) => {
  if (!req.file) {
    req.session.flash = { type: 'danger', message: 'No file was uploaded.' };
    return res.redirect('/ticketing/distribute/bulk');
  }

  const filePath = req.file.path;
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const rows = fileContent.split('\n').filter(row => row.trim() !== '');
  const activeSessionId = res.locals.activeSession.id;

  try {
    await run('BEGIN TRANSACTION');

    for (const [index, row] of rows.entries()) {
      const [distribution_date, staff_name, ride_name, stock_start_number] = row.split(',').map(field => field.trim());

      if (!distribution_date || !staff_name || !ride_name || !stock_start_number) {
        throw new Error(`Row ${index + 1}: Incomplete data. All four fields are required.`);
      }

      const staff = await get('SELECT id FROM booking_staff WHERE name = ?', [staff_name]);
      if (!staff) throw new Error(`Row ${index + 1}: Staff member "${staff_name}" not found.`);

      const ride = await get('SELECT id, rate FROM rides WHERE name = ?', [ride_name]);
      if (!ride) throw new Error(`Row ${index + 1}: Ride "${ride_name}" not found.`);

      const stock = await get('SELECT id, start_number, end_number FROM ticket_stock WHERE start_number = ? AND status = "Available" AND rate = ? AND event_session_id = ?', [stock_start_number, ride.rate, activeSessionId]);
      if (!stock) throw new Error(`Row ${index + 1}: Available stock bundle starting with "${stock_start_number}" for rate ${ride.rate} not found.`);

      const sql = 'INSERT INTO ticket_distributions (distribution_date, staff_id, ride_id, stock_id, distributed_start_number, distributed_end_number, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
      await run(sql, [distribution_date, staff.id, ride.id, stock.id, stock.start_number, stock.end_number, activeSessionId]);
      await run("UPDATE ticket_stock SET status = 'Distributed' WHERE id = ?", [stock.id]);
    }

    await run('COMMIT');
    req.session.flash = { type: 'success', message: `Successfully distributed ${rows.length} ticket bundles.` };
    res.redirect('/ticketing/distribute');
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error during bulk ticket distribution:', err);
    req.session.flash = { type: 'danger', message: `Import failed: ${err.message}` };
    res.redirect('/ticketing/distribute/bulk');
  } finally {
    // Clean up the uploaded file
    fs.unlinkSync(filePath);
  }
});

// GET /ticketing/settle - Show unsettled distributions
router.get('/settle', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const { q } = req.query;

    let unsettledSql = `
      SELECT td.*, s.name as staff_name, r.name as ride_name, r.rate
      FROM ticket_distributions td
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN rides r ON td.ride_id = r.id
    `;
    const unsettledParams = [activeSessionId];
    const unsettledWhere = ["td.status = 'Distributed'", "td.event_session_id = ?"];
    if (q) {
      unsettledWhere.push('(s.name LIKE ? OR r.name LIKE ?)');
      unsettledParams.push(`%${q}%`, `%${q}%`);
    }
    unsettledSql += ` WHERE ${unsettledWhere.join(' AND ')} ORDER BY td.distribution_date, s.name`;
    const unsettled = await all(unsettledSql, unsettledParams);

    let settledSql = `
      SELECT td.*, s.name as staff_name, r.name as ride_name, u.username as settled_by
      FROM ticket_distributions td
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN rides r ON td.ride_id = r.id
      LEFT JOIN users u ON td.settled_by_user_id = u.id
    `;
    const settledParams = [activeSessionId];
    const settledWhere = ["td.status = 'Settled'", "td.event_session_id = ?"];
    if (q) {
      settledWhere.push('(s.name LIKE ? OR r.name LIKE ?)');
      settledParams.push(`%${q}%`, `%${q}%`);
    }
    settledSql += ` WHERE ${settledWhere.join(' AND ')} ORDER BY td.settlement_date DESC, td.id DESC LIMIT 10`;
    const settled = await all(settledSql, settledParams);

    // --- Data for Cash Settlement ---
    const staffList = await all('SELECT id, name FROM booking_staff ORDER BY name');
    const unsettledTotals = await all(`
      SELECT s.name, SUM(ss.difference) as total_unsettled
      FROM staff_settlements ss
      JOIN booking_staff s ON ss.staff_id = s.id
      WHERE ss.event_session_id = ? AND ss.status = 'unsettled'
      GROUP BY ss.staff_id
      HAVING total_unsettled != 0
    `, [activeSessionId]);

    res.render('ticketingSettle', {
      title: 'Settle Ticket Sales',
      distributions: unsettled,
      settledDistributions: settled,
      filters: { q: q || '' },
      staffList,
      unsettledTotals
    });
  } catch (err) {
    console.error('Error loading settlement page:', err);
    res.status(500).send('Error loading page.');
  }
});

// GET /ticketing/settle/confirm/:id - Show confirmation page before settling
router.get('/settle/confirm/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  const { returned_start_number } = req.query;

  try {
    const distribution = await get(`
      SELECT td.*, s.name as staff_name, r.name as ride_name, r.rate
      FROM ticket_distributions td
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN rides r ON td.ride_id = r.id
      WHERE td.id = ? AND td.status = 'Distributed'
    `, [distributionId]);

    if (!distribution) {
      req.session.flash = { type: 'danger', message: 'Distribution not found or already settled.' };
      return res.redirect('/ticketing/settle');
    }

    const tickets_sold = parseInt(returned_start_number) - distribution.distributed_start_number;
    const total_revenue = tickets_sold * distribution.rate;

    res.render('ticketingSettleConfirm', {
      title: 'Confirm Settlement',
      distribution,
      returned_start_number,
      tickets_sold,
      total_revenue
    });
  } catch (err) {
    console.error('Error loading settlement confirmation:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/settle/:id - Settle a distribution
router.post('/settle/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  const { returned_start_number, upi_amount } = req.body;

  try {
    const dist = await get('SELECT * FROM ticket_distributions WHERE id = ? AND status = "Distributed"', [distributionId]);
    if (!dist) {
      req.session.flash = { type: 'danger', message: 'Distribution not found or already settled.' };
      return res.redirect('/ticketing/settle');
    }
    // Use the original distribution date as the settlement date
    const settlement_date = dist.distribution_date;

    const ride = await get('SELECT rate FROM rides WHERE id = ?', [dist.ride_id]);
    const originalStock = await get('SELECT * FROM ticket_stock WHERE id = ?', [dist.stock_id]);

    const returnedStart = parseInt(returned_start_number);
    if (returnedStart < dist.distributed_start_number || returnedStart > originalStock.end_number + 1) {
      req.session.flash = { type: 'danger', message: 'Invalid returned start number. It is outside the bundle range.' };
      return res.redirect('/ticketing/settle');
    }
    const tickets_sold = returnedStart - dist.distributed_start_number;
    const calculated_revenue = tickets_sold * ride.rate;

    const upiAmount = parseFloat(upi_amount) || 0;
    const cashAmount = calculated_revenue - upiAmount;

    await run('BEGIN TRANSACTION');

    // 1. Update distribution record
    const updateSql = `UPDATE ticket_distributions SET returned_start_number = ?, settlement_date = ?, tickets_sold = ?, calculated_revenue = ?, upi_amount = ?, cash_amount = ?, status = 'Settled', settled_by_user_id = ? WHERE id = ?`;
    await run(updateSql, [returnedStart, settlement_date, tickets_sold, calculated_revenue, upiAmount, cashAmount, req.session.user.id, distributionId]);

    // 2. Update stock status to Settled
    await run("UPDATE ticket_stock SET status = 'Settled' WHERE id = ?", [dist.stock_id]);

    // 3. If there are unsold tickets, create a new 'Available' stock bundle with the remainder
    if (returnedStart <= originalStock.end_number) {
      const newStockSql = `
        INSERT INTO ticket_stock (rate, color, start_number, end_number, status, event_session_id) 
        VALUES (?, ?, ?, ?, 'Available', ?)
      `;
      await run(newStockSql, [originalStock.rate, originalStock.color, returnedStart, originalStock.end_number, originalStock.event_session_id]);
    }

    // 3. Add to accounting
    const accountingSql = `INSERT INTO accounting_transactions (transaction_type, category, description, amount, transaction_date, user_id) VALUES (?, ?, ?, ?, ?, ?)`;
    await run(accountingSql, ['income', 'Ticket Sales', `Settlement for distribution #${distributionId}`, calculated_revenue, settlement_date, req.session.user.id]);

    await run('COMMIT');

    req.session.flash = { type: 'success', message: `Settlement successful. Revenue: ₹${calculated_revenue.toFixed(2)}` };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error settling distribution:', err);
    req.session.flash = { type: 'danger', message: 'Failed to settle distribution.' };
  }
  res.redirect('/ticketing/settle');
});

// POST /ticketing/settle/cancel/:id - Cancel a distributed (but not settled) ticket book
router.post('/settle/cancel/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  try {
    const distribution = await get('SELECT * FROM ticket_distributions WHERE id = ? AND status = \'Distributed\'', [distributionId]);
    if (!distribution) {
      req.session.flash = { type: 'danger', message: 'Distribution not found or has already been settled.' };
      return res.redirect('/ticketing/settle');
    }

    await run('BEGIN TRANSACTION');
    // 1. Revert the stock status to 'Available'
    await run('UPDATE ticket_stock SET status = \'Available\' WHERE id = ?', [distribution.stock_id]);
    // 2. Mark the distribution as 'Cancelled'
    await run('UPDATE ticket_distributions SET status = \'Cancelled\' WHERE id = ?', [distributionId]);
    await run('COMMIT');

    req.session.flash = { type: 'success', message: 'The ticket distribution has been successfully cancelled.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error cancelling distribution:', err);
    req.session.flash = { type: 'danger', message: 'Failed to cancel the distribution.' };
  }
  res.redirect('/ticketing/settle');
});

// POST /ticketing/unsettle/:id - Reverts a settled distribution
router.post('/unsettle/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  try {
    const distribution = await get('SELECT * FROM ticket_distributions WHERE id = ? AND status = \'Settled\'', [distributionId]);
    if (!distribution) {
      req.session.flash = { type: 'danger', message: 'Settlement not found or already unsettled.' };
      return res.redirect('/ticketing');
    }

    await run('BEGIN TRANSACTION');

    // 1. Delete the corresponding accounting transaction
    await run('DELETE FROM accounting_transactions WHERE description = ?', [`Settlement for distribution #${distributionId}`]);

    // 2. Revert the stock status to 'Distributed'
    await run('UPDATE ticket_stock SET status = \'Distributed\' WHERE id = ?', [distribution.stock_id]);

    // 3. Revert the distribution record itself
    await run('UPDATE ticket_distributions SET status = \'Distributed\', returned_start_number = NULL, settlement_date = NULL, tickets_sold = NULL, calculated_revenue = NULL, settled_by_user_id = NULL WHERE id = ?', [distributionId]);

    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'The settlement has been successfully reversed.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error unsettling distribution:', err);
    req.session.flash = { type: 'danger', message: 'Failed to reverse the settlement.' };
  }
  res.redirect('/ticketing/settle');
});

// GET /ticketing/report/daily - Show detailed daily sales report
router.get('/report/daily', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const { start_date, end_date } = req.query;

    let sql = `
      SELECT
        td.settlement_date,
        r.name as ride_name,
        r.rate,
        SUM(td.tickets_sold) as total_tickets_sold,
        SUM(td.calculated_revenue) as total_revenue,
        SUM(td.upi_amount) as total_upi,
        SUM(td.cash_amount) as total_cash
      FROM ticket_distributions td
      JOIN rides r ON td.ride_id = r.id
      WHERE td.status = 'Settled'
      AND td.event_session_id = ?
    `;
    const params = [activeSessionId];

    if (start_date) {
      sql += ' AND td.settlement_date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND td.settlement_date <= ?';
      params.push(end_date);
    }

    sql += ' GROUP BY td.settlement_date, r.name, r.rate ORDER BY td.settlement_date DESC, total_revenue DESC';

    const results = await all(sql, params);

    // Process data to group by date
    const salesByDate = results.reduce((acc, row) => {
      const date = row.settlement_date;
      if (!acc[date]) {
        acc[date] = {
          rides: [],
          daily_total_tickets: 0,
          daily_total_revenue: 0,
          daily_total_upi: 0,
          daily_total_cash: 0
        };
      }
      acc[date].rides.push(row);
      acc[date].daily_total_tickets += row.total_tickets_sold;
      acc[date].daily_total_revenue += row.total_revenue;
      acc[date].daily_total_upi += row.total_upi;
      acc[date].daily_total_cash += row.total_cash;
      return acc;
    }, {});

    // Calculate grand totals for the summary cards
    const grandTotal = {
      revenue: 0,
      tickets: 0,
      upi: 0,
      cash: 0
    };
    for (const date in salesByDate) {
      grandTotal.revenue += salesByDate[date].daily_total_revenue;
      grandTotal.tickets += salesByDate[date].daily_total_tickets;
      grandTotal.upi += salesByDate[date].daily_total_upi;
      grandTotal.cash += salesByDate[date].daily_total_cash;
    }

    res.render('ticketingDailyReport', {
      title: 'Daily Ticket Sales Report',
      salesByDate,
      grandTotal,
      filters: { start_date: start_date || '', end_date: end_date || '' }
    });
  } catch (err) {
    console.error('Error loading daily sales report:', err);
    res.status(500).send('Error loading report.');
  }
});

// GET /ticketing/report/stock - Show the current status of all ticket stock
router.get('/report/stock', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const { rate: rateFilter } = req.query;

    // Base query
    let sql = `
      WITH StockTotals AS (
        SELECT
          color,
          rate,
          SUM(end_number - start_number + 1) as initial_stock
        FROM ticket_stock
        WHERE event_session_id = ?
        GROUP BY color, rate
      ),
      AggregatedSales AS (
        SELECT
          ts.color,
          ts.rate,
          SUM(CASE WHEN td.status = 'Settled' THEN td.tickets_sold ELSE 0 END) as sold_stock,
          SUM(CASE WHEN td.status = 'Distributed' THEN (ts.end_number - ts.start_number + 1) ELSE 0 END) as distributed_stock
        FROM ticket_distributions td
        JOIN ticket_stock ts ON td.stock_id = ts.id
        WHERE td.event_session_id = ?
        GROUP BY ts.color, ts.rate
      )
      SELECT
        st.color,
        st.rate,
        st.initial_stock,
        COALESCE(ags.sold_stock, 0) as sold_stock,
        COALESCE(ags.distributed_stock, 0) as distributed_stock,
        (st.initial_stock - COALESCE(ags.sold_stock, 0) - COALESCE(ags.distributed_stock, 0)) as available_stock
      FROM StockTotals st
      LEFT JOIN AggregatedSales ags ON st.color = ags.color AND st.rate = ags.rate
    `;
    const params = [activeSessionId, activeSessionId];
    const whereClauses = [];

    if (rateFilter && rateFilter !== 'all') {
      whereClauses.push('ts.rate = ?');
      params.push(parseFloat(rateFilter));
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    sql += ` ORDER BY st.rate, st.color`;

    const [stockSummary, allRates] = await Promise.all([
      all(sql, params),
      all('SELECT DISTINCT rate FROM ticket_stock WHERE event_session_id = ? AND rate IS NOT NULL ORDER BY rate DESC', [activeSessionId])
    ]);

    // --- Prepare data for the chart ---
    const rates = [...new Set(stockSummary.map(item => `₹${item.rate.toFixed(2)}`))].sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)));
    const colors = [...new Set(stockSummary.map(item => item.color))];

    const datasets = colors.map(color => {
      const data = rates.map(rateString => {
        const rateValue = parseFloat(rateString.slice(1));
        const item = stockSummary.find(s => s.color === color && s.rate === rateValue);
        return item ? item.available_stock : 0;
      });
      return {
        label: color,
        data: data,
        backgroundColor: color.toLowerCase(),
      };
    });

    const chartData = {
      labels: rates,
      datasets: datasets
    };

    res.render('ticketingStockReport', {
      title: 'Ticket Stock Status Report',
      stockSummary,
      chartData,
      allRates,
      filters: { rate: rateFilter || 'all' }
    });
  } catch (err) {
    console.error('Error loading stock status report:', err);
    res.status(500).send('Error loading report.');
  }
});


// GET /ticketing/import - Show form to import old sales data
router.get('/import', isAdmin, async (req, res) => {
  try {
    const rides = await all(`
      SELECT id, name, rate 
      FROM rides 
      WHERE is_active = 1 ORDER BY name`);
    res.render('ticketingImport', { title: 'Import Past Sales', rides });
  } catch (err) {
    console.error('Error loading import page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/import - Create a settled record from old data
router.post('/import', isAdmin, async (req, res) => {
  const { settlement_date, ride_id, tickets_sold, upi_amount } = req.body;
  if (!settlement_date || !ride_id || !tickets_sold) {
    req.session.flash = { type: 'danger', message: 'Date, Ride, and Tickets Sold are required.' };
    return res.redirect('/ticketing/import');
  }
  const activeSessionId = res.locals.activeSession.id;

  try {
    const ride = await get('SELECT rate FROM rides WHERE id = ?', [ride_id]);
    if (!ride) {
      req.session.flash = { type: 'danger', message: 'Invalid ride selected.' };
      return res.redirect('/ticketing/import');
    }

    await run('BEGIN TRANSACTION');

    const ticketsSold = parseInt(tickets_sold);
    const calculatedRevenue = ticketsSold * ride.rate;
    const upiAmount = parseFloat(upi_amount) || 0;
    const cashAmount = calculatedRevenue - upiAmount;

    const distSql = `INSERT INTO ticket_distributions (distribution_date, settlement_date, staff_id, ride_id, tickets_sold, calculated_revenue, upi_amount, cash_amount, status, settled_by_user_id, distributed_start_number, distributed_end_number, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Settled', ?, 0, 0, ?)`;
    const { lastID: distributionId } = await run(distSql, [settlement_date, settlement_date, 1, ride_id, ticketsSold, calculatedRevenue, upiAmount, cashAmount, req.session.user.id, activeSessionId]);

    const accountingSql = `INSERT INTO accounting_transactions (transaction_type, category, description, amount, transaction_date, user_id) VALUES (?, ?, ?, ?, ?, ?)`;
    await run(accountingSql, ['income', 'Ticket Sales', `Imported sale for distribution #${distributionId}`, calculatedRevenue, settlement_date, req.session.user.id]);

    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Past sale imported successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error importing past sale:', err);
    req.session.flash = { type: 'danger', message: 'Failed to import past sale.' };
  }
  res.redirect('/ticketing');
});

// GET /ticketing/import/edit/:id - Show form to edit an imported sale
router.get('/import/edit/:id', isAdmin, async (req, res) => {
  try {
    const sale = await get(`
      SELECT td.*, r.name as ride_name, r.rate
      FROM ticket_distributions td
      JOIN rides r ON td.ride_id = r.id
      WHERE td.id = ? AND (td.stock_id IS NULL OR td.stock_id = 0)
    `, [req.params.id]);

    if (!sale) {
      req.session.flash = { type: 'danger', message: 'Imported sale not found.' };
      return res.redirect('/ticketing');
    }
    res.render('editTicketingImport', { title: 'Edit Imported Sale', sale });
  } catch (err) {
    console.error('Error loading imported sale for editing:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/import/edit/:id - Update an imported sale
router.post('/import/edit/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  const { settlement_date, ride_name, rate, tickets_sold, upi_amount } = req.body;

  try {
    await run('BEGIN TRANSACTION');

    // Find or create the ride
    let rideRecord = await get('SELECT id FROM rides WHERE name = ?', [ride_name]);
    if (!rideRecord) { // If ride doesn't exist, create it with the specified rate
      const result = await run('INSERT INTO rides (name, rate) VALUES (?, ?)', [ride_name, parseFloat(rate)]);
      rideRecord = { id: result.lastID };
    }
    
    const ticketsSold = parseInt(tickets_sold);
    const calculatedRevenue = ticketsSold * parseFloat(rate);
    const upiAmount = parseFloat(upi_amount) || 0;
    const cashAmount = calculatedRevenue - upiAmount;

    const updateDistSql = `UPDATE ticket_distributions SET settlement_date = ?, ride_id = ?, tickets_sold = ?, calculated_revenue = ?, upi_amount = ?, cash_amount = ? WHERE id = ? AND (stock_id IS NULL OR stock_id = 0)`;
    await run(updateDistSql, [settlement_date, rideRecord.id, ticketsSold, calculatedRevenue, upiAmount, cashAmount, distributionId]);

    const updateAccSql = `UPDATE accounting_transactions SET amount = ?, transaction_date = ? WHERE description = ?`;
    await run(updateAccSql, [calculatedRevenue, settlement_date, `Imported sale for distribution #${distributionId}`]);

    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Imported sale updated successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error updating imported sale:', err);
    req.session.flash = { type: 'danger', message: 'Failed to update imported sale.' };
  }
  res.redirect('/ticketing');
});

// POST /ticketing/import/delete/:id - Delete an imported sale
router.post('/import/delete/:id', isAdmin, async (req, res) => {
  const distributionId = req.params.id;
  try {
    await run('BEGIN TRANSACTION');

    // 1. Delete the accounting transaction first
    await run('DELETE FROM accounting_transactions WHERE description = ?', [`Settlement for distribution #${distributionId}`]);

    // 2. Delete the distribution record
    await run('DELETE FROM ticket_distributions WHERE id = ? AND (stock_id IS NULL OR stock_id = 0)', [distributionId]);

    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Imported sale deleted successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error deleting imported sale:', err);
    req.session.flash = { type: 'danger', message: 'Failed to delete imported sale.' };
  }
  res.redirect('/ticketing');
});

// GET /ticketing/import/bulk - Show form for bulk import of past sales
router.get('/import/bulk', isAdmin, (req, res) => {
  res.render('ticketingImportBulk', { title: 'Bulk Import Past Sales' });
});

// POST /ticketing/import/bulk - Process bulk import CSV
router.post('/import/bulk', isAdmin, upload.single('importFile'), async (req, res) => {
  if (!req.file) {
    req.session.flash = { type: 'danger', message: 'No file was uploaded.' };
    return res.redirect('/ticketing/import/bulk');
  }

  const filePath = req.file.path;
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const rows = fileContent.split('\n').filter(row => row.trim() !== '');
  const activeSessionId = res.locals.activeSession.id;
  const adminUserId = req.session.user.id;

  try {
    await run('BEGIN TRANSACTION');

    for (const [index, row] of rows.entries()) {
      const [settlement_date, ride_name, rate, tickets_sold, upi_amount] = row.split(',').map(field => field.trim());

      if (!settlement_date || !ride_name || !rate || !tickets_sold) {
        throw new Error(`Row ${index + 1} is incomplete. Date, Ride Name, Rate, and Tickets Sold are required.`);
      }

      // Find or create the ride
      let rideRecord = await get('SELECT id FROM rides WHERE name = ?', [ride_name]);
      if (!rideRecord) {
        const result = await run('INSERT INTO rides (name, rate) VALUES (?, ?)', [ride_name, parseFloat(rate)]);
        rideRecord = { id: result.lastID };
      }

      const ticketsSoldNum = parseInt(tickets_sold);
      const calculatedRevenue = ticketsSoldNum * parseFloat(rate);
      const upiAmountNum = parseFloat(upi_amount) || 0;
      const cashAmount = calculatedRevenue - upiAmountNum;

      const distSql = `INSERT INTO ticket_distributions (distribution_date, settlement_date, staff_id, ride_id, tickets_sold, calculated_revenue, upi_amount, cash_amount, status, settled_by_user_id, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Settled', ?, ?)`;
      const { lastID: distributionId } = await run(distSql, [settlement_date, settlement_date, 1, rideRecord.id, ticketsSoldNum, calculatedRevenue, upiAmountNum, cashAmount, adminUserId, activeSessionId]);

      const accountingSql = `INSERT INTO accounting_transactions (transaction_type, category, description, amount, transaction_date, user_id, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      await run(accountingSql, ['income', 'Ticket Sales', `Imported sale for distribution #${distributionId}`, calculatedRevenue, settlement_date, adminUserId, activeSessionId]);
    }

    await run('COMMIT');
    req.session.flash = { type: 'success', message: `Successfully imported ${rows.length} past sales records.` };
    res.redirect('/ticketing');
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error during bulk sales import:', err);
    req.session.flash = { type: 'danger', message: `Import failed: ${err.message}` };
    res.redirect('/ticketing/import/bulk');
  } finally {
    // Clean up the uploaded file
    fs.unlinkSync(filePath);
  }
});

// --- Staff Cash Settlement (Short/Excess) Routes ---

// GET: Show the staff cash settlement page
router.get('/cash-settle', isAdmin, async (req, res) => {
  // This route is now combined into GET /ticketing/settle
  res.redirect('/ticketing/settle');
});

// API GET: Calculate expected amount for a staff member (placeholder logic)
router.get('/api/expected-amount/:staff_id', isAdmin, async (req, res) => {
  try {
    const { staff_id } = req.params;
    const viewingSessionId = res.locals.viewingSession.id;

    // NOTE: This query is a placeholder. It needs to be adapted to your actual
    // logic for calculating expected cash from a staff member.
    // For example, it could sum `cash_amount` from settled `ticket_distributions`.
    const lastSettlement = await get('SELECT MAX(settlement_date) as last_date FROM staff_settlements WHERE staff_id = ? AND event_session_id = ?', [staff_id, viewingSessionId]);
    const lastSettlementDate = lastSettlement?.last_date || '1970-01-01';

    const result = await get(`
      SELECT SUM(cash_amount) as expected
      FROM ticket_distributions
      WHERE staff_id = ? 
      AND event_session_id = ?
      AND settlement_date > ?
    `, [staff_id, viewingSessionId, lastSettlementDate]);

    res.json({ expected_amount: result?.expected || 0 });
  } catch (err) {
    console.error('Error fetching expected amount:', err.message);
    res.status(500).json({ error: 'Failed to calculate expected amount.' });
  }
});

// POST: Save a new cash settlement record
router.post('/cash-settle', isAdmin, async (req, res) => {
  const { staff_id, expected_amount, actual_amount, notes } = req.body;
  const activeSessionId = res.locals.activeSession.id;

  if (!staff_id || !expected_amount || !actual_amount) {
    req.session.flash = { type: 'danger', message: 'Missing required fields.' };
    return res.redirect('/ticketing/cash-settle');
  }

  const difference = parseFloat(actual_amount) - parseFloat(expected_amount);

  try {
    await run(`
      INSERT INTO staff_settlements
        (staff_id, event_session_id, settlement_date, expected_amount, actual_amount, difference, notes)
      VALUES (?, ?, date('now'), ?, ?, ?, ?)
    `, [staff_id, activeSessionId, expected_amount, actual_amount, difference, notes]);

    req.session.flash = { type: 'success', message: 'Cash settlement recorded successfully.' };
    res.redirect('/ticketing/cash-settle');
  } catch (err) {
    console.error('Error saving cash settlement:', err.message);
    req.session.flash = { type: 'danger', message: 'Failed to save settlement.' };
    res.redirect('/ticketing/cash-settle');
  }
});

// GET: Show the weekly cash settlement review page
router.get('/cash-settle/review', isAdmin, async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const unsettledTransactions = await all(`
      SELECT ss.id, ss.settlement_date, ss.expected_amount, ss.actual_amount, ss.difference, ss.notes, s.name as staff_name
      FROM staff_settlements ss
      JOIN booking_staff s ON ss.staff_id = s.id
      WHERE ss.event_session_id = ? AND ss.status = 'unsettled'
      ORDER BY s.name, ss.settlement_date
    `, [viewingSessionId]);

    const settlementsByStaff = unsettledTransactions.reduce((acc, tx) => {
      if (!acc[tx.staff_name]) {
        acc[tx.staff_name] = { transactions: [], total_difference: 0 };
      }
      acc[tx.staff_name].transactions.push(tx);
      acc[tx.staff_name].total_difference += tx.difference;
      return acc;
    }, {});

    res.render('ticketSettleReview', {
      title: 'Review Cash Settlements',
      settlementsByStaff
    });

  } catch (err) {
    console.error('Error loading weekly settlement review page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Mark selected cash settlements as 'settled'
router.post('/cash-settle/review', isAdmin, async (req, res) => {
  let { settlement_ids } = req.body;
  if (!settlement_ids) {
    req.session.flash = { type: 'info', message: 'No settlements were selected.' };
    return res.redirect('/ticketing/cash-settle/review');
  }
  if (!Array.isArray(settlement_ids)) settlement_ids = [settlement_ids];

  const placeholders = settlement_ids.map(() => '?').join(',');
  await run(`UPDATE staff_settlements SET status = 'settled', settled_by_user_id = ?, settled_on_date = date('now') WHERE id IN (${placeholders})`, [req.session.user.id, ...settlement_ids]);

  req.session.flash = { type: 'success', message: `${settlement_ids.length} transaction(s) have been settled.` };
  res.redirect('/ticketing/cash-settle/review');
});

module.exports = router;