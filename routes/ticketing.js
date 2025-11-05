const express = require('express');
const router = express.Router();
const { Parser } = require('json2csv');
const { all, get, run, logAction } = require('../db-helpers');

// GET /ticketing - Ticketing Dashboard
router.get('/', async (req, res) => {
    try {
        const viewingSessionId = res.locals.viewingSession.id;

        const [summary, stockStatus, topRides, topStaff] = await Promise.all([
            get(`
                SELECT
                    SUM(tickets_sold) as total_tickets_sold,
                    SUM(calculated_revenue) as total_revenue
                FROM ticket_distributions
                WHERE status = 'Settled' AND event_session_id = ?
            `, [viewingSessionId]),
            all(`
                SELECT status, COUNT(id) as count
                FROM ticket_stock
                WHERE event_session_id = ?
                GROUP BY status
            `, [viewingSessionId]),
            all(`
                SELECT r.name as ride_name, SUM(td.tickets_sold) as total_tickets_sold, SUM(td.calculated_revenue) as total_revenue
                FROM ticket_distributions td
                JOIN rides r ON td.rate_id = r.id
                WHERE td.status = 'Settled' AND td.event_session_id = ?
                GROUP BY r.id, r.name ORDER BY total_revenue DESC LIMIT 5
            `, [viewingSessionId]),
            all(`
                SELECT bs.name as staff_name, SUM(td.tickets_sold) as total_tickets_sold, SUM(td.calculated_revenue) as total_revenue
                FROM ticket_distributions td
                JOIN booking_staff bs ON td.staff_id = bs.id
                WHERE td.status = 'Settled' AND td.event_session_id = ?
                GROUP BY bs.id, bs.name ORDER BY total_revenue DESC LIMIT 5
            `, [viewingSessionId])
        ]);

        const stockCounts = (stockStatus || []).reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, { Available: 0, Distributed: 0, Settled: 0 });

        res.render('ticketing', {
            title: 'Ticketing Dashboard',
            summary: summary || { total_tickets_sold: 0, total_revenue: 0 },
            stockCounts,
            topRides,
            topStaff
        });
    } catch (err) {
        console.error("Error loading ticketing dashboard:", err);
        res.status(500).send('Error loading dashboard.');
    }
});

// GET /ticketing/rides - Manage Rides
router.get('/rides', async (req, res) => {
    try {
        const rides = await all('SELECT * FROM rides ORDER BY name');
        res.render('ticketingRides', {
            title: 'Manage Rides',
            rides: rides || []
        });
    } catch (err) {
        console.error("Error fetching rides:", err);
        res.status(500).send('Error loading page.');
    }
});

// POST /ticketing/rides/add - Add a new ride
router.post('/rides/add', async (req, res) => {
    const { name, rate } = req.body;
    if (!name || !rate) {
        req.session.flash = { type: 'danger', message: 'Ride name and rate are required.' };
        return res.redirect('/ticketing/rides');
    }

    try {
        await run('INSERT INTO rides (name, rate) VALUES (?, ?)', [name, parseFloat(rate)]);
        await logAction(req.session.user.id, req.session.user.username, 'create_ride', `Created ride: ${name}`, res.locals.activeSession.id);
        req.session.flash = { type: 'success', message: `Ride "${name}" added successfully.` };
    } catch (err) {
        console.error("Error adding ride:", err);
        req.session.flash = { type: 'danger', message: 'Failed to add ride. It may already exist.' };
    }
    res.redirect('/ticketing/rides');
});

// POST /ticketing/rides/update/:id - Update a ride
router.post('/rides/update/:id', async (req, res) => {
    const { id } = req.params;
    const { name, rate, is_active } = req.body;
    const isActive = is_active ? 1 : 0;

    try {
        await run('UPDATE rides SET name = ?, rate = ?, is_active = ? WHERE id = ?', [name, parseFloat(rate), isActive, id]);
        await logAction(req.session.user.id, req.session.user.username, 'update_ride', `Updated ride #${id}: ${name}`, res.locals.activeSession.id);
        req.session.flash = { type: 'success', message: 'Ride updated successfully.' };
    } catch (err) {
        console.error("Error updating ride:", err);
        req.session.flash = { type: 'danger', message: 'Failed to update ride.' };
    }
    res.redirect('/ticketing/rides');
});

