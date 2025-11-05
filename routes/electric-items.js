const express = require('express');
const router = express.Router();
const { all, get, run, logAction } = require('../db-helpers');

// GET: List all electric items
router.get('/', async (req, res) => {
    const { q } = req.query;
    try {
        let sql = 'SELECT * FROM electric_items';
        const params = [];

        if (q) {
            sql += ' WHERE name LIKE ?';
            params.push(`%${q}%`);
        }

        sql += ' ORDER BY name';

        const items = await all(sql, params);
        res.render('electricItems', {
            title: 'Manage Electric Items',
            items: items || [],
            message: req.query.message,
            filters: { q: q || '' }
        });
    } catch (err) {
        console.error('Error fetching electric items:', err.message);
        res.status(500).send('Error loading page.');
    }
});

// GET: Show form to add a new electric item
router.get('/add', (req, res) => {
    // Add mode
    res.render('addElectricItem', {
        title: 'Add New Electric Item',
        item: null // No item data for a new entry
    });
});

// GET: Show form to edit an existing one
router.get('/edit/:id', async (req, res) => {
    const { id } = req.params;
    // Edit mode
    try {
        const item = await get('SELECT * FROM electric_items WHERE id = ?', [id]);
        if (!item) {
            return res.status(404).send('Item not found.');
        }
        res.render('addElectricItem', {
            title: 'Edit Electric Item',
            item
        });
    } catch (err) {
        console.error('Error fetching item for edit:', err.message);
        res.status(500).send('Error loading page.');
    }
});

// POST: Add or Update an electric item
router.post('/save', async (req, res) => {
    const { id, name, service_charge, fitting_charge } = req.body;
    const serviceCharge = parseFloat(service_charge) || 0;
    const fittingCharge = parseFloat(fitting_charge) || 0;

    if (!name) {
        return res.status(400).send('Item Name is required.');
    }

    try {
        if (id) {
            // Update existing item
            await run('UPDATE electric_items SET name = ?, service_charge = ?, fitting_charge = ? WHERE id = ?', [name, serviceCharge, fittingCharge, id]);
            await logAction(req.session.user.id, req.session.user.username, 'update_electric_item', `Updated item #${id}: ${name}`, res.locals.activeSession.id);
        } else {
            // Insert new item
            await run('INSERT INTO electric_items (name, service_charge, fitting_charge) VALUES (?, ?, ?)', [name, serviceCharge, fittingCharge]);
            await logAction(req.session.user.id, req.session.user.username, 'create_electric_item', `Created item: ${name}`, res.locals.activeSession.id);
        }
        res.redirect('/electric-items');
    } catch (err) {
        console.error('Error saving electric item:', err.message);
        res.status(500).send('Failed to save item.');
    }
});

// POST: Delete an electric item
router.post('/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await run('DELETE FROM electric_items WHERE id = ?', [id]);
        await logAction(req.session.user.id, req.session.user.username, 'delete_electric_item', `Deleted item #${id}`, res.locals.activeSession.id);
        res.redirect('/electric-items?message=Item deleted successfully.');
    } catch (err) {
        console.error('Error deleting electric item:', err.message);
        res.status(500).send('Failed to delete item. It might be in use.');
    }
});

module.exports = router;