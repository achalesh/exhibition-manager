const express = require('express');
const router = express.Router();
const { all, get, run, db, transaction } = require('../db-helpers');

// GET: Show form to issue materials
router.get('/issue', async (req, res) => {
  const selectedClientId = req.query.client_id || null; // Ensure selectedClientId is always defined
  try {
    const [clients, defaults, suggestions] = await Promise.all([
      all(`
        SELECT c.id as client_id, c.name as client_name, b.facia_name, s.name as space_name
        FROM clients c
        JOIN bookings b ON c.id = b.client_id
        JOIN spaces s ON b.space_id = s.id
        ORDER BY c.name
      `),
      get('SELECT * FROM material_defaults WHERE id = 1'),
      get('SELECT GROUP_CONCAT(DISTINCT camp) as camps FROM material_issues WHERE camp IS NOT NULL')
    ]);

    const campSuggestions = suggestions?.camps ? suggestions.camps.split(',') : [];

    res.render('issueMaterial', {
      title: 'Issue Stall Materials',
      clients: clients || [],
      suggestions: {
        defaults: defaults || { free_tables: 1, free_chairs: 2 },
        camps: campSuggestions
      },
      selectedClientId // Pass it to the view
    });
  } catch (err) {
    console.error('Error loading material issue page:', err.message);
    res.status(500).send('Error loading page.');
  }
});

// POST: Save material issue
router.post('/issue', async (req, res) => {
    const {
        client_id, sl_no, stall_number, camp,
        plywood_free, table_free, chair_free, rod_free,
        plywood_paid, table_paid, chair_paid,
        table_numbers, chair_numbers,
        total_payable, advance_paid, balance_due, notes, issue_date
    } = req.body;

    if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
        req.session.flash = { type: 'warning', message: 'Cannot issue materials in an archived session.' };
        return res.redirect(`/material/issue${client_id ? '?client_id=' + client_id : ''}`);
    }

    db.serialize(async () => {
        try {
            db.run('BEGIN TRANSACTION');
            const sql = `
                INSERT INTO material_issues (
                    client_id, sl_no, stall_number, camp, issue_date,
                    plywood_free, table_free, chair_free, rod_free,
                    plywood_paid, table_paid, chair_paid,
                    table_numbers, chair_numbers,
                    total_payable, advance_paid, balance_due, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const params = [
                client_id, sl_no, stall_number, camp, issue_date,
                plywood_free, table_free, chair_free, rod_free,
                plywood_paid, table_paid, chair_paid,
                table_numbers, chair_numbers,
                total_payable, advance_paid, balance_due, notes
            ];
            await run(sql, params);

            // Update booking due amount if there is a payable amount
            if (parseFloat(total_payable) > 0) {
                const booking = await get('SELECT id FROM bookings WHERE client_id = ?', [client_id]);
                if (booking) {
                    await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [balance_due, booking.id]);
                }
            }

            db.run('COMMIT');
            res.redirect(`/material/issue?client_id=${client_id}`);
        } catch (err) {
            db.run('ROLLBACK');
            console.error('Error saving material issue:', err.message);
            res.status(500).send('Failed to save material issue.');
        }
    });
});

// GET: Show form to edit a material issue
router.get('/edit/:id', async (req, res) => {
    const issueId = req.params.id;
    try {
        const [issue, clients, suggestions] = await Promise.all([
            get('SELECT * FROM material_issues WHERE id = ?', [issueId]),
            all(`
                SELECT c.id as client_id, c.name as client_name, b.facia_name, s.name as space_name
                FROM clients c
                JOIN bookings b ON c.id = b.client_id
                JOIN spaces s ON b.space_id = s.id
                ORDER BY c.name
            `),
            get('SELECT GROUP_CONCAT(DISTINCT camp) as camps FROM material_issues WHERE camp IS NOT NULL')
        ]);

        if (!issue) {
            return res.status(404).send('Material issue record not found.');
        }

        // Find the booking_id for the cancel button link
        const booking = await get('SELECT id FROM bookings WHERE client_id = ? AND event_session_id = ? AND booking_status = "active"', [issue.client_id, res.locals.viewingSession.id]);
        if (booking) {
            issue.booking_id = booking.id;
        }

        const campSuggestions = suggestions?.camps ? suggestions.camps.split(',') : [];

        res.render('editMaterial', {
            title: `Edit Material Issue #${issue.sl_no || issue.id}`,
            issue,
            clients: clients || [],
            suggestions: {
                camps: campSuggestions
            }
        });
    } catch (err) {
        console.error('Error loading material issue for editing:', err.message);
        res.status(500).send('Error loading page.');
    }
});