// POST /ticketing/rides/delete/:id - Delete a ride
router.post('/rides/delete/:id', async (req, res) => {
    // Note: Add checks here to prevent deleting rides that are in use.
    await run('DELETE FROM rides WHERE id = ?', [req.params.id]);
    req.session.flash = { type: 'success', message: 'Ride deleted.' };
    res.redirect('/ticketing/rides');
});

// GET /ticketing/stock - Manage Ticket Stock
router.get('/stock', async (req, res) => {
    try {
        const { category, status, q } = req.query;

        let stockSql = 'SELECT ts.*, tc.name as category_name FROM ticket_stock ts LEFT JOIN ticket_categories tc ON ts.category_id = tc.id WHERE ts.event_session_id = ?';
        const params = [res.locals.viewingSession.id];

        if (category && category !== 'all') {
            stockSql += ' AND ts.category_id = ?';
            params.push(category);
        }
        if (status && status !== 'all') {
            stockSql += ' AND ts.status = ?';
            params.push(status);
        }
        if (q) {
            // Search if the number is within the start/end range
            const searchNum = parseInt(q);
            if (!isNaN(searchNum)) {
                stockSql += ' AND ? BETWEEN ts.start_number AND ts.end_number';
                params.push(searchNum);
            }
        }

        stockSql += ' ORDER BY ts.entry_date DESC, ts.created_at DESC';

        const [stock, categories] = await Promise.all([
            all(stockSql, params),
            all('SELECT * FROM ticket_categories ORDER BY name')
        ]);

        res.render('ticketingStock', {
            title: 'Manage Ticket Stock',
            stock: stock || [],
            categories: categories || [],
            filters: { category: category || 'all', status: status || 'all', q: q || '' }
        });
    } catch (err) {
        console.error("Error fetching ticket stock:", err);
        res.status(500).send('Error loading page.');
    }
});

// POST /ticketing/stock/add - Add new ticket stock
router.post('/stock/add', async (req, res) => {
    const { category_id, rate, color, start_number, end_number, entry_date } = req.body;
    const event_session_id = res.locals.activeSession.id;

    // Basic validation
    if (!category_id || !rate || !start_number || !end_number || !entry_date) {
        req.session.flash = { type: 'danger', message: 'All fields are required.' };
        return res.redirect('/ticketing/stock');
    }

    const startNum = parseInt(start_number, 10);
    const endNum = parseInt(end_number, 10);

    if (isNaN(startNum) || isNaN(endNum) || startNum >= endNum) {
        req.session.flash = { type: 'danger', message: 'End Number must be greater than Start Number.' };
        return res.redirect('/ticketing/stock');
    }

    try {
        let currentStart = startNum;
        let bundlesCreated = 0;

        while (currentStart <= endNum) {
            // Calculate the end of the current bundle
            // It's either the next thousand-boundary, or the final end number if it's smaller.
            let currentEnd;
            if (currentStart % 1000 === 1) {
                currentEnd = currentStart + 999;
            } else {
                currentEnd = Math.ceil(currentStart / 1000) * 1000;
            }

            if (currentEnd >= endNum) {
                currentEnd = endNum;
            }

            await run(
                'INSERT INTO ticket_stock (category_id, rate, color, start_number, end_number, entry_date, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [parseInt(category_id), parseFloat(rate), color, currentStart, currentEnd, entry_date, event_session_id]
            );
            bundlesCreated++;
            currentStart = currentEnd + 1;
        }

        await logAction(req.session.user.id, req.session.user.username, 'create_ticket_stock', `Added stock range ${startNum}-${endNum} as ${bundlesCreated} bundle(s) @ ₹${rate}`, event_session_id);
        req.session.flash = { type: 'success', message: `Successfully added ${bundlesCreated} ticket bundle(s).` };
    } catch (err) {
        console.error("Error adding ticket stock:", err);
        req.session.flash = { type: 'danger', message: 'Failed to add ticket stock.' };
    }
    res.redirect('/ticketing/stock');
});

