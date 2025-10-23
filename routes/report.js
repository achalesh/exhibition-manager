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
      JOIN bookings b ON p.booking_id = b.id
      JOIN spaces s ON b.space_id = s.id
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
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ? OR p.receipt_number LIKE ?)');
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
    const summarySql = `SELECT COUNT(*) as count, SUM(p.cash_paid) as total_cash, SUM(p.upi_paid) as total_upi, SUM(p.cash_paid + p.upi_paid) as total_paid FROM payments p JOIN bookings b ON p.booking_id = b.id JOIN spaces s ON b.space_id = s.id ${whereSql}`;
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
    const sql = `SELECT p.payment_date, p.receipt_number, b.exhibitor_name, s.name as space_name, CASE WHEN p.rent_paid > 0 THEN 'Rent' WHEN p.electric_paid > 0 THEN 'Electric' WHEN p.material_paid > 0 THEN 'Material' WHEN p.shed_paid > 0 THEN 'Shed' ELSE 'Unknown' END as payment_category, p.payment_mode, p.cash_paid, p.upi_paid, (p.cash_paid + p.upi_paid) as total_paid FROM payments p JOIN bookings b ON p.booking_id = b.id JOIN spaces s ON b.space_id = s.id`;
    const whereClauses = ['p.event_session_id = ?'];
    const params = [viewingSessionId];

    if (start_date) { whereClauses.push('p.payment_date >= ?'); params.push(start_date); }
    if (end_date) { whereClauses.push('p.payment_date <= ?'); params.push(end_date); }
    if (q) { whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ? OR p.receipt_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
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
        s.name as space_name,
        s.type as space_type,
        b.contact_person,
        b.contact_number,
        b.product_category
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
    `;

    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR b.facia_name LIKE ? OR s.name LIKE ? OR b.product_category LIKE ?)');
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

// GET /report/exhibitors/csv - Download exhibitors list as CSV
router.get('/exhibitors/csv', async (req, res) => {
  try {
    const viewingSessionId = res.locals.viewingSession.id;
    const { q } = req.query;

    let sql = `SELECT b.exhibitor_name, b.facia_name, s.name as space_name, s.type as space_type, b.contact_person, b.contact_number, b.product_category FROM bookings b JOIN spaces s ON b.space_id = s.id`;
    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR b.facia_name LIKE ? OR s.name LIKE ? OR b.product_category LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.exhibitor_name`;
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
        s.name as space_name,
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
      JOIN spaces s ON b.space_id = s.id
      -- Aggregate Payments
      LEFT JOIN (
        SELECT booking_id, 
               SUM(rent_paid) as total_rent_paid, 
               SUM(electric_paid) as total_electric_paid, 
               SUM(material_paid) as total_material_paid, 
               SUM(shed_paid) as total_shed_paid
        FROM payments 
        GROUP BY booking_id
      ) p ON b.id = p.booking_id
      -- Aggregate Electric Bills
      LEFT JOIN (SELECT booking_id, SUM(total_amount) as total_electric_charge FROM electric_bills GROUP BY booking_id) eb ON b.id = eb.booking_id
      -- Aggregate Material Issues
      LEFT JOIN (SELECT client_id, SUM(total_payable) as total_material_charge FROM material_issues GROUP BY client_id) mi ON b.client_id = mi.client_id
      -- Aggregate Shed Charges (Allocations + Bills)
      LEFT JOIN (
        SELECT 
          booking_id, 
          SUM(rent) as total_shed_charge 
        FROM (
          SELECT sa.booking_id, s.rent FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id
          UNION ALL
          SELECT sb.booking_id, sb.amount as rent FROM shed_bills sb
        ) GROUP BY booking_id
      ) sh ON b.id = sh.booking_id
    `;

    let whereClauses = ['b.event_session_id = ?'];
    let params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.exhibitor_name`;

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
    const sql = `
      SELECT
        b.id as booking_id,
        b.exhibitor_name,
        b.facia_name,
        s.name as space_name,
        (b.rent_amount - b.discount) as total_rent_charge,
        (SELECT SUM(p.rent_paid) FROM payments p WHERE p.booking_id = b.id AND p.event_session_id = b.event_session_id) + b.advance_amount as total_rent_paid,
        (SELECT SUM(eb.total_amount) FROM electric_bills eb WHERE eb.booking_id = b.id AND eb.event_session_id = b.event_session_id) as total_electric_charge,
        (SELECT SUM(p.electric_paid) FROM payments p WHERE p.booking_id = b.id AND p.event_session_id = b.event_session_id) as total_electric_paid,
        (SELECT SUM(mi.total_payable) FROM material_issues mi WHERE mi.client_id = b.client_id AND mi.event_session_id = b.event_session_id) as total_material_charge,
        (SELECT SUM(p.material_paid) FROM payments p WHERE p.booking_id = b.id AND p.event_session_id = b.event_session_id) as total_material_paid,
        ((SELECT SUM(s.rent) FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id WHERE sa.booking_id = b.id AND sa.event_session_id = b.event_session_id) + (SELECT SUM(sb.amount) FROM shed_bills sb WHERE sb.booking_id = b.id AND sb.event_session_id = b.event_session_id)) as total_shed_charge,
        (SELECT SUM(p.shed_paid) FROM payments p WHERE p.booking_id = b.id AND p.event_session_id = b.event_session_id) as total_shed_paid
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
    `;

    let whereClauses = ['b.event_session_id = ?'];
    let params = [viewingSessionId];
    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY b.exhibitor_name`;
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
        s.name as space_name,
        s.type as space_type,
        b.rent_amount,
        b.discount,
        b.advance_amount,
        b.due_amount,
        b.form_submitted
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
    `;

    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ? OR b.facia_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY s.type, s.name`;
    const bookings = await all(fullSql, params);

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
    const sql = `
      SELECT b.exhibitor_name, b.facia_name, s.name as space_name, s.type as space_type, b.rent_amount, b.discount, b.advance_amount, b.due_amount, b.form_submitted
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
    `;

    const whereClauses = ['b.event_session_id = ?'];
    const params = [viewingSessionId];

    if (q) {
      whereClauses.push('(b.exhibitor_name LIKE ? OR s.name LIKE ? OR b.facia_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const fullSql = `${sql} WHERE ${whereClauses.join(' AND ')} ORDER BY s.type, s.name`;
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
    const viewingSessionId = res.locals.viewingSession.id;
    const { page = 1, q } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    let whereClauses = ['l.event_session_id = ?'];
    let params = [viewingSessionId];

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
      SELECT eb.*, b.exhibitor_name, b.facia_name, s.name as space_name
      FROM electric_bills eb
      JOIN bookings b ON eb.booking_id = b.id
      JOIN spaces s ON b.space_id = s.id
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
    const allocations = await all(`
      SELECT 
        sa.id, 
        s.name as shed_name, 
        s.rent,
        b.exhibitor_name,
        b.facia_name,
        sp.name as space_name
      FROM shed_allocations sa
      JOIN sheds s ON sa.shed_id = s.id
      JOIN bookings b ON sa.booking_id = b.id
      JOIN spaces sp ON b.space_id = sp.id
      WHERE sa.event_session_id = ?
      ORDER BY s.name
    `, [viewingSessionId]);
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

module.exports = router;