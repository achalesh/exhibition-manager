const express = require('express');
const router = express.Router();
const { Parser } = require('json2csv');
const { all, get } = require('../db-helpers');
const { isAdmin } = require('./auth');

// Use the isAdmin middleware for all report routes
router.use(isAdmin);

// GET /report - Main reports menu
router.get('/', (req, res) => {
  res.render('report', { title: 'Reports' });
});

// GET /report/write-offs - Show all write-offs
router.get('/write-offs', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { start_date, end_date } = req.query;

    let sql = `
      SELECT
        wo.write_off_date,
        wo.amount,
        wo.reason,
        b.exhibitor_name,
        u.username as user_name
      FROM write_offs wo
      JOIN bookings b ON wo.booking_id = b.id AND b.event_session_id = wo.event_session_id
      LEFT JOIN users u ON wo.user_id = u.id
    `;

    const whereClauses = ['wo.event_session_id = ?'];
    const params = [viewingSessionId];

    if (start_date) {
      whereClauses.push('wo.write_off_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('wo.write_off_date <= ?');
      params.push(end_date);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY wo.write_off_date DESC`;

    const writeOffs = await all(sql, params);

    res.render('reportWriteOffs', {
      title: 'Write-Offs Report',
      writeOffs: writeOffs || [],
      filters: { start_date: start_date || '', end_date: end_date || '' }
    });
  } catch (err) {
    console.error('Error generating write-offs report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/payment-received - Show all payments received
router.get('/payment-received', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { start_date, end_date, q, category = 'all', page = 1 } = req.query;
    const limit = 25; // Number of items per page

    let sql = `
      SELECT
        p.id,
        p.payment_date,
        p.receipt_number,
        p.payment_mode,
        p.cash_paid,
        p.upi_paid,
        (p.cash_paid + p.upi_paid) as total_paid,
        b.exhibitor_name,
        s.name as space_name,
        CASE
          WHEN p.rent_paid > 0 THEN 'Rent'
          WHEN p.electric_paid > 0 THEN 'Electric'
          WHEN p.material_paid > 0 THEN 'Material'
          WHEN p.shed_paid > 0 THEN 'Shed'
          ELSE 'Unknown'
        END as payment_category
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id AND b.event_session_id = p.event_session_id
      LEFT JOIN (
        SELECT bs.booking_id, GROUP_CONCAT(s.name, ', ') as space_name 
        FROM booking_spaces bs 
        JOIN spaces s ON bs.space_id = s.id 
        GROUP BY bs.booking_id
      ) s ON b.id = s.booking_id
    `;

    const whereClauses = ['p.event_session_id = ?'];
    const params = [viewingSessionId];

    if (start_date) {
      whereClauses.push('p.payment_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('p.payment_date <= ?');
      params.push(end_date);
    }
    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.space_name LIKE ? OR p.receipt_number LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (category && category !== 'all') {
      const categoryMap = {
        'Rent': 'p.rent_paid > 0',
        'Electric': 'p.electric_paid > 0',
        'Material': 'p.material_paid > 0',
        'Shed': 'p.shed_paid > 0'
      };
      if (categoryMap[category]) {
        whereClauses.push(categoryMap[category]);
      }
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    // Get total count and summary for the filtered data
    const summarySql = `
      SELECT COUNT(*) as count, SUM(p.cash_paid) as total_cash, SUM(p.upi_paid) as total_upi, SUM(p.cash_paid + p.upi_paid) as total_paid 
      FROM payments p 
      JOIN bookings b ON p.booking_id = b.id 
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id 
      ${whereSql}
    `;
    const summaryResult = await get(summarySql, params);

    const totalItems = summaryResult.count || 0;
    const totalPages = Math.ceil(totalItems / limit);
    const currentPage = parseInt(page);
    const offset = (currentPage - 1) * limit;

    const fullSql = `${sql} ${whereSql} ORDER BY p.payment_date DESC, p.id DESC LIMIT ? OFFSET ?`;
    const payments = await all(fullSql, [...params, limit, offset]);

    const pagination = {
      currentPage,
      totalPages,
      hasPrevPage: currentPage > 1,
      hasNextPage: currentPage < totalPages,
      totalItems
    };

    res.render('paymentReceivedReport', {
      title: 'Payment Received Report',
      payments,
      pagination,
      summary: {
        total_cash: summaryResult.total_cash || 0,
        total_upi: summaryResult.total_upi || 0,
        total_paid: summaryResult.total_paid || 0,
      },
      filters: { start_date: start_date || '', end_date: end_date || '', q: q || '', category }
    });

  } catch (err) {
    console.error('Error generating payment received report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/payment-received/csv - Download payments as CSV
router.get('/payment-received/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { start_date, end_date, q, category } = req.query;

    // This query is identical to the one in the main report route
    const sql = `SELECT p.payment_date, p.receipt_number, b.exhibitor_name, s.space_name, CASE WHEN p.rent_paid > 0 THEN 'Rent' WHEN p.electric_paid > 0 THEN 'Electric' WHEN p.material_paid > 0 THEN 'Material' WHEN p.shed_paid > 0 THEN 'Shed' ELSE 'Unknown' END as payment_category, p.payment_mode, p.cash_paid, p.upi_paid, (p.cash_paid + p.upi_paid) as total_paid 
                 FROM payments p 
                 JOIN bookings b ON p.booking_id = b.id AND b.event_session_id = p.event_session_id 
                 LEFT JOIN (SELECT bs.booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY bs.booking_id) s 
                 ON b.id = s.booking_id`;

    const whereClauses = ['p.event_session_id = ?'];
    const params = [viewingSessionId];

    if (start_date) { whereClauses.push('p.payment_date >= ?'); params.push(start_date); }
    if (end_date) { whereClauses.push('p.payment_date <= ?'); params.push(end_date); }
    if (q) { whereClauses.push('(b.exhibitor_name LIKE ? OR s.space_name LIKE ? OR p.receipt_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (category && category !== 'all') {
      const categoryMap = {
        'Rent': 'p.rent_paid > 0',
        'Electric': 'p.electric_paid > 0',
        'Material': 'p.material_paid > 0',
        'Shed': 'p.shed_paid > 0'
      };
      if (categoryMap[category]) {
        whereClauses.push(categoryMap[category]);
      }
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY p.payment_date DESC, p.id DESC`;
    const payments = await all(fullSql, params);

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(payments);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payment-received-report.csv"');
    res.status(200).send(csv);

  } catch (err) {
    console.error('Error generating payment received CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/exhibitors - Show a list of all exhibitors
router.get('/exhibitors', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `
      SELECT
        b.exhibitor_name,
        b.facia_name,
        s.space_name,
        s.space_type,
        b.contact_person,
        b.contact_number,
        b.product_category
      FROM bookings b
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name, GROUP_CONCAT(s.type, ', ') as space_type FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
    `;

    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR b.facia_name LIKE ? OR s.space_name LIKE ? OR b.product_category LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.exhibitor_name`;
    const exhibitors = await all(fullSql, params);

    res.render('exhibitorsReport', {
      title: 'Exhibitors List Report',
      exhibitors,
      filters: { q: q || '' }
    });

  } catch (err) {
    console.error('Error generating exhibitors report:', err);
    res.status(500).send('Error generating report.');
  }
});

// Helper function to get exhibitor financial data, avoiding code duplication
async function getExhibitorFinancialData(viewingSessionId, q) {
  const sql = `
      SELECT
        b.id as booking_id,
        b.exhibitor_name,
        b.facia_name,
        s.space_name,
        (b.rent_amount - COALESCE(b.discount, 0)) as total_rent,
        (COALESCE(p.total_paid, 0) + COALESCE(b.advance_amount, 0)) as total_paid,
        ((b.rent_amount - COALESCE(b.discount, 0)) + COALESCE(eb.total_electric_charge, 0) + COALESCE(mi.total_material_charge, 0) + COALESCE(sh.total_shed_charge, 0)) as total_charged
      FROM bookings b
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
      -- Aggregate Payments for the current session
      LEFT JOIN (
        SELECT booking_id, SUM(rent_paid + electric_paid + material_paid + shed_paid) as total_paid
        FROM payments 
        WHERE event_session_id = ?
        GROUP BY booking_id
      ) p ON b.id = p.booking_id
      -- Aggregate Electric Bills
      LEFT JOIN (SELECT booking_id, SUM(total_amount) as total_electric_charge FROM electric_bills WHERE event_session_id = ? GROUP BY booking_id) eb ON b.id = eb.booking_id
      -- Aggregate Material Issues
      LEFT JOIN (SELECT client_id, SUM(total_payable) as total_material_charge FROM material_issues WHERE event_session_id = ? GROUP BY client_id) mi ON b.client_id = mi.client_id
      -- Aggregate Shed Charges
      LEFT JOIN (SELECT booking_id, SUM(rent) as total_shed_charge FROM (SELECT sa.booking_id, s.rent FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.event_session_id = ? UNION ALL SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb WHERE sb.event_session_id = ?) GROUP BY booking_id) sh ON b.id = sh.booking_id
    `;
  const whereClauses = ['b.event_session_id = ?'];
  const params = [viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId];

  if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.space_name LIKE ? OR b.facia_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.id DESC`;
  return await all(fullSql, params);
}

// GET /report/exhibitor-dues - Show a summary of dues for all exhibitors
router.get('/exhibitor-dues', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    const exhibitors = await getExhibitorFinancialData(viewingSessionId, q);

    let subtotal = { total_rent: 0, total_paid: 0, balance_due: 0 };
    const reportData = exhibitors.map(e => {
      const balance_due = e.total_charged - e.total_paid;
      subtotal.total_rent += e.total_rent || 0;
      subtotal.total_paid += e.total_paid || 0;
      subtotal.balance_due += balance_due || 0;
      return { ...e, balance_due };
    });

    res.render('reportExhibitorDues', { title: 'Exhibitor Dues Report', exhibitors: reportData, subtotal, filters: { q: q || '' } });
  } catch (err) {
    console.error('Error generating exhibitor dues report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/exhibitor-dues/csv - Download exhibitor dues as CSV
router.get('/exhibitor-dues/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    const exhibitors = await getExhibitorFinancialData(viewingSessionId, q);

    const reportData = exhibitors.map(e => ({
      'Exhibitor Name': e.exhibitor_name,
      'Facia Name': e.facia_name,
      'Space': e.space_name,
      'Total Rent': e.total_rent,
      'Total Paid': e.total_paid,
      'Balance Due': e.total_charged - e.total_paid
    }));

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(reportData);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="exhibitor-dues-report.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error('Error generating exhibitor dues CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/exhibitor-charges - Show a summary of all charges for all exhibitors
router.get('/exhibitor-charges', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    const exhibitors = await getExhibitorFinancialData(viewingSessionId, q);

    let subtotal = { rent_charged: 0, electric_charged: 0, material_charged: 0, shed_charged: 0, total_charged: 0, total_paid: 0, balance_due: 0 };
    const reportData = exhibitors.map(e => {
      const balance_due = e.total_charged - e.total_paid;
      subtotal.rent_charged += e.rent_charged || 0;
      subtotal.electric_charged += e.electric_charged || 0;
      subtotal.material_charged += e.material_charged || 0;
      subtotal.shed_charged += e.shed_charged || 0;
      subtotal.total_charged += e.total_charged || 0;
      subtotal.total_paid += e.total_paid || 0;
      subtotal.balance_due += balance_due || 0;
      return { ...e, balance_due };
    });

    res.render('reportExhibitorCharges', { title: 'Exhibitor Charges Report', exhibitors: reportData, subtotal, filters: { q: q || '' } });
  } catch (err) {
    console.error('Error generating exhibitor charges report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/exhibitor-charges/csv - Download exhibitor charges as CSV
router.get('/exhibitor-charges/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    const exhibitors = await getExhibitorFinancialData(viewingSessionId, q);

    const reportData = exhibitors.map(e => ({
      'Exhibitor Name': e.exhibitor_name,
      'Facia Name': e.facia_name,
      'Space': e.space_name,
      'Rent': e.rent_charged,
      'Electric': e.electric_charged,
      'Material': e.material_charged,
      'Shed': e.shed_charged,
      'Total Charged': e.total_charged,
      'Total Paid': e.total_paid,
      'Balance Due': e.total_charged - e.total_paid
    }));

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(reportData);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="exhibitor-charges-report.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error('Error generating exhibitor charges CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/exhibitors/csv - Download exhibitors list as CSV
router.get('/exhibitors/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `SELECT b.exhibitor_name, b.facia_name, s.space_name, s.space_type, b.contact_person, b.contact_number, b.product_category 
                 FROM bookings b 
                 LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name, GROUP_CONCAT(s.type, ', ') as space_type FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
                 ON b.id = s.booking_id`;
    const whereClauses = ['b.event_session_id = ?', "b.booking_status = 'active'"];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR b.facia_name LIKE ? OR s.space_name LIKE ? OR b.product_category LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.id DESC`;
    const exhibitors = await all(fullSql, params);

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(exhibitors);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="exhibitors-report.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error('Error generating exhibitors CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/due-list - Show a list of all outstanding dues
router.get('/due-list', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;
    // This refactored query uses JOINs and GROUP BY for better performance
    const sql = `
      SELECT
        b.id as booking_id,
        b.exhibitor_name,
        b.facia_name,
        s.space_name,
        b.contact_number,
        -- Rent
        (b.rent_amount - COALESCE(b.discount, 0)) as total_rent_charge,
        COALESCE(p.total_rent_paid, 0) + COALESCE(b.advance_amount, 0) as total_rent_paid,
        -- Electric
        COALESCE(eb.total_electric_charge, 0) as total_electric_charge,
        COALESCE(p.total_electric_paid, 0) as total_electric_paid,
        -- Material
        COALESCE(mi.total_material_charge, 0) as total_material_charge,
        COALESCE(p.total_material_paid, 0) as total_material_paid,
        -- Shed
        COALESCE(sh.total_shed_charge, 0) as total_shed_charge,
        COALESCE(p.total_shed_paid, 0) as total_shed_paid
      FROM bookings b
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
      -- Aggregate Payments for the current session
      LEFT JOIN (
        SELECT booking_id, 
               SUM(rent_paid) as total_rent_paid, 
               SUM(electric_paid) as total_electric_paid, 
               SUM(material_paid) as total_material_paid, 
               SUM(shed_paid) as total_shed_paid
        FROM payments 
        WHERE event_session_id = ? GROUP BY booking_id
      ) p ON b.id = p.booking_id
      -- Aggregate Electric Bills
      LEFT JOIN (SELECT booking_id, SUM(total_amount) as total_electric_charge FROM electric_bills WHERE event_session_id = ? GROUP BY booking_id) eb ON b.id = eb.booking_id
      -- Aggregate Material Issues
      LEFT JOIN (SELECT client_id, SUM(total_payable) as total_material_charge FROM material_issues WHERE event_session_id = ? GROUP BY client_id) mi ON b.client_id = mi.client_id
      -- Aggregate Shed Charges (Allocations + Bills)
      LEFT JOIN (
        SELECT 
          booking_id, 
          SUM(rent) as total_shed_charge 
        FROM (
          SELECT sa.booking_id, s.rent FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.event_session_id = ?
          UNION ALL
          SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb WHERE sb.event_session_id = ?
        ) GROUP BY booking_id
      ) sh ON b.id = sh.booking_id
    `;

    let whereClauses = ['b.event_session_id = ?'];
    let params = [viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.space_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.id DESC`;

    const bookings = await all(fullSql, params);
    
    const dueList = bookings.map(b => {
      const rent_due = (b.total_rent_charge || 0) - (b.total_rent_paid || 0);
      const electric_due = (b.total_electric_charge || 0) - (b.total_electric_paid || 0);
      const material_due = (b.total_material_charge || 0) - (b.total_material_paid || 0);
      const shed_due = (b.total_shed_charge || 0) - (b.total_shed_paid || 0);

      const total_charged = (b.total_rent_charge || 0) + (b.total_electric_charge || 0) + (b.total_material_charge || 0) + (b.total_shed_charge || 0);
      const total_paid = (b.total_rent_paid || 0) + (b.total_electric_paid || 0) + (b.total_material_paid || 0) + (b.total_shed_paid || 0);
      const total_due = total_charged - total_paid;

      return {
        ...b,
        rent_due,
        electric_due,
        material_due,
        shed_due,
        total_due,
        total_charged,
        total_paid
      };
    });

    const allDues = dueList.filter(b => b.total_due > 0.01);
    const rentDues = dueList.filter(b => b.rent_due > 0.01);
    const electricDues = dueList.filter(b => b.electric_due > 0.01);
    const materialDues = dueList.filter(b => b.material_due > 0.01);
    const shedDues = dueList.filter(b => b.shed_due > 0.01);

    res.render('dueListReport', {
      title: 'Due List Report',
      dueLists: { all: allDues, rent: rentDues, electric: electricDues, material: materialDues, shed: shedDues },
      filters: { q: q || '' }
    });
  } catch (err) {
    console.error('Error generating due list report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/due-list/csv - Download the due list as a CSV file
router.get('/due-list/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q, category = 'all' } = req.query;
    // Replaced N+1 query with the more efficient JOIN-based query from the main due-list report.
    const sql = `
      SELECT
        b.id as booking_id, b.exhibitor_name, b.facia_name, s.space_name,
        (b.rent_amount - COALESCE(b.discount, 0)) as total_rent_charge,
        COALESCE(p.total_rent_paid, 0) + COALESCE(b.advance_amount, 0) as total_rent_paid,
        COALESCE(eb.total_electric_charge, 0) as total_electric_charge,
        COALESCE(p.total_electric_paid, 0) as total_electric_paid,
        COALESCE(mi.total_material_charge, 0) as total_material_charge,
        COALESCE(p.total_material_paid, 0) as total_material_paid,
        COALESCE(sh.total_shed_charge, 0) as total_shed_charge,
        COALESCE(p.total_shed_paid, 0) as total_shed_paid
      FROM bookings b
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s ON b.id = s.booking_id
      LEFT JOIN (
        SELECT booking_id, SUM(rent_paid) as total_rent_paid, SUM(electric_paid) as total_electric_paid, SUM(material_paid) as total_material_paid, SUM(shed_paid) as total_shed_paid
        FROM payments WHERE event_session_id = ? GROUP BY booking_id
      ) p ON b.id = p.booking_id
      LEFT JOIN (SELECT booking_id, SUM(total_amount) as total_electric_charge FROM electric_bills WHERE event_session_id = ? GROUP BY booking_id) eb ON b.id = eb.booking_id
      LEFT JOIN (SELECT client_id, SUM(total_payable) as total_material_charge FROM material_issues WHERE event_session_id = ? GROUP BY client_id) mi ON b.client_id = mi.client_id
      LEFT JOIN (
        SELECT booking_id, SUM(rent) as total_shed_charge FROM (
          SELECT sa.booking_id, s.rent FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.event_session_id = ?
          UNION ALL
          SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb WHERE sb.event_session_id = ?
        ) GROUP BY booking_id
      ) sh ON b.id = sh.booking_id
    `;

    let whereClauses = ['b.event_session_id = ?'];
    let params = [viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId];
    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.space_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.id DESC`;
    const bookings = await all(fullSql, params);

    const fullDueList = bookings.map(b => {
        const rent_due = (b.total_rent_charge || 0) - (b.total_rent_paid || 0);
        const electric_due = (b.total_electric_charge || 0) - (b.total_electric_paid || 0);
        const material_due = (b.total_material_charge || 0) - (b.total_material_paid || 0);
        const shed_due = (b.total_shed_charge || 0) - (b.total_shed_paid || 0);
        const total_charged = (b.total_rent_charge || 0) + (b.total_electric_charge || 0) + (b.total_material_charge || 0) + (b.total_shed_charge || 0);
        const total_paid = (b.total_rent_paid || 0) + (b.total_electric_paid || 0) + (b.total_material_paid || 0) + (b.total_shed_paid || 0);
        const total_due = total_charged - total_paid;
        return { ...b, rent_due, electric_due, material_due, shed_due, total_due, total_charged, total_paid };
    });

    const categoryMap = {
      all: { data: fullDueList.filter(b => b.total_due > 0.01), fields: ['exhibitor_name', 'facia_name', 'space_name', 'total_charged', 'total_paid', 'total_due'], headers: ['Exhibitor Name', 'Facia Name', 'Space', 'Total Amount', 'Paid Amount', 'Balance Due'] },
      rent: { data: fullDueList.filter(b => b.rent_due > 0.01), fields: ['exhibitor_name', 'facia_name', 'space_name', 'total_rent_charge', 'total_rent_paid', 'rent_due'], headers: ['Exhibitor Name', 'Facia Name', 'Space', 'Total Rent', 'Rent Paid', 'Rent Due'] },
      electric: { data: fullDueList.filter(b => b.electric_due > 0.01), fields: ['exhibitor_name', 'facia_name', 'space_name', 'total_electric_charge', 'total_electric_paid', 'electric_due'], headers: ['Exhibitor Name', 'Facia Name', 'Space', 'Total Electric', 'Electric Paid', 'Electric Due'] },
      material: { data: fullDueList.filter(b => b.material_due > 0.01), fields: ['exhibitor_name', 'facia_name', 'space_name', 'total_material_charge', 'total_material_paid', 'material_due'], headers: ['Exhibitor Name', 'Facia Name', 'Space', 'Total Material', 'Material Paid', 'Material Due'] },
      shed: { data: fullDueList.filter(b => b.shed_due > 0.01), fields: ['exhibitor_name', 'facia_name', 'space_name', 'total_shed_charge', 'total_shed_paid', 'shed_due'], headers: ['Exhibitor Name', 'Facia Name', 'Space', 'Total Shed', 'Shed Paid', 'Shed Due'] },
    };

    const selectedCategory = categoryMap[category] || categoryMap.all;

    const json2csvParser = new Parser({ fields: selectedCategory.fields, header: true, excelStrings: true });
    const csv = json2csvParser.parse(selectedCategory.data);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="due-list-${category}-report.csv"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error('Error generating due list CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/booking-summary - Show a summary of all bookings
router.get('/booking-summary', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;
    const sql = `
      SELECT 
        b.id, 
        b.exhibitor_name, 
        s.space_name, 
        s.space_type, 
        b.rent_amount, 
        b.discount, 
        b.advance_amount, 
        b.form_submitted,
        -- Calculate total charges
        (b.rent_amount - COALESCE(b.discount, 0)) AS total_charged,
        -- Calculate total payments
        (COALESCE(p.total_paid, 0) + COALESCE(b.advance_amount, 0)) AS total_paid,
        -- Other charges
        COALESCE(eb.total_electric_charge, 0) AS electric_charged,
        COALESCE(mi.total_material_charge, 0) AS material_charged,
        COALESCE(sh.total_shed_charge, 0) AS shed_charged
      FROM bookings b
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name, GROUP_CONCAT(s.type, ', ') as space_type FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
      -- Aggregate Payments
      LEFT JOIN (
        SELECT booking_id, SUM(rent_paid + electric_paid + material_paid + shed_paid) as total_paid
        FROM payments 
        WHERE event_session_id = ?
        GROUP BY booking_id
      ) p ON b.id = p.booking_id
      -- Aggregate Electric Bills
      LEFT JOIN (SELECT booking_id, SUM(total_amount) as total_electric_charge FROM electric_bills WHERE event_session_id = ? GROUP BY booking_id) eb ON b.id = eb.booking_id
      -- Aggregate Material Issues
      LEFT JOIN (SELECT client_id, SUM(total_payable) as total_material_charge FROM material_issues WHERE event_session_id = ? GROUP BY client_id) mi ON b.client_id = mi.client_id
      -- Aggregate Shed Charges
      LEFT JOIN (SELECT booking_id, SUM(rent) as total_shed_charge FROM (SELECT sa.booking_id, s.rent FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.event_session_id = ? UNION ALL SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb WHERE sb.event_session_id = ?) GROUP BY booking_id) sh ON b.id = sh.booking_id
    `;

    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ? OR b.facia_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.id DESC`;
    const fullParams = [viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId, ...params];
    const bookingsData = await all(fullSql, fullParams);

    // Process the results to calculate the final due amount for each booking
    const bookings = bookingsData.map(b => {
      const totalCharged = (b.rent_amount || 0) - (b.discount || 0) + (b.electric_charged || 0) + (b.material_charged || 0) + (b.shed_charged || 0);
      const totalPaid = (b.advance_amount || 0) + (b.total_paid || 0);
      b.due_amount = totalCharged - totalPaid;
      return b;
    });

    res.render('bookingSummaryReport', {
      title: 'Booking Summary Report',
      bookings,
      filters: { q: q || '' }
    });
  } catch (err) {
    console.error('Error generating booking summary report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/booking-summary/csv - Download the booking summary as a CSV file
router.get('/booking-summary/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;    
    const sql = `SELECT b.exhibitor_name, b.facia_name, s.space_name, s.space_type, b.rent_amount, b.discount, b.advance_amount, b.due_amount, b.form_submitted FROM bookings b LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name, GROUP_CONCAT(s.type, ', ') as space_type FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s ON b.id = s.booking_id`;

    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.space_name LIKE ? OR b.facia_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.id DESC`;
    const bookings = await all(fullSql, params);

    let csv = 'Exhibitor Name,Facia Name,Space,Type,Rent,Discount,Advance,Due,Form Submitted\n';
    bookings.forEach(b => {
      csv += `"${b.exhibitor_name}","${b.facia_name || ''}","${b.space_name}","${b.space_type}",${b.rent_amount || 0},${b.discount || 0},${b.advance_amount || 0},${b.due_amount || 0},${b.form_submitted ? 'Yes' : 'No'}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="booking-summary-report.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error('Error generating booking summary CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/audit-log - View the audit log of user actions
router.get('/audit-log', async (req, res) => {
  try {
    const { page = 1, q } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    let whereClauses = [];
    let params = [];

    if (q) {
      whereClauses.push('(l.username LIKE ? OR l.action LIKE ? OR l.details LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const logsSql = `SELECT * FROM logs l ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as count FROM logs l ${whereSql}`;

    const [logs, totalResult] = await Promise.all([
      all(logsSql, [...params, limit, offset]),
      get(countSql, params)
    ]);

    const totalItems = totalResult.count;
    const totalPages = Math.ceil(totalItems / limit);

    res.render('auditLog', {
      title: 'Audit Log',
      logs,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
      },
      filters: { q: q || '' }
    });
  } catch (err) {
    console.error('Error loading audit log:', err);
    res.status(500).send('Error loading audit log.');
  }
});

// GET /report/electric-list - Show a list of all electric bills
router.get('/electric-list', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const bills = await all(`
      SELECT eb.*, b.exhibitor_name, b.facia_name, s.space_name
      FROM electric_bills eb
      JOIN bookings b ON eb.booking_id = b.id AND b.event_session_id = eb.event_session_id
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
      WHERE eb.event_session_id = ?
      ORDER BY eb.bill_date DESC, eb.id DESC
    `, [viewingSessionId]);

    bills.forEach(bill => {
      try {
        bill.items = JSON.parse(bill.items_json || '[]');
        // Handle cases where the JSON is double-stringified
        if (typeof bill.items === 'string') {
          bill.items = JSON.parse(bill.items);
        }
      } catch (e) {
        bill.items = [];
      }
    });

    res.render('reportElectricList', {
      title: 'Electric Bills Report',
      bills
    });
  } catch (err) {
    console.error('Error generating electric bills report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/shed-list - Show a list of all shed allocations
router.get('/shed-list', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    // This query now calculates total charges and payments for sheds for each exhibitor with an allocation.
    const allocations = await all(`
      SELECT 
        b.id as booking_id,
        b.exhibitor_name,
        b.facia_name,
        sp.space_name,
        GROUP_CONCAT(s.name, ', ') as shed_names,
        COALESCE(sh.total_shed_charge, 0) as total_charged,
        COALESCE(p.total_shed_paid, 0) as total_paid,
        (COALESCE(sh.total_shed_charge, 0) - COALESCE(p.total_shed_paid, 0)) as balance_due
      FROM bookings b
      -- Ensure we only get bookings that have at least one shed allocation
      JOIN shed_allocations sa ON b.id = sa.booking_id AND sa.event_session_id = b.event_session_id
      JOIN sheds s ON sa.shed_id = s.id
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) sp ON b.id = sp.booking_id AND b.event_session_id = sa.event_session_id
      -- Aggregate all shed charges (from allocations and separate bills)
      LEFT JOIN (
        SELECT 
          booking_id, 
          SUM(rent) as total_shed_charge 
        FROM (
          SELECT sa_inner.booking_id, s_inner.rent FROM shed_allocations sa_inner JOIN sheds s_inner ON sa_inner.shed_id = s_inner.id WHERE sa_inner.event_session_id = ?
          UNION ALL
          SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb WHERE sb.event_session_id = ?
        ) GROUP BY booking_id
      ) sh ON b.id = sh.booking_id
      -- Aggregate all shed payments
      LEFT JOIN (
        SELECT booking_id, SUM(shed_paid) as total_shed_paid
        FROM payments
        WHERE event_session_id = ?
        GROUP BY booking_id
      ) p ON b.id = p.booking_id
      WHERE b.event_session_id = ?
      GROUP BY b.id, b.exhibitor_name, b.facia_name, sp.space_name
      ORDER BY b.exhibitor_name
    `, [viewingSessionId, viewingSessionId, viewingSessionId, viewingSessionId]);

    res.render('reportShedList', { title: 'Shed Allocation Report', allocations });
  } catch (err) {
    console.error('Error generating shed allocation report:', err);
    res.status(500).send('Error generating report.');
  }
});

router.get('/sales-by-staff', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { start_date, end_date } = req.query;

    let sql = `
      SELECT
        s.name as staff_name,
        SUM(td.tickets_sold) as total_tickets_sold,
        SUM(td.calculated_revenue) as total_revenue,
        SUM(td.upi_amount) as total_upi,
        SUM(td.cash_amount) as total_cash
      FROM ticket_distributions td
      JOIN booking_staff s ON td.staff_id = s.id
    `;

    const whereClauses = ["td.status = 'Settled'", 'td.event_session_id = ?'];
    const params = [viewingSessionId];

    if (start_date) {
      whereClauses.push('td.settlement_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('td.settlement_date <= ?');
      params.push(end_date);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} GROUP BY s.id, s.name ORDER BY total_revenue DESC`;

    const salesByStaff = await all(sql, params);

    res.render('salesByStaffReport', {
      title: 'Sales by Staff Report',
      salesByStaff,
      filters: { start_date: start_date || '', end_date: end_date || '' }
    });

  } catch (err) {
    console.error('Error generating sales by staff report:', err);
    res.status(500).send('Error generating report.');
  }
});

router.get('/sales-by-staff/:id', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const staffId = req.params.id;
    const { start_date, end_date } = req.query;

    const staff = await get('SELECT name FROM booking_staff WHERE id = ?', [staffId]);
    if (!staff) {
      req.session.flash = { type: 'danger', message: 'Staff member not found.' };
      return res.redirect('/report/sales-by-staff');
    }

    let sql = `
      SELECT
        r.name as ride_name,
        r.rate,
        SUM(td.tickets_sold) as total_tickets_sold,
        SUM(td.calculated_revenue) as total_revenue
      FROM ticket_distributions td
      JOIN rides r ON td.ride_id = r.id
      WHERE td.staff_id = ? AND td.status = 'Settled' AND td.event_session_id = ?
    `;
    const params = [staffId, viewingSessionId];

    if (start_date) {
      sql += ' AND td.settlement_date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND td.settlement_date <= ?';
      params.push(end_date);
    }

    sql += ' GROUP BY r.id, r.name, r.rate ORDER BY total_revenue DESC';

    const details = await all(sql, params);

    // Prepare data for the pie chart
    const pieChartData = {
      labels: details.map(d => d.ride_name),
      data: details.map(d => d.total_revenue)
    };

    res.render('salesByStaffDetail', {
      title: `Sales Details for ${staff.name}`,
      staff,
      details,
      pieChartData,
      filters: { start_date: start_date || '', end_date: end_date || '' }
    });
  } catch (err) {
    console.error('Error generating detailed sales by staff report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/materials - Show a report of all items in material stock
router.get('/materials', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { status = 'all', q } = req.query;

    let sql = `
      SELECT 
        ms.id,
        ms.name,
        ms.description,
        ms.status,
        ms.unique_id,
        c.name as issued_to_client,
        s.space_name,
        b.contact_number
      FROM material_stock ms
      LEFT JOIN clients c ON ms.issued_to_client_id = c.id
      LEFT JOIN (
        SELECT b.client_id, b.id as booking_id, b.contact_number 
        FROM bookings 
        WHERE event_session_id = ? AND booking_status = 'active'
      ) b ON c.id = b.client_id
      LEFT JOIN booking_spaces bs ON b.id = bs.booking_id
      LEFT JOIN spaces s ON bs.space_id = s.id
    `;

    const whereClauses = [];
    const params = [viewingSessionId];

    if (status && status !== 'all') {
      whereClauses.push('ms.status = ?');
      params.push(status);
    }

    if (q) {
      whereClauses.push('(ms.name LIKE ? OR ms.unique_id LIKE ? OR c.name LIKE ? OR s.name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    sql += ' ORDER BY ms.name, ms.id';

    const materials = await all(sql, params);

    res.render('reportMaterials', {
      title: 'Material Stock Report',
      materials,
      filters: { status, q: q || '' }
    });

  } catch (err) {
    console.error('Error generating material stock report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/materials/csv - Download material stock as CSV
router.get('/materials/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    // This query can be simpler for CSV as it doesn't need filtering from the UI in the same way
    const materials = await all(`
      SELECT 
        ms.name, 
        ms.description, 
        ms.status, 
        ms.unique_id, 
        c.name as issued_to_client,
        s.space_name
      FROM material_stock ms LEFT JOIN clients c ON ms.issued_to_client_id = c.id
      LEFT JOIN (SELECT client_id, id as booking_id FROM bookings WHERE event_session_id = ? AND booking_status = 'active') b ON c.id = b.client_id 
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.booking_id = s.booking_id
      ORDER BY ms.name, ms.id
    `, [viewingSessionId]);

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(materials);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="material-stock-report.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error('Error generating material stock CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/material-issues - Show a report of all material issues (form-based)
router.get('/material-issues', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `
      SELECT 
        mi.id,
        mi.sl_no,
        mi.issue_date,
        c.name as client_name,
        b.facia_name,
        s.space_name,
        mi.total_payable,
        mi.advance_paid,
        mi.balance_due
      FROM material_issues mi
      JOIN clients c ON mi.client_id = c.id
      LEFT JOIN bookings b ON c.id = b.client_id AND b.event_session_id = mi.event_session_id
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
    `;

    const whereClauses = ['mi.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(ms.name LIKE ? OR ms.unique_id LIKE ? OR c.name LIKE ? OR s.space_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY mi.issue_date DESC, mi.id DESC`;

    const issues = await all(sql, params);

    res.render('reportMaterialIssues', {
      title: 'Material Issues Report (Form-based)',
      issues,
      filters: { q: q || '' }
    });

  } catch (err) {
    console.error('Error generating material issues report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/allocated-materials - Show a summary of all materials issued via forms
router.get('/allocated-materials', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `
      SELECT 
        mi.*,
        c.name as client_name,
        b.facia_name,
        b.id as booking_id,
        s.space_name
      FROM material_issues mi
      JOIN clients c ON mi.client_id = c.id
      LEFT JOIN bookings b ON c.id = b.client_id AND b.event_session_id = mi.event_session_id
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
    `;

    const whereClauses = ['mi.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(c.name LIKE ? OR b.facia_name LIKE ? OR s.space_name LIKE ? OR mi.sl_no LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY mi.issue_date DESC, mi.id DESC`;

    const issues = await all(sql, params);

    res.render('reportAllocatedMaterials', {
      title: 'Allocated Materials Report',
      issues,
      filters: { q: q || '' }
    });

  } catch (err) {
    console.error('Error generating allocated materials report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/allocated-materials/csv - Download allocated materials as CSV
router.get('/allocated-materials/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `
      SELECT 
        mi.sl_no as "SL No",
        mi.issue_date as "Date",
        c.name as "Exhibitor",
        b.facia_name as "Facia Name",
        s.space_name as "Space",
        (COALESCE(mi.plywood_free, 0) + COALESCE(mi.plywood_paid, 0)) as "Plywood",
        (COALESCE(mi.table_free, 0) + COALESCE(mi.table_paid, 0)) as "Table",
        (COALESCE(mi.chair_free, 0) + COALESCE(mi.chair_paid, 0)) as "Chair",
        COALESCE(mi.rod_free, 0) as "Rod",
        mi.table_numbers as "Table Numbers",
        mi.chair_numbers as "Chair Numbers",
        mi.notes as "Notes"
      FROM material_issues mi
      JOIN clients c ON mi.client_id = c.id
      LEFT JOIN bookings b ON c.id = b.client_id AND b.event_session_id = mi.event_session_id
      LEFT JOIN (SELECT booking_id, GROUP_CONCAT(s.name, ', ') as space_name FROM booking_spaces bs JOIN spaces s ON bs.space_id = s.id GROUP BY booking_id) s 
      ON b.id = s.booking_id
    `;

    const whereClauses = ['mi.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(c.name LIKE ? OR b.facia_name LIKE ? OR s.space_name LIKE ? OR mi.sl_no LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY mi.issue_date DESC, mi.id DESC`;

    const issues = await all(sql, params);

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(issues);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="allocated-materials-report.csv"');
    res.status(200).send(csv);

  } catch (err) {
    console.error('Error generating allocated materials CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

// GET /report/damaged-materials - Show a list of all materials marked as damaged
router.get('/damaged-materials', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `
      SELECT 
        id,
        name,
        unique_id,
        description,
        created_at
      FROM material_stock
    `;
    const whereClauses = ["status = 'Damaged'", "event_session_id = ?"];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(name LIKE ? OR unique_id LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY name, id`;

    const materials = await all(sql, params);
    res.render('reportDamagedMaterials', { title: 'Damaged Materials Report', materials, filters: { q: q || '' } });
  } catch (err) {
    console.error('Error generating damaged materials report:', err);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/damaged-materials/csv - Download damaged materials as CSV
router.get('/damaged-materials/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `
      SELECT 
        name as "Name",
        unique_id as "Unique ID",
        description as "Description",
        created_at as "Date Added"
      FROM material_stock
    `;
    const whereClauses = ["status = 'Damaged'", "event_session_id = ?"];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(name LIKE ? OR unique_id LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY name, id`;

    const materials = await all(sql, params);

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(materials);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="damaged-materials-report.csv"');
    res.status(200).send(csv);

  } catch (err) {
    console.error('Error generating damaged materials CSV:', err);
    res.status(500).send('Error generating CSV.');
  }
});

module.exports = router;