// POST /ticketing/categories/add - Add a new ticket category
router.post('/categories/add', async (req, res) => {
    const { name } = req.body;
    if (!name) {
        req.session.flash = { type: 'danger', message: 'Category name is required.' };
        return res.redirect('/ticketing/stock');
    }
    try {
        await run('INSERT INTO ticket_categories (name) VALUES (?)', [name]);
        req.session.flash = { type: 'success', message: `Category "${name}" added.` };
    } catch (err) {
        req.session.flash = { type: 'danger', message: 'Failed to add category. It may already exist.' };
    }
    res.redirect('/ticketing/stock');
});

module.exports = router;

// GET /ticketing/stock/edit/:id - Show form to edit a stock item
router.get('/stock/edit/:id', async (req, res) => {
    try {
        const [stockItem, categories] = await Promise.all([
            get('SELECT * FROM ticket_stock WHERE id = ?', [req.params.id]),
            all('SELECT * FROM ticket_categories ORDER BY name')
        ]);

        if (!stockItem) {
            req.session.flash = { type: 'danger', message: 'Stock item not found.' };
            return res.redirect('/ticketing/stock');
        }

        res.render('editTicketingStock', {
            title: 'Edit Ticket Stock',
            item: stockItem,
            categories
        });
    } catch (err) {
        console.error("Error loading stock item for edit:", err);
        res.status(500).send('Error loading page.');
    }
});

// POST /ticketing/stock/edit/:id - Update a stock item
router.post('/stock/edit/:id', async (req, res) => {
    const { id } = req.params;
    const { category_id, rate, color, start_number, end_number, entry_date } = req.body;

    try {
        await run(
            'UPDATE ticket_stock SET category_id = ?, rate = ?, color = ?, start_number = ?, end_number = ?, entry_date = ? WHERE id = ?',
            [parseInt(category_id), parseFloat(rate), color, parseInt(start_number), parseInt(end_number), entry_date, id]
        );
        req.session.flash = { type: 'success', message: 'Stock item updated successfully.' };
    } catch (err) {
        console.error("Error updating stock item:", err);
        req.session.flash = { type: 'danger', message: 'Failed to update stock item.' };
    }
    res.redirect('/ticketing/stock');
});

// POST /ticketing/stock/delete/:id - Delete a stock item
router.post('/stock/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Add check here to prevent deleting stock that has been distributed
        await run('DELETE FROM ticket_stock WHERE id = ?', [id]);
        req.session.flash = { type: 'success', message: 'Stock item deleted.' };
    } catch (err) {
        console.error("Error deleting stock item:", err);
        req.session.flash = { type: 'danger', message: 'Failed to delete stock item. It may be in use.' };
    }
    res.redirect('/ticketing/stock');
});