// POST: Update a material issue
router.post('/edit/:id', async (req, res) => {
    const issueId = req.params.id;
    const {
        client_id, sl_no, stall_number, camp,
        plywood_free, table_free, chair_free, rod_free,
        plywood_paid, table_paid, chair_paid,
        table_numbers, chair_numbers,
        total_payable, advance_paid, balance_due, notes, issue_date
    } = req.body;

    if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
        const booking = await get('SELECT b.id FROM bookings b JOIN clients c ON b.client_id = c.id JOIN material_issues mi ON c.id = mi.client_id WHERE mi.id = ?', [issueId]);
        req.session.flash = { type: 'warning', message: 'Cannot edit data in an archived session.' };
        return res.redirect(`/booking/details-full/${booking.id}`);
    }

    if (req.session.user && req.session.user.role === 'admin') {
        db.serialize(async () => {
            try {
                db.run('BEGIN TRANSACTION');
                const oldIssue = await get('SELECT total_payable, client_id FROM material_issues WHERE id = ?', [issueId]);
                if (!oldIssue) throw new Error('Original material issue not found.');
                const oldPayable = oldIssue.total_payable || 0;
                const newPayable = parseFloat(total_payable) || 0;
                const amountDifference = newPayable - oldPayable;
                const sql = `UPDATE material_issues SET client_id = ?, sl_no = ?, stall_number = ?, camp = ?, issue_date = ?, plywood_free = ?, table_free = ?, chair_free = ?, rod_free = ?, plywood_paid = ?, table_paid = ?, chair_paid = ?, table_numbers = ?, chair_numbers = ?, total_payable = ?, advance_paid = ?, balance_due = ?, notes = ? WHERE id = ?`;
                await run(sql, [client_id, sl_no, stall_number, camp, issue_date, plywood_free, table_free, chair_free, rod_free, plywood_paid, table_paid, chair_paid, table_numbers, chair_numbers, newPayable, advance_paid, balance_due, notes, issueId]);
                const booking = await get('SELECT id FROM bookings WHERE client_id = ?', [client_id]);
                if (booking) { await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, booking.id]); }
                db.run('COMMIT');
                res.redirect(`/booking/details-full/${booking.id}?message=Material issue updated successfully.`);
            } catch (err) {
                db.run('ROLLBACK');
                console.error(`Error updating material issue #${issueId}:`, err.message);
                res.status(500).send('Failed to update material issue.');
            }
        });
    } else {
        const proposed_data = JSON.stringify(req.body);
        const sql = `INSERT INTO material_issue_edits (material_issue_id, user_id, username, proposed_data, request_date) VALUES (?, ?, ?, ?, datetime('now'))`;
        await run(sql, [issueId, req.session.user.id, req.session.user.username, proposed_data]);
        const booking = await get('SELECT b.id FROM bookings b JOIN clients c ON b.client_id = c.id JOIN material_issues mi ON c.id = mi.client_id WHERE mi.id = ?', [issueId]);
        res.redirect(`/booking/details-full/${booking.id}?message=Material issue edit submitted for approval.`);
    }
});

// POST: Delete a material issue
router.post('/delete/:id', async (req, res) => {
    const issueId = req.params.id;

    if (res.locals.viewingSession.id !== res.locals.activeSession.id) {
        req.session.flash = { type: 'warning', message: 'Cannot delete data from an archived session.' };
        // We need to find the booking to redirect back to
        const issue = await get('SELECT client_id FROM material_issues WHERE id = ?', [issueId]);
        if (issue) {
            const booking = await get('SELECT id FROM bookings WHERE client_id = ?', [issue.client_id]);
            if (booking) return res.redirect(`/booking/details-full/${booking.id}`);
        }
        return res.redirect('/booking/list');
    }

    try {
        let bookingIdToRedirect;
        await transaction(async (db) => {
            const issue = await db.get('SELECT client_id, total_payable FROM material_issues WHERE id = ?', [issueId]);
            if (!issue) throw new Error('Material issue not found.');
            
            const booking = await db.get('SELECT id FROM bookings WHERE client_id = ?', [issue.client_id]);
            if (!booking) throw new Error('Associated booking not found.');
            bookingIdToRedirect = booking.id;

            if (issue.total_payable > 0) {
                await db.run('UPDATE bookings SET due_amount = due_amount - ? WHERE id = ?', [issue.total_payable, booking.id]);
            }
            await db.run('DELETE FROM material_issues WHERE id = ?', [issueId]);
        });
        res.redirect(`/booking/details-full/${bookingIdToRedirect}?message=Material issue deleted successfully.`);
    } catch (err) {
        console.error(`Error deleting material issue #${issueId}:`, err.message);
        res.status(500).send('Failed to delete material issue.');
    }
});

