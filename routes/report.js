//report.js - Routes for generating various reports in the exhibition space management system


const express = require('express');
const router = express.Router();
const { all, db } = require('../db-helpers');
const XLSX = require('xlsx');

// GET /report - Show the main report menu
router.get('/', (req, res) => {
  res.render('reportIndex', { title: 'Reports', report_url: '/report' });
});

// Middleware to ensure the user is an admin for specific reports
const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).send('Access Denied: This report is for admins only.');
};

// GET /report/audit-log - Show the audit log of user management actions
router.get('/audit-log', isAdmin, async (req, res) => {
  try {
    const logs = await all('SELECT * FROM logs ORDER BY timestamp DESC');
    res.render('reportAuditLog', { title: 'Audit Log Report', logs: logs || [], report_url: '/report/audit-log' });
  } catch (err) {
    console.error('Error fetching audit log:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/dues - Show a list of all dues (previously the main report page)
router.get('/dues', async (req, res) => {
  const category = req.query.category || 'rent'; // Default to 'rent'
  let sql;
  let title = 'Due List Report';

  try {
    switch (category) {
      case 'electric':
        title = 'Electric Dues Report';
        sql = `
          SELECT
            b.exhibitor_name, b.facia_name, s.name as space_name,
            COALESCE((SELECT SUM(total_amount) FROM electric_bills WHERE booking_id = b.id), 0) as total_amount,
            COALESCE((SELECT SUM(electric_paid) FROM payments WHERE booking_id = b.id), 0) as amount_paid
          FROM bookings b
          JOIN spaces s ON b.space_id = s.id
          ORDER BY b.exhibitor_name;
        `;
        break;
      case 'material':
        title = 'Material Dues Report';
        sql = `
          SELECT
            b.exhibitor_name, b.facia_name, s.name as space_name,
            (SELECT SUM(mi.total_payable) 
             FROM material_issues mi 
             JOIN clients c ON mi.client_id = c.id 
             WHERE c.id = b.client_id) as total_amount,
            COALESCE((SELECT SUM(material_paid) FROM payments WHERE booking_id = b.id), 0) as amount_paid
          FROM bookings b
          JOIN spaces s ON b.space_id = s.id
          ORDER BY b.exhibitor_name;
        `;
        break;
      case 'shed':
        title = 'Shed Dues Report';
        sql = `
          SELECT
            b.exhibitor_name, b.facia_name, s.name as space_name,
            (COALESCE((SELECT SUM(sh.rent) FROM shed_allocations sa JOIN sheds sh ON sa.shed_id = sh.id WHERE sa.booking_id = b.id), 0) + COALESCE((SELECT SUM(amount) FROM shed_bills WHERE booking_id = b.id), 0)) as total_amount,
            COALESCE((SELECT SUM(shed_paid) FROM payments WHERE booking_id = b.id), 0) as amount_paid
          FROM bookings b
          JOIN spaces s ON b.space_id = s.id
          ORDER BY b.exhibitor_name;
        `;
        break;
      case 'rent':
      default:
        title = 'Rent Dues Report';
        sql = `
          SELECT
            b.exhibitor_name, b.facia_name, s.name as space_name,            
            (b.rent_amount - COALESCE(b.discount, 0)) as total_amount,
            (b.advance_amount + COALESCE((SELECT SUM(rent_paid) FROM payments WHERE booking_id = b.id), 0)) as amount_paid
          FROM bookings b
          JOIN spaces s ON b.space_id = s.id
          ORDER BY b.exhibitor_name;
        `;
        break;
    }

    const dues = await all(sql);
    dues.forEach(d => {
      d.balance_amount = d.total_amount - d.amount_paid;
    });

    res.render('reportDueList', {
      title,
      dues,
      currentCategory: category,
      report_url: '/report/dues'
    });
  } catch (err) {
    console.error('Error fetching due list report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/rent - Show a list of rent details for all bookings
router.get('/rent', async (req, res) => {
  try {
    const sql = `
      SELECT 
        b.exhibitor_name,
        b.facia_name,
        s.name as space_name,
        b.rent_amount,
        b.discount,
        (b.advance_amount + COALESCE((SELECT SUM(rent_paid) FROM payments WHERE booking_id = b.id), 0)) as rent_received
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY b.exhibitor_name;
    `;
    const bookings = await all(sql);
    bookings.forEach(b => {
      b.rent_balance = (b.rent_amount - (b.discount || 0)) - b.rent_received;
    });
    res.render('reportRentList', { title: 'Rent Report', bookings, report_url: '/report/rent' });
  } catch (err) {
    console.error('Error fetching rent report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/spaces - Show a list of all spaces
router.get('/spaces', async (req, res) => {
  try {
    const spaces = await all('SELECT * FROM spaces ORDER BY type, name');
    res.render('reportSpaceList', { title: 'Space List Report', spaces, report_url: '/report/spaces' });
  } catch (err) {
    console.error('Error fetching space list report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/exhibitors - Show a list of all exhibitors
router.get('/exhibitors', async (req, res) => {
  try {
    const sql = `
      SELECT 
        b.exhibitor_name, 
        b.facia_name, 
        b.contact_person, 
        b.contact_number, 
        b.secondary_number,
        b.full_address,
        s.name as space_name
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY b.exhibitor_name;
    `;
    const exhibitors = await all(sql);
    res.render('reportExhibitorList', { title: 'Exhibitor List Report', exhibitors, report_url: '/report/exhibitors' });
  } catch (err) {
    console.error('Error fetching exhibitor list report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/electric - Show a list of all electric bills
router.get('/electric', async (req, res) => {
  try {
    const sql = `
      SELECT eb.id, b.exhibitor_name, b.facia_name, s.name as space_name, eb.bill_date, eb.total_amount, eb.items_json
      FROM electric_bills eb
      JOIN bookings b ON eb.booking_id = b.id
      JOIN spaces s ON b.space_id = s.id
      ORDER BY eb.bill_date DESC;
    `;
    const [bills, electricItems] = await Promise.all([
      all(sql),
      all('SELECT * FROM electric_items')
    ]);

    // Create a lookup map for electric items for efficient access
    const itemMap = electricItems.reduce((map, item) => {
      map[item.id] = item;
      return map;
    }, {});

    // Parse the items_json for each bill so the view can use it
    bills.forEach(bill => {
      try {
        let items = JSON.parse(bill.items_json || '[]');
        if (typeof items === 'string') items = JSON.parse(items);
        bill.items = Array.isArray(items) ? items.map(item => {
            const masterItem = itemMap[item.id] || { service_charge: 0, fitting_charge: 0 };
            const total = (masterItem.service_charge + masterItem.fitting_charge) * (item.quantity || 1);
            return { ...item, total };
          }) : [];
      } catch (e) {
        bill.items = [];
      }
    });

    res.render('reportElectricList', { title: 'Electrical Bills Report', bills, report_url: '/report/electric' });
  } catch (err) {
    console.error('Error fetching electric bills report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/materials - Show a list of all material issues
router.get('/materials', async (req, res) => {
  try {
    const sql = `
      SELECT mi.*, c.name as client_name, b.facia_name, s.name as space_name
      FROM material_issues mi
      LEFT JOIN clients c ON mi.client_id = c.id
      LEFT JOIN bookings b ON c.id = b.client_id
      LEFT JOIN spaces s ON b.space_id = s.id
      ORDER BY mi.issue_date DESC;
    `;
    const issues = await all(sql);
    res.render('reportMaterialList', { title: 'Material Issues Report', issues, report_url: '/report/materials' });
  } catch (err) {
    console.error('Error fetching material issues report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/sheds - Show a list of allocated sheds
router.get('/sheds', async (req, res) => {
  try {
    const sql = `
      SELECT s.name as shed_name, s.size, s.rent, b.exhibitor_name, b.facia_name, sp.name as space_name
      FROM shed_allocations sa
      JOIN sheds s ON sa.shed_id = s.id
      JOIN bookings b ON sa.booking_id = b.id
      JOIN spaces sp ON b.space_id = sp.id
      ORDER BY s.name;
    `;
    const allocations = await all(sql);
    res.render('reportShedList', { title: 'Shed Allocation Report', allocations, report_url: '/report/sheds' });
  } catch (err) {
    console.error('Error fetching shed allocation report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/payments - Show a list of all payments
router.get('/payments', async (req, res) => {
  try {
    const { category = 'all', startDate, endDate } = req.query;

    let sql = `
      SELECT p.*, b.exhibitor_name, b.facia_name, s.name as space_name
      FROM payments p
      LEFT JOIN bookings b ON p.booking_id = b.id
      LEFT JOIN spaces s ON b.space_id = s.id
    `;

    const whereClauses = [];
    const params = [];

    if (category !== 'all') {
      whereClauses.push(`${category}_paid > 0`);
    }
    if (startDate) {
      whereClauses.push(`p.payment_date >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      whereClauses.push(`p.payment_date <= ?`);
      params.push(endDate);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    sql += ' ORDER BY p.payment_date DESC;';

    const payments = await all(sql, params);
    res.render('reportPaymentList', { title: 'Payment Collection Report', payments, currentCategory: category, startDate, endDate, report_url: '/report/payments' });
  } catch (err) {
    console.error('Error fetching payment report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// GET /report/payment-summary - Show a summary of all payments by booking
router.get('/payment-summary', async (req, res) => {
  try {
    const sql = `
      SELECT
        b.id as booking_id,
        b.exhibitor_name,
        b.facia_name,
        s.name as space_name,
        SUM(p.rent_paid) as total_rent_paid,
        SUM(p.electric_paid) as total_electric_paid,
        SUM(p.material_paid) as total_material_paid,
        SUM(p.shed_paid) as total_shed_paid,
        SUM(p.rent_paid + p.electric_paid + p.material_paid + p.shed_paid) as grand_total_paid
      FROM bookings b
      LEFT JOIN payments p ON p.booking_id = b.id
      JOIN spaces s ON b.space_id = s.id
      GROUP BY b.id, b.exhibitor_name, s.name
      ORDER BY s.name;
    `;
    const summary = await all(sql);

    // If 'xlsx' format is requested, generate and send an Excel file
    if (req.query.format === 'xlsx') {
      const workbook = new excel.Workbook();
      const worksheet = workbook.addWorksheet('Payment Summary');

      worksheet.columns = [
        { header: 'Exhibitor Name', key: 'exhibitor_name', width: 30 },
        { header: 'Space', key: 'space_name', width: 15 },
        { header: 'Total Rent Paid', key: 'total_rent_paid', width: 20, style: { numFmt: '"₹"#,##0.00' } },
        { header: 'Total Electric Paid', key: 'total_electric_paid', width: 20, style: { numFmt: '"₹"#,##0.00' } },
        { header: 'Total Material Paid', key: 'total_material_paid', width: 20, style: { numFmt: '"₹"#,##0.00' } },
        { header: 'Total Shed Paid', key: 'total_shed_paid', width: 20, style: { numFmt: '"₹"#,##0.00' } },
        { header: 'Grand Total Paid', key: 'grand_total_paid', width: 20, style: { numFmt: '"₹"#,##0.00' } },
      ];

      // Add data rows
      summary.forEach(item => {
        worksheet.addRow(item);
      });

      // Set response headers for file download
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="payment_summary.xlsx"'
      );

      await workbook.xlsx.write(res);
      return res.end();
    }

    // Otherwise, render the HTML report
    res.render('reportPaymentSummary', { title: 'Payment Summary Report', summary, report_url: '/report/payment-summary' });
  } catch (err) {
    console.error('Error fetching payment summary report:', err.message);
    res.status(500).send('Error generating report.');
  }
});

// --- Excel Download Generation ---
// Generic function to fetch data and convert to Excel
async function generateExcelReport(sql, filename, res) {
    try {
        const data = await all(sql);

        if (data.length === 0) {
            // It's better to send a message than a 404 if the report is just empty.
            return res.status(200).send('<script>alert("No data available to generate the report."); window.history.back();</script>');
        }

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');

        // Write the workbook to a buffer
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}.xlsx"`
        );
        res.send(buffer);

    } catch (err) {
        console.error(`Error generating ${filename} report:`, err.message);
        res.status(500).send('Error generating Excel report.');
    }
}

// Helper function to create a flattened structure for bills with multiple items
function flattenBillItems(bills, itemMap = {}) {
    const flattened = [];
    bills.forEach(bill => {
        let items = [];
        try {
            const parsed = JSON.parse(bill.items_json || '[]');
            items = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
            if (!Array.isArray(items)) items = [];
        } catch {
            items = [];
        }

        if (items.length > 0) {
            items.forEach(item => {
                const masterItem = itemMap[item.id] || { service_charge: 0, fitting_charge: 0 };
                const itemTotal = (masterItem.service_charge + masterItem.fitting_charge) * (item.quantity || 1);
                flattened.push({
                    'Date': new Date(bill.bill_date).toLocaleDateString(),
                    'Exhibitor': bill.exhibitor_name,
                    'Facia Name': bill.facia_name,
                    'Space': bill.space_name,
                    'Item Name': item.name,
                    'Quantity': item.quantity,
                    'Item Amount': itemTotal,
                    'Bill Total': bill.total_amount
                });
            });
        } else {
            // Add a row for bills with no items
            flattened.push({
                'Date': new Date(bill.bill_date).toLocaleDateString(),
                'Exhibitor': bill.exhibitor_name,
                'Facia Name': bill.facia_name,
                'Space': bill.space_name,
                'Item Name': 'N/A',
                'Quantity': 0,
                'Item Amount': 0,
                'Bill Total': bill.total_amount
            });
        }
    });
    return flattened;
}

// Helper to send the final Excel file response
function sendExcelResponse(worksheet, filename, res) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(buffer);
}

// Route for downloading the material list report as Excel
router.get('/downloadExcelMaterialList', async (req, res) => {
    const sql = `
        SELECT 
            mi.issue_date,
            c.name AS client_name,
            mi.plywood_free,
            mi.plywood_paid,
            mi.table_free,
            mi.table_paid,
            mi.chair_free,
            mi.chair_paid,
            mi.table_numbers,
            mi.chair_numbers,
            mi.total_payable
        FROM material_issues mi
        JOIN clients c ON mi.client_id = c.id
    `;

    await generateExcelReport(sql, 'material_list_report', res);
});

router.get('/downloadExcelDues', (req, res) => {
    const category = req.query.category || 'rent';
    let sql;
    let filename = 'due_list_report';

    switch (category) {
        case 'electric':
            filename = 'electric_dues_report';
            sql = `
              SELECT
                b.exhibitor_name as "Exhibitor Name", b.facia_name as "Facia Name", s.name as "Space",
                COALESCE((SELECT SUM(total_amount) FROM electric_bills WHERE booking_id = b.id), 0) as "Total Amount",
                COALESCE((SELECT SUM(electric_paid) FROM payments WHERE booking_id = b.id), 0) as "Amount Paid"
              FROM bookings b JOIN spaces s ON b.space_id = s.id ORDER BY b.exhibitor_name;
            `;
            break;
        case 'material':
            filename = 'material_dues_report';
            sql = `
              SELECT
                b.exhibitor_name as "Exhibitor Name", b.facia_name as "Facia Name", s.name as "Space",
                COALESCE((SELECT SUM(mi.total_payable) FROM material_issues mi WHERE mi.client_id = b.client_id), 0) as "Total Amount",
                COALESCE((SELECT SUM(material_paid) FROM payments WHERE booking_id = b.id), 0) as "Amount Paid"
              FROM bookings b JOIN spaces s ON b.space_id = s.id ORDER BY b.exhibitor_name;
            `;
            break;
        case 'shed':
            filename = 'shed_dues_report';
            sql = `
              SELECT
                b.exhibitor_name as "Exhibitor Name", b.facia_name as "Facia Name", s.name as "Space",
                (COALESCE((SELECT SUM(sh.rent) FROM shed_allocations sa JOIN sheds sh ON sa.shed_id = sh.id WHERE sa.booking_id = b.id), 0)) as "Total Amount",
                COALESCE((SELECT SUM(shed_paid) FROM payments WHERE booking_id = b.id), 0) as "Amount Paid"
              FROM bookings b JOIN spaces s ON b.space_id = s.id ORDER BY b.exhibitor_name;
            `;
            break;
        case 'rent':
        default:
            filename = 'rent_dues_report';
            sql = `
              SELECT
                b.exhibitor_name as "Exhibitor Name", b.facia_name as "Facia Name", s.name as "Space",
                (b.rent_amount - COALESCE(b.discount, 0)) as "Total Amount",
                (b.advance_amount + COALESCE((SELECT SUM(rent_paid) FROM payments WHERE booking_id = b.id), 0)) as "Amount Paid"
              FROM bookings b JOIN spaces s ON b.space_id = s.id ORDER BY b.exhibitor_name;
            `;
            break;
    }

    // We use a custom handler here to add the 'Balance Amount' column
    db.all(sql, [], (err, data) => {
        if (err) {
            console.error(`Error generating ${filename} report:`, err.message);
            return res.status(500).send('Error generating Excel report.');
        }

        // Calculate balance amount for each row
        const processedData = data.map(row => ({
            ...row,
            'Balance Amount': row['Total Amount'] - row['Amount Paid']
        }));

        const worksheet = XLSX.utils.json_to_sheet(processedData);
        sendExcelResponse(worksheet, filename, res);
    });
});

router.get('/downloadExcelSpaces', (req, res) => {
    const sql = `SELECT type, name, size, rent_amount, status FROM spaces ORDER BY type, name`;
    generateExcelReport(sql, 'space_list_report', res);
});

router.get('/downloadExcelExhibitors', (req, res) => {
    const sql = `
      SELECT 
        b.exhibitor_name as "Exhibitor Name", 
        b.facia_name as "Facia Name", 
        b.contact_person as "Contact Person", 
        b.contact_number as "Contact Number", 
        b.secondary_number as "Secondary Number",
        b.full_address as "Address",
        s.name as "Space"
      FROM bookings b JOIN spaces s ON b.space_id = s.id ORDER BY b.exhibitor_name;`;
    generateExcelReport(sql, 'exhibitor_list_report', res);
});

router.get('/downloadExcelElectric', (req, res) => {
    // We need to fetch the raw data and process it to include item details,
    // similar to the on-screen report.
    const sql = `
        SELECT 
            eb.bill_date, 
            b.exhibitor_name, 
            b.facia_name, 
            s.name as space_name, 
            eb.total_amount,
            eb.items_json
        FROM electric_bills eb 
        JOIN bookings b ON eb.booking_id = b.id 
        JOIN spaces s ON b.space_id = s.id 
        ORDER BY eb.bill_date DESC;
    `;
    
    db.all(sql, [], (err, bills) => {
        if (err) {
            return res.status(500).send('Error generating report.');
        }
        const flattenedData = flattenBillItems(bills);
        const worksheet = XLSX.utils.json_to_sheet(flattenedData);
        sendExcelResponse(worksheet, 'electric_bills_report', res);
    });
});

router.get('/downloadExcelSheds', (req, res) => {
    const sql = `SELECT s.name as shed_name, s.size, s.rent, b.exhibitor_name, b.facia_name, sp.name as space_name FROM shed_allocations sa JOIN sheds s ON sa.shed_id = s.id JOIN bookings b ON sa.booking_id = b.id JOIN spaces sp ON b.space_id = sp.id ORDER BY s.name;`;
    generateExcelReport(sql, 'shed_allocation_report', res);
});

router.get('/downloadExcelPayments', (req, res) => {
    const sql = `SELECT p.payment_date, p.receipt_number, b.exhibitor_name, b.facia_name, s.name as space_name, p.rent_paid, p.electric_paid, p.material_paid, p.shed_paid, (p.rent_paid + p.electric_paid + p.material_paid + p.shed_paid) as total_paid FROM payments p JOIN bookings b ON p.booking_id = b.id JOIN spaces s ON b.space_id = s.id ORDER BY p.payment_date DESC;`;
    generateExcelReport(sql, 'payment_collection_report', res);
});

router.get('/downloadExcelPaymentSummary', (req, res) => {
    const sql = `SELECT b.exhibitor_name, b.facia_name, s.name as space_name, SUM(p.rent_paid) as total_rent_paid, SUM(p.electric_paid) as total_electric_paid, SUM(p.material_paid) as total_material_paid, SUM(p.shed_paid) as total_shed_paid, SUM(p.rent_paid + p.electric_paid + p.material_paid + p.shed_paid) as grand_total_paid FROM bookings b LEFT JOIN payments p ON p.booking_id = b.id JOIN spaces s ON b.space_id = s.id GROUP BY b.id, b.exhibitor_name, s.name ORDER BY s.name;`;
    generateExcelReport(sql, 'payment_summary_report', res);
});

router.get('/downloadExcelRent', (req, res) => {
    const sql = `
      SELECT 
        b.exhibitor_name as "Exhibitor Name",
        b.facia_name as "Facia Name",
        s.name as "Space",
        b.rent_amount as "Rent Amount",
        b.discount as "Discount",
        (b.advance_amount + COALESCE((SELECT SUM(rent_paid) FROM payments WHERE booking_id = b.id), 0)) as "Rent Received",
        (b.rent_amount - COALESCE(b.discount, 0)) - (b.advance_amount + COALESCE((SELECT SUM(rent_paid) FROM payments WHERE booking_id = b.id), 0)) as "Rent Balance"
      FROM bookings b
      JOIN spaces s ON b.space_id = s.id
      ORDER BY b.exhibitor_name;
    `;
    generateExcelReport(sql, 'rent_report', res);
});

router.get('/downloadExcelAuditLog', (req, res) => {
    const sql = `SELECT timestamp, username, action, details FROM logs ORDER BY timestamp DESC`;
    generateExcelReport(sql, 'audit_log_report', res);
});

module.exports = router;