// GET /ticketing/distribute - Show ticket distribution page
router.get('/distribute', async (req, res) => {
    try {
        const { staff_id, ride_id, start_date, end_date } = req.query;
        const viewingSessionId = res.locals.viewingSession.id;

        let distributionsSql = `
            SELECT 
                td.id,
                td.distribution_date,
                bs.name as staff_name,
                r.name as ride_name,
                ts.rate, 
                td.distributed_start_number,
                td.distributed_end_number,
                td.status,
                td.settlement_date,
                td.tickets_sold,
                td.calculated_revenue
            FROM ticket_distributions td
            JOIN booking_staff bs ON td.staff_id = bs.id
            LEFT JOIN rides r ON td.rate_id = r.id
            LEFT JOIN ticket_stock ts ON td.stock_id = ts.id
        `;
        const whereClauses = ['td.event_session_id = ?'];
        const params = [viewingSessionId];

        if (staff_id) { whereClauses.push('td.staff_id = ?'); params.push(staff_id); }
        if (ride_id) { whereClauses.push('td.rate_id = ?'); params.push(ride_id); }
        if (start_date) { whereClauses.push('td.distribution_date >= ?'); params.push(start_date); }
        if (end_date) { whereClauses.push('td.distribution_date <= ?'); params.push(end_date); }

        distributionsSql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY td.status, td.distribution_date DESC`;

        const [staff, availableStock, rides, distributions] = await Promise.all([
            all('SELECT id, name FROM booking_staff ORDER BY name'),
            all("SELECT * FROM ticket_stock WHERE status = 'Available' AND event_session_id = ?", [viewingSessionId]),
            all("SELECT * FROM rides WHERE is_active = 1 ORDER BY name"),
            all(distributionsSql, params)
        ]);

        res.render('ticketingDistribute', {
            title: 'Distribute Tickets',
            staff: staff || [],
            stock: availableStock || [],
            rides: rides || [],
            distributions: distributions || [],
            filters: { staff_id, ride_id, start_date, end_date }
        });
    } catch (err) {
        console.error("Error loading ticket distribution page:", err);
        res.status(500).send('Error loading page.');
    }
});

// POST /ticketing/distribute - Distribute a ticket book
router.post('/distribute', async (req, res) => {
    const { staff_id, ride_id, stock_id, distribution_date } = req.body;
    const event_session_id = res.locals.activeSession.id;

    if (!staff_id || !ride_id || !stock_id || !distribution_date) {
        req.session.flash = { type: 'danger', message: 'All fields are required.' };
        return res.redirect('/ticketing/distribute');
    }

    try {
        const stockItem = await get('SELECT * FROM ticket_stock WHERE id = ? AND status = ?', [stock_id, 'Available']);
        if (!stockItem) {
            req.session.flash = { type: 'danger', message: 'Selected stock is not available for distribution.' };
            return res.redirect('/ticketing/distribute');
        }

        // Use a transaction to ensure data integrity
        await run('BEGIN TRANSACTION');
        await run('UPDATE ticket_stock SET status = ? WHERE id = ?', ['Distributed', stock_id]);
        await run('INSERT INTO ticket_distributions (distribution_date, staff_id, rate_id, stock_id, distributed_start_number, distributed_end_number, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [distribution_date, staff_id, ride_id, stock_id, stockItem.start_number, stockItem.end_number, event_session_id]
        );
        await run('COMMIT');

        await logAction(req.session.user.id, req.session.user.username, 'distribute_tickets', `Distributed stock #${stock_id} to staff #${staff_id}`, event_session_id);
        req.session.flash = { type: 'success', message: 'Tickets distributed successfully.' };
    } catch (err) {
        await run('ROLLBACK');
        console.error("Error distributing tickets:", err);
        req.session.flash = { type: 'danger', message: 'Failed to distribute tickets.' };
    }
    res.redirect('/ticketing/distribute');
});

// --- TICKETING REPORTS ---

// GET /ticketing/report - Main reports menu for ticketing
router.get('/report', (req, res) => {
    res.render('ticketingReport', { title: 'Ticketing Reports' });
});

// GET /ticketing/report/staff-settlements - Show a report of all staff shortages/excesses
router.get('/report/staff-settlements', async (req, res) => {
    try {
        const viewingSessionId = res.locals.viewingSession.id;
        const { status = 'all', q } = req.query;

        let sql = `
      SELECT 
        ss.id,
        ss.settlement_date,
        ss.expected_amount,
        ss.actual_amount,
        ss.difference,
        ss.notes,
        ss.status,
        bs.name as staff_name
      FROM staff_settlements ss
      JOIN booking_staff bs ON ss.staff_id = bs.id
    `;

        const whereClauses = ['ss.event_session_id = ?'];
        const params = [viewingSessionId];

        if (status && status !== 'all') {
            whereClauses.push('ss.status = ?');
            params.push(status);
        }

        if (q) {
            whereClauses.push('bs.name LIKE ?');
            params.push(`%${q}%`);
        }

        sql += ` WHERE ${whereClauses.join(' AND ')} ORDER BY ss.settlement_date DESC`;

        const settlements = await all(sql, params);

        res.render('reportStaffSettlements', {
            title: 'Staff Settlements Report (Short/Excess)',
            settlements,
            filters: { status, q: q || '' }
        });

    } catch (err) {
        console.error('Error generating staff settlements report:', err);
        res.status(500).send('Error generating report.');
    }
});

