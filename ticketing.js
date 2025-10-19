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
    const sales = await all(`
      SELECT td.*, u.username as settled_by, s.name as staff_name, tr.name as rate_name
      FROM ticket_distributions td
      LEFT JOIN users u ON td.settled_by_user_id = u.id
      LEFT JOIN booking_staff s ON td.staff_id = s.id
      JOIN ticket_rates tr ON td.rate_id = tr.id
      WHERE td.status = 'Settled' AND td.event_session_id = ?
      ORDER BY td.settlement_date DESC, td.id DESC
    `, [activeSessionId]);
    res.render('ticketing', { title: 'Ticketing Sales Dashboard', sales });
  } catch (err) {
    console.error('Error loading ticketing page:', err);
    res.status(500).send('Error loading ticketing data.');
  }
});

// GET /ticketing/rides - Show form to manage rides
router.get('/rides', isAdmin, async (req, res) => {
  try {
    const rides = await all(`
      SELECT tr.*, br.rate FROM ticket_rates tr
      JOIN base_rates br ON tr.base_rate_id = br.id
      ORDER BY tr.name`);
    const baseRates = await all('SELECT * FROM base_rates ORDER BY rate DESC');
    res.render('ticketingRides', { title: 'Manage Rides & Rates', rides, baseRates });
  } catch (err) {
    console.error('Error loading rides page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/rides/add - Add a new ride
router.post('/rides/add', isAdmin, async (req, res) => {
  const { name, rate } = req.body;
  if (!name || !rate) { // rate is now base_rate_id
    req.session.flash = { type: 'danger', message: 'Name and Rate are required.' };
    return res.redirect('/ticketing/rides');
  }
  try {
    await run('INSERT INTO ticket_rates (name, base_rate_id) VALUES (?, ?)', [name, rate]);
    req.session.flash = { type: 'success', message: 'Ride added successfully.' };
  } catch (err) {
    req.session.flash = { type: 'danger', message: 'Failed to add ride. It might already exist.' };
  }
  res.redirect('/ticketing/rides');
});

// POST /ticketing/rides/delete/:id - Delete a ride
router.post('/rides/delete/:id', isAdmin, async (req, res) => {
  await run('DELETE FROM ticket_rates WHERE id = ?', [req.params.id]);
  res.redirect('/ticketing/rides');
});

// GET /ticketing/stock - Show form to manage stock
router.get('/stock', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const baseRates = await all('SELECT * FROM base_rates ORDER BY rate DESC');
    const stock = await all(`
      SELECT ts.*, br.rate
      FROM ticket_stock ts
      LEFT JOIN base_rates br ON ts.base_rate_id = br.id
      WHERE ts.event_session_id = ?
      ORDER BY ts.created_at DESC
    `, [activeSessionId]);
    res.render('ticketingStock', { title: 'Manage Ticket Stock', baseRates, stock });
  } catch (err) {
    console.error('Error loading ticket stock page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/stock/add - Add a new stock entry
router.post('/stock/add', isAdmin, async (req, res) => {
  const { base_rate_id, color, start_number, end_number } = req.body;
  if (!base_rate_id || !color || !start_number || !end_number) {
    req.session.flash = { type: 'danger', message: 'All fields are required.' };
    return res.redirect('/ticketing/stock');
  }
  const activeSessionId = res.locals.activeSession.id;
  try {
    await run('INSERT INTO ticket_stock (base_rate_id, color, start_number, end_number, status, event_session_id) VALUES (?, ?, ?, ?, ?, ?)', [base_rate_id, color, parseInt(start_number), parseInt(end_number), 'Available', activeSessionId]);
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

    const baseRates = await all('SELECT id, rate FROM base_rates');
    const rateMap = new Map(baseRates.map(r => [r.rate.toString(), r.id]));

    for (const [index, row] of rows.entries()) {
      const [rate, color, start_number, end_number] = row.split(',').map(field => field.trim());

      if (!rate || !color || !start_number || !end_number) {
        throw new Error(`Row ${index + 1} is incomplete. All four fields are required.`);
      }

      const base_rate_id = rateMap.get(rate);
      if (!base_rate_id) {
        throw new Error(`Row ${index + 1} has an invalid rate: '${rate}'. Only 100 or 50 are allowed.`);
      }

      await run(
        'INSERT INTO ticket_stock (base_rate_id, color, start_number, end_number, status, event_session_id) VALUES (?, ?, ?, ?, ?, ?)',
        [base_rate_id, color, parseInt(start_number), parseInt(end_number), 'Available', activeSessionId]
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
      SELECT ts.*, br.rate 
      FROM ticket_stock ts 
      JOIN base_rates br ON ts.base_rate_id = br.id 
      WHERE ts.id = ?
    `, [req.params.id]);

    if (!stock) {
      req.session.flash = { type: 'danger', message: 'Stock entry not found.' };
      return res.redirect('/ticketing/stock');
    }
    if (stock.status !== 'Available') {
      req.session.flash = { type: 'danger', message: 'Cannot edit stock that has already been distributed or used.' };
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
  const { base_rate_id, color, start_number, end_number } = req.body;

  try {
    const baseRateRecord = await get('SELECT id FROM base_rates WHERE id = ?', [base_rate_id]);
    if (!baseRateRecord) {
      req.session.flash = { type: 'danger', message: `Invalid ticket rate.` };
      return res.redirect(`/ticketing/stock/edit/${stockId}`);
    }

    await run('UPDATE ticket_stock SET base_rate_id = ?, color = ?, start_number = ?, end_number = ? WHERE id = ? AND status = \'Available\'', [baseRateRecord.id, color, parseInt(start_number), parseInt(end_number), stockId]);
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
    const rides = await all('SELECT tr.*, br.rate FROM ticket_rates tr JOIN base_rates br ON tr.base_rate_id = br.id WHERE tr.is_active = 1 ORDER BY tr.name');
    const staff = await all('SELECT id, name FROM booking_staff ORDER BY name');
    const stock = await all(`
      SELECT ts.id, ts.start_number, ts.end_number, ts.color, br.rate 
      FROM ticket_stock ts
      JOIN base_rates br ON ts.base_rate_id = br.id
      WHERE ts.status = 'Available' AND ts.event_session_id = ?
      ORDER BY br.rate, ts.start_number
    `, [activeSessionId]);
    const distributedTickets = await all(`
      SELECT td.id, td.distribution_date, s.name as staff_name, tr.name as ride_name, ts.color, ts.start_number, ts.end_number
      FROM ticket_distributions td
      JOIN ticket_stock ts ON td.stock_id = ts.id
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN ticket_rates tr ON td.rate_id = tr.id
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
  const { staff_id, ride_id, stock_id } = req.body;
  if (!staff_id || !ride_id || !stock_id) {
    req.session.flash = { type: 'danger', message: 'All fields are required.' };
    return res.redirect('/ticketing/distribute');
  }
  const activeSessionId = res.locals.activeSession.id;
  try {
    const stockItem = await get('SELECT * FROM ticket_stock WHERE id = ?', [stock_id]);
    // Note: We use the ride_id for the distribution record's rate_id, and also store the stock_id
    const sql = 'INSERT INTO ticket_distributions (distribution_date, staff_id, rate_id, stock_id, distributed_start_number, distributed_end_number, event_session_id) VALUES (date(\'now\'), ?, ?, ?, ?, ?, ?)';
    await run(sql, [staff_id, ride_id, stock_id, stockItem.start_number, stockItem.end_number, activeSessionId]);
    await run("UPDATE ticket_stock SET status = 'Distributed' WHERE id = ?", [stock_id]);
    req.session.flash = { type: 'success', message: 'Tickets distributed successfully.' };
    res.redirect('/ticketing/settle'); // Redirect to settlement page to see the new entry
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
    const [staff, rides] = await Promise.all([
      all('SELECT id, name FROM booking_staff ORDER BY name'),
      all('SELECT tr.*, br.rate FROM ticket_rates tr JOIN base_rates br ON tr.base_rate_id = br.id WHERE tr.is_active = 1 ORDER BY tr.name')
    ]);
    res.render('editTicketingDistribution', { title: 'Edit Distribution', distribution, staff, rides });
  } catch (err) {
    console.error('Error loading distribution edit page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/distribute/edit/:id - Update a distribution
router.post('/distribute/edit/:id', isAdmin, async (req, res) => {
  const { staff_id, ride_id } = req.body;
  try {
    // You might add validation here to ensure the new ride's rate matches the stock's rate
    await run('UPDATE ticket_distributions SET staff_id = ?, rate_id = ? WHERE id = ? AND status = \'Distributed\'', [staff_id, ride_id, req.params.id]);
    req.session.flash = { type: 'success', message: 'Distribution updated successfully.' };
  } catch (err) {
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

// GET /ticketing/settle - Show unsettled distributions
router.get('/settle', isAdmin, async (req, res) => {
  try {
    const activeSessionId = res.locals.activeSession.id;
    const distributions = await all(`
      SELECT td.*, s.name as staff_name, tr.name as rate_name, tr.rate
      FROM ticket_distributions td
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN ticket_rates tr ON td.rate_id = tr.id
      WHERE td.status = 'Distributed' AND td.event_session_id = ?
      ORDER BY td.distribution_date, s.name
    `, [activeSessionId]);
    res.render('ticketingSettle', { title: 'Settle Ticket Sales', distributions });
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
      SELECT td.*, s.name as staff_name, tr.name as rate_name, tr.rate
      FROM ticket_distributions td
      JOIN booking_staff s ON td.staff_id = s.id
      JOIN ticket_rates tr ON td.rate_id = tr.id
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
  const settlement_date = new Date().toISOString().split('T')[0];

  try {
    const dist = await get('SELECT * FROM ticket_distributions WHERE id = ?', [distributionId]);
    const rateInfo = await get('SELECT rate FROM ticket_rates WHERE id = ?', [dist.rate_id]);

    const tickets_sold = parseInt(returned_start_number) - dist.distributed_start_number;
    const calculated_revenue = tickets_sold * rateInfo.rate;
    const upiAmount = parseFloat(upi_amount) || 0;
    const cashAmount = calculated_revenue - upiAmount;

    await run('BEGIN TRANSACTION');

    // 1. Update distribution record
    const updateSql = `UPDATE ticket_distributions SET returned_start_number = ?, settlement_date = ?, tickets_sold = ?, calculated_revenue = ?, upi_amount = ?, cash_amount = ?, status = 'Settled', settled_by_user_id = ? WHERE id = ?`;
    await run(updateSql, [parseInt(returned_start_number), settlement_date, tickets_sold, calculated_revenue, upiAmount, cashAmount, req.session.user.id, distributionId]);

    // 2. Update stock status to Settled
    await run("UPDATE ticket_stock SET status = 'Settled' WHERE id = ?", [dist.stock_id]);

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
        tr.name as ride_name,
        tr.rate,
        SUM(td.tickets_sold) as total_tickets_sold,
        SUM(td.calculated_revenue) as total_revenue,
        SUM(td.upi_amount) as total_upi,
        SUM(td.cash_amount) as total_cash
      FROM ticket_distributions td
      JOIN ticket_rates tr ON td.rate_id = tr.id
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

    sql += ' GROUP BY td.settlement_date, tr.name, tr.rate ORDER BY td.settlement_date DESC, total_revenue DESC';

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
    const { status, rate, page } = req.query;
    const currentPage = parseInt(page) || 1;
    const limit = 50; // Items per page
    const offset = (currentPage - 1) * limit;

    // Base query
    let sql = `
      SELECT
        ts.start_number,
        ts.end_number,
        ts.color,
        ts.status,
        ts.created_at,
        br.rate,
        s.name as staff_name
      FROM ticket_stock ts
      LEFT JOIN base_rates br ON ts.base_rate_id = br.id
      LEFT JOIN ticket_distributions td ON ts.id = td.stock_id AND td.status = 'Distributed'
      LEFT JOIN booking_staff s ON td.staff_id = s.id
    `;

    // Filtering
    const whereClauses = [];
    const params = [activeSessionId];
    whereClauses.push('ts.event_session_id = ?');

    if (status && status !== 'all') {
      whereClauses.push('ts.status = ?');
      params.push(status);
    }
    if (rate && rate !== 'all') {
      whereClauses.push('br.rate = ?');
      params.push(parseFloat(rate));
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    // Query for total count for pagination
    const countSql = `SELECT COUNT(ts.id) as count FROM ticket_stock ts ${sql.includes('LEFT JOIN base_rates') ? 'LEFT JOIN base_rates br ON ts.base_rate_id = br.id' : ''} ${whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : ''}`;
    const totalResult = await get(countSql, params);
    const totalItems = totalResult.count;
    const totalPages = Math.ceil(totalItems / limit);

    // Add ordering and pagination to main query
    sql += ' ORDER BY ts.status, br.rate, ts.start_number LIMIT ? OFFSET ?';
    params.push(limit, offset);

    // Query for summary counts
    let summarySql = `SELECT ts.status, COUNT(*) as count FROM ticket_stock ts`;
    const summaryParams = [activeSessionId];
    let summaryWhere = ['ts.event_session_id = ?'];
    if (rate && rate !== 'all') {
      summarySql += ` JOIN base_rates br ON ts.base_rate_id = br.id`;
      summaryWhere.push('br.rate = ?');
      summaryParams.push(parseFloat(rate));
    }
    summarySql += ' WHERE ' + summaryWhere.join(' AND ');
    summarySql += ` GROUP BY ts.status`;

    const summaryCountsRaw = await all(summarySql, summaryParams);
    const summaryCounts = { Available: 0, Distributed: 0, Settled: 0, Cancelled: 0 };
    summaryCountsRaw.forEach(row => {
      if (summaryCounts.hasOwnProperty(row.status)) {
        summaryCounts[row.status] = row.count;
      }
    });
    
    // Run all queries
    const [stock, allRates] = await Promise.all([
      all(sql, params),
      all('SELECT DISTINCT rate FROM base_rates ORDER BY rate DESC')
    ]);

    const pagination = {
      currentPage,
      totalPages,
      totalItems,
    };

    res.render('ticketingStockReport', {
      title: 'Ticket Stock Status Report',
      stock,
      summaryCounts,
      allRates,
      pagination,
      filters: { status: status || 'all', rate: rate || 'all' }
    });
  } catch (err) {
    console.error('Error loading stock status report:', err);
    res.status(500).send('Error loading report.');
  }
});


// GET /ticketing/import - Show form to import old sales data
router.get('/import', isAdmin, async (req, res) => {
  try {
    const rates = await all('SELECT * FROM ticket_rates ORDER BY rate');
    res.render('ticketingImport', { title: 'Import Past Sales', rates });
  } catch (err) {
    console.error('Error loading import page:', err);
    res.status(500).send('Error loading page.');
  }
});

// POST /ticketing/import - Create a settled record from old data
router.post('/import', isAdmin, async (req, res) => {
  const { settlement_date, rate_id, tickets_sold, upi_amount } = req.body;
  if (!settlement_date || !rate_id || !tickets_sold) {
    req.session.flash = { type: 'danger', message: 'Date, Ride, and Tickets Sold are required.' };
    return res.redirect('/ticketing/import');
  }
  const activeSessionId = res.locals.activeSession.id;

  try {
    await run('BEGIN TRANSACTION');

    const rateInfo = await get('SELECT rate FROM ticket_rates WHERE id = ?', [rate_id]);
    if (!rateInfo) {
      req.session.flash = { type: 'danger', message: 'Invalid ticket type selected.' };
      return res.redirect('/ticketing/import');
    }

    const ticketsSold = parseInt(tickets_sold);
    const calculatedRevenue = ticketsSold * rateInfo.rate;
    const upiAmount = parseFloat(upi_amount) || 0;
    const cashAmount = calculatedRevenue - upiAmount;

    const distSql = `INSERT INTO ticket_distributions (distribution_date, settlement_date, staff_id, rate_id, tickets_sold, calculated_revenue, upi_amount, cash_amount, status, settled_by_user_id, distributed_start_number, distributed_end_number, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Settled', ?, 0, 0, ?)`;
    const { lastID: distributionId } = await run(distSql, [settlement_date, settlement_date, 1, rate_id, ticketsSold, calculatedRevenue, upiAmount, cashAmount, req.session.user.id, activeSessionId]);

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
      SELECT td.*, tr.name as ride_name, tr.rate
      FROM ticket_distributions td
      JOIN ticket_rates tr ON td.rate_id = tr.id
      WHERE td.id = ? AND td.stock_id IS NULL
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

    // Find or create the ticket_rate (ride)
    let rateRecord = await get('SELECT id, rate FROM ticket_rates WHERE name = ? AND rate = ?', [ride_name, parseFloat(rate)]);
    if (!rateRecord) {
      const result = await run('INSERT INTO ticket_rates (name, rate) VALUES (?, ?)', [ride_name, parseFloat(rate)]);
      rateRecord = { id: result.lastID, rate: parseFloat(rate) };
    }

    const ticketsSold = parseInt(tickets_sold);
    const calculatedRevenue = ticketsSold * rateRecord.rate;
    const upiAmount = parseFloat(upi_amount) || 0;
    const cashAmount = calculatedRevenue - upiAmount;

    const updateDistSql = `UPDATE ticket_distributions SET settlement_date = ?, rate_id = ?, tickets_sold = ?, calculated_revenue = ?, upi_amount = ?, cash_amount = ? WHERE id = ? AND stock_id IS NULL`;
    await run(updateDistSql, [settlement_date, rateRecord.id, ticketsSold, calculatedRevenue, upiAmount, cashAmount, distributionId]);

    const updateAccSql = `UPDATE accounting_transactions SET amount = ?, transaction_date = ? WHERE description = ?`;
    // Use the correct description format
    await run(updateAccSql, [calculatedRevenue, settlement_date, `Settlement for distribution #${distributionId}`]);

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
    await run('DELETE FROM ticket_distributions WHERE id = ? AND stock_id IS NULL', [distributionId]);

    await run('COMMIT');
    req.session.flash = { type: 'success', message: 'Imported sale deleted successfully.' };
  } catch (err) {
    await run('ROLLBACK');
    console.error('Error deleting imported sale:', err);
    req.session.flash = { type: 'danger', message: 'Failed to delete imported sale.' };
  }
  res.redirect('/ticketing');
});

module.exports = router;