const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).send('Access Denied: Admins only.');
};

// GET: Show page to approve a pending material issue edit
router.get('/approve/:edit_id', isAdmin, async (req, res) => {
    const editId = req.params.edit_id;
    try {
        const editRequest = await get("SELECT * FROM material_issue_edits WHERE id = ? AND status = 'pending'", [editId]);
        if (!editRequest) {
            return res.status(404).send('Material issue edit request not found or already processed.');
        }

        const currentIssue = await get('SELECT * FROM material_issues WHERE id = ?', [editRequest.material_issue_id]);
        const proposedData = JSON.parse(editRequest.proposed_data);

        res.render('approveMaterialEdit', {
            title: 'Approve Material Issue Edit',
            editRequest,
            currentIssue,
            proposedData
        });
    } catch (err) {
        console.error('Error loading material issue approval page:', err.message);
        res.status(500).send('Error loading approval page.');
    }
});

// POST: Approve a pending material issue edit
router.post('/approve/:edit_id', isAdmin, async (req, res) => {
    const editId = req.params.edit_id;
    try {
        const editRequest = await get('SELECT * FROM material_issue_edits WHERE id = ?', [editId]);
        const proposedData = JSON.parse(editRequest.proposed_data);
        const { client_id, sl_no, stall_number, camp, issue_date, plywood_free, table_free, chair_free, rod_free, plywood_paid, table_paid, chair_paid, table_numbers, chair_numbers, total_payable, advance_paid, balance_due, notes } = proposedData;

        db.run('BEGIN TRANSACTION');
        const oldIssue = await get('SELECT total_payable, client_id FROM material_issues WHERE id = ?', [editRequest.material_issue_id]);
        const oldPayable = oldIssue.total_payable || 0;
        const newPayable = parseFloat(total_payable) || 0;
        const amountDifference = newPayable - oldPayable;

        const sql = `UPDATE material_issues SET client_id = ?, sl_no = ?, stall_number = ?, camp = ?, issue_date = ?, plywood_free = ?, table_free = ?, chair_free = ?, rod_free = ?, plywood_paid = ?, table_paid = ?, chair_paid = ?, table_numbers = ?, chair_numbers = ?, total_payable = ?, advance_paid = ?, balance_due = ?, notes = ? WHERE id = ?`;
        await run(sql, [client_id, sl_no, stall_number, camp, issue_date, plywood_free, table_free, chair_free, rod_free, plywood_paid, table_paid, chair_paid, table_numbers, chair_numbers, newPayable, advance_paid, balance_due, notes, editRequest.material_issue_id]);
        
        const booking = await get('SELECT id FROM bookings WHERE client_id = ?', [client_id]);
        if (booking) { await run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [amountDifference, booking.id]); }
        
        await run(`UPDATE material_issue_edits SET status = 'approved' WHERE id = ?`, [editId]);
        db.run('COMMIT');

        res.redirect('/dashboard?message=Material issue edit approved and applied.');
    } catch (err) {
        db.run('ROLLBACK');
        console.error('Error approving material issue edit:', err.message);
        res.status(500).send('Failed to approve material issue edit.');
    }
});

// POST: Reject a pending material issue edit
router.post('/reject/:edit_id', isAdmin, async (req, res) => {
    const editId = req.params.edit_id;
    const { rejection_reason } = req.body;
    await run(`UPDATE material_issue_edits SET status = 'rejected', rejection_reason = ? WHERE id = ?`, [rejection_reason, editId]);
    res.redirect('/dashboard?message=Material issue edit has been rejected.');
});

module.exports = router;