// POST /ticketing/report/staff-settlements/clear/:id - Mark a settlement as cleared
router.post('/report/staff-settlements/clear/:id', async (req, res) => {
    const settlementId = req.params.id;
    await run("UPDATE staff_settlements SET status = 'settled', settled_on_date = date('now') WHERE id = ?", [settlementId]);
    req.session.flash = { type: 'success', message: 'Settlement has been marked as cleared.' };
    res.redirect('/ticketing/report/staff-settlements');
});

// GET /ticketing/report/daily-sales - Show a report of daily ticket sales
router.get('/report/daily-sales', async (req, res) => {
    try {
        const viewingSessionId = res.locals.viewingSession.id;
        const { start_date, end_date } = req.query;

        let sql = `
      SELECT
        settlement_date,
        SUM(tickets_sold) as total_tickets_sold,
        SUM(calculated_revenue) as total_revenue,
        SUM(cash_amount) as total_cash,
        SUM(upi_amount) as total_upi
      FROM ticket_distributions
    `;

        const whereClauses = ["status = 'Settled'", "event_session_id = ?"];
        const params = [viewingSessionId];

        if (start_date) {
            whereClauses.push('settlement_date >= ?');
            params.push(start_date);
        }
        if (end_date) {
            whereClauses.push('settlement_date <= ?');
            params.push(end_date);
        }

        sql += ` WHERE ${whereClauses.join(' AND ')} GROUP BY settlement_date ORDER BY settlement_date DESC`;

        const dailySales = await all(sql, params);

        res.render('reportDailyTicketSales', {
            title: 'Daily Ticket Sales Report',
            dailySales,
            filters: { start_date: start_date || '', end_date: end_date || '' }
        });

    } catch (err) {
        console.error('Error generating daily ticket sales report:', err);
        res.status(500).send('Error generating report.');
    }
});

// GET /ticketing/report/daily-sales/csv - Download daily sales as CSV
router.get('/report/daily-sales/csv', async (req, res) => {
    try {
        const viewingSessionId = res.locals.viewingSession.id;
        const sql = `
      SELECT
        settlement_date,
        SUM(tickets_sold) as total_tickets_sold,
        SUM(calculated_revenue) as total_revenue,
        SUM(cash_amount) as total_cash,
        SUM(upi_amount) as total_upi
      FROM ticket_distributions
      WHERE status = 'Settled' AND event_session_id = ?
      GROUP BY settlement_date ORDER BY settlement_date DESC
    `;
        const dailySales = await all(sql, [viewingSessionId]);

        const json2csvParser = new Parser();
        const csv = json2csvParser.parse(dailySales);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="daily-ticket-sales-report.csv"');
        res.status(200).send(csv);
    } catch (err) {
        console.error('Error generating daily ticket sales CSV:', err);
        res.status(500).send('Error generating CSV.');
    }
});
// GET /ticketing/settle/:id - Show settlement page for a distribution
router.get('/settle/:id', async (req, res) => {
    try {
        const distributionId = req.params.id;
        const distribution = await get(`
            SELECT 
                td.*,
                bs.name as staff_name,
                r.name as ride_name,
                ts.rate as ticket_rate
            FROM ticket_distributions td
            JOIN booking_staff bs ON td.staff_id = bs.id
            JOIN rides r ON td.rate_id = r.id
            JOIN ticket_stock ts ON td.stock_id = ts.id
            WHERE td.id = ? AND td.status = 'Distributed'
        `, [distributionId]);

        if (!distribution) {
            req.session.flash = { type: 'warning', message: 'This distribution was not found or has already been settled.' };
            return res.redirect('/ticketing/distribute');
        }

        res.render('ticketingSettle', {
            title: 'Settle Ticket Sales',
            dist: distribution
        });
    } catch (err) {
        console.error("Error loading settlement page:", err);
        res.status(500).send('Error loading page.');
    }
});

// POST /ticketing/settle/:id - Process the settlement
router.post('/settle/:id', async (req, res) => {
    const { id } = req.params;
    const { returned_start_number, settlement_date, upi_amount, cash_amount, notes } = req.body;
    const settled_by_user_id = req.session.user.id;

    if (!returned_start_number || !settlement_date) {
        req.session.flash = { type: 'danger', message: 'Returned start number and settlement date are required.' };
        return res.redirect(`/ticketing/settle/${id}`);
    }

    try {
        const dist = await get('SELECT * FROM ticket_distributions WHERE id = ?', [id]);
        const stock = await get('SELECT * FROM ticket_stock WHERE id = ?', [dist.stock_id]);

        const returnedStart = parseInt(returned_start_number, 10);
        const upiAmount = parseFloat(upi_amount) || 0;
        const cashAmount = parseFloat(cash_amount) || 0;
        const totalCollected = upiAmount + cashAmount;

        if (returnedStart < dist.distributed_start_number || returnedStart > dist.distributed_end_number + 1) {
            req.session.flash = { type: 'danger', message: 'Invalid returned start number. It must be within the distributed range.' };
            return res.redirect(`/ticketing/settle/${id}`);
        }

        const tickets_sold = returnedStart - dist.distributed_start_number;
        const calculated_revenue = tickets_sold * stock.rate;
        const difference = totalCollected - calculated_revenue;

        // Use a transaction for data integrity
        await run('BEGIN TRANSACTION');

        // Update the distribution record
        await run(
            `UPDATE ticket_distributions 
             SET status = 'Settled', returned_start_number = ?, settlement_date = ?, tickets_sold = ?, 
                 calculated_revenue = ?, upi_amount = ?, cash_amount = ?, settled_by_user_id = ?
             WHERE id = ?`,
            [returnedStart, settlement_date, tickets_sold, calculated_revenue, upiAmount, cashAmount, settled_by_user_id, id]
        );

        // If there are remaining tickets in the bundle, create a new 'Available' stock item for them.
        if (returnedStart <= stock.end_number) {
            // Update the original stock item to reflect only the settled portion
            const settledEndNumber = returnedStart - 1;
            await run(
                `UPDATE ticket_stock SET end_number = ?, status = 'Settled' WHERE id = ?`,
                [settledEndNumber, dist.stock_id]
            );

            // Create a new stock item for the remaining tickets
            await run(
                `INSERT INTO ticket_stock (category_id, rate, color, start_number, end_number, entry_date, event_session_id, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'Available')`,
                [stock.category_id, stock.rate, stock.color, returnedStart, stock.end_number, stock.entry_date, dist.event_session_id]
            );
            await logAction(req.session.user.id, req.session.user.username, 'split_ticket_stock', `Created new available stock bundle ${returnedStart}-${stock.end_number} from settlement.`, dist.event_session_id);
        } else {
            // If the whole bundle was sold, just update the status
            await run(`UPDATE ticket_stock SET status = 'Settled' WHERE id = ?`, [dist.stock_id]);
        }

        // If there is a shortage or excess, record it
        if (difference !== 0) {
            await run(
                `INSERT INTO staff_settlements (staff_id, event_session_id, settlement_date, expected_amount, actual_amount, difference, notes, settled_by_user_id, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [dist.staff_id, dist.event_session_id, settlement_date, calculated_revenue, totalCollected, difference, notes, settled_by_user_id, 'unsettled']
            );
        }

        // Add income to accounting ledger
        if (calculated_revenue > 0) {
            const description = `Ticket sales settlement for staff #${dist.staff_id}, stock #${dist.stock_id}`;
            await run(
                `INSERT INTO accounting_transactions (transaction_type, category, description, amount, transaction_date, user_id, event_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['income', 'Ticket Sales', description, calculated_revenue, settlement_date, settled_by_user_id, dist.event_session_id]
            );
        }

        await run('COMMIT');

        await logAction(req.session.user.id, req.session.user.username, 'settle_tickets', `Settled distribution #${id}. Revenue: ${calculated_revenue}`, dist.event_session_id);
        req.session.flash = { type: 'success', message: 'Sales settled successfully.' };
        res.redirect('/ticketing/distribute');
    } catch (err) {
        await run('ROLLBACK');
        console.error("Error settling sales:", err);
        req.session.flash = { type: 'danger', message: 'Failed to settle sales due to a server error.' };
        res.redirect(`/ticketing/settle/${id}`);
    }
});

// POST /ticketing/distribute/cancel/:id - Cancel a distribution
router.post('/distribute/cancel/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const dist = await get("SELECT * FROM ticket_distributions WHERE id = ? AND status = 'Distributed'", [id]);
        if (!dist) {
            req.session.flash = { type: 'warning', message: 'Distribution not found or already settled.' };
            return res.redirect('/ticketing/distribute');
        }

        await run('BEGIN TRANSACTION');
        // Set the stock back to 'Available'
        await run("UPDATE ticket_stock SET status = 'Available' WHERE id = ?", [dist.stock_id]);
        // Delete the distribution record
        await run("DELETE FROM ticket_distributions WHERE id = ?", [id]);
        await run('COMMIT');

        await logAction(req.session.user.id, req.session.user.username, 'cancel_ticket_distribution', `Cancelled distribution #${id}`, dist.event_session_id);
        req.session.flash = { type: 'success', message: 'Distribution has been cancelled and stock is available again.' };
    } catch (err) {
        await run('ROLLBACK');
        console.error("Error cancelling distribution:", err);
        req.session.flash = { type: 'danger', message: 'Failed to cancel distribution.' };
    }
    res.redirect('/ticketing/distribute');
});

// POST /ticketing/settle/revert/:id - Revert a settlement
router.post('/settle/revert/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const dist = await get("SELECT * FROM ticket_distributions WHERE id = ? AND status = 'Settled'", [id]);
        if (!dist) {
            req.session.flash = { type: 'warning', message: 'Settlement not found or already reverted.' };
            return res.redirect('/ticketing/distribute');
        }

        await run('BEGIN TRANSACTION');

        // 1. Delete the accounting transaction
        const description = `Ticket sales settlement for staff #${dist.staff_id}, stock #${dist.stock_id}`;
        await run("DELETE FROM accounting_transactions WHERE category = 'Ticket Sales' AND description = ? AND transaction_date = ?", [description, dist.settlement_date]);

        // 2. Delete the staff settlement record (short/excess)
        await run("DELETE FROM staff_settlements WHERE staff_id = ? AND settlement_date = ? AND expected_amount = ?", [dist.staff_id, dist.settlement_date, dist.calculated_revenue]);

        // 3. Delete the leftover stock bundle that was created during settlement
        if (dist.returned_start_number) {
            await run("DELETE FROM ticket_stock WHERE start_number = ? AND event_session_id = ?", [dist.returned_start_number, dist.event_session_id]);
        }

        // 4. Revert the original ticket_stock status to 'Distributed'
        await run("UPDATE ticket_stock SET status = 'Distributed' WHERE id = ?", [dist.stock_id]);

        // 5. Revert the ticket_distributions record to 'Distributed' and clear settlement data
        await run(`UPDATE ticket_distributions SET status = 'Distributed', returned_start_number = NULL, settlement_date = NULL, tickets_sold = NULL, calculated_revenue = NULL, upi_amount = NULL, cash_amount = NULL, settled_by_user_id = NULL WHERE id = ?`, [id]);

        await run('COMMIT');

        await logAction(req.session.user.id, req.session.user.username, 'revert_ticket_settlement', `Reverted settlement for distribution #${id}`, dist.event_session_id);
        req.session.flash = { type: 'success', message: 'Settlement has been reverted. The ticket book is now marked as Distributed.' };
    } catch (err) {
        await run('ROLLBACK');
        console.error("Error reverting settlement:", err);
        req.session.flash = { type: 'danger', message: 'Failed to revert settlement.' };
    }
    res.redirect('/ticketing/distribute');
});