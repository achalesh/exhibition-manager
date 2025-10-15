const express = require('express');
const router = express.Router();
const { all, get, run, logAction } = require('../db-helpers');
const bcrypt = require('bcryptjs');

// Middleware to ensure the user is an admin
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    req.session.flash = { type: 'danger', message: 'Access denied. Admins only.' };
    res.redirect('/dashboard');
};

// All user routes should be admin-only
router.use(isAdmin);

// GET /users - List all users
router.get('/manage', async (req, res) => {
    try {
        const users = await all('SELECT id, username, role FROM users');
        res.render('userList', { 
            title: 'Manage Users', 
            users,
            flash: req.session.flash 
        });
        delete req.session.flash; // Clear flash message after rendering
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading users.');
    }
});

// GET /users/add - Show form to add a new user
router.get('/add', (req, res) => {
    res.render('userForm', { title: 'Add User', user: {}, action: '/users/add' });
});

// POST /users/add - Create a new user
router.post('/add', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, role]);
        
        // Log this action
        await logAction(req.session.user.id, req.session.user.username, 'User Created', `Created new user: ${username} (ID: ${result.lastID})`);

        req.session.flash = { type: 'success', message: 'User created successfully!' };
        res.redirect('/users/manage');
    } catch (err) {
        console.error(err);
        req.session.flash = { type: 'danger', message: 'Error creating user. The username may already exist.' };
        res.redirect('/users/add');
    }
});

// GET /users/edit/:id - Show form to edit a user
router.get('/edit/:id', async (req, res) => {
    try {
        const user = await get('SELECT id, username, role FROM users WHERE id = ?', [req.params.id]);
        if (user) {
            res.render('userForm', { title: 'Edit User', user, action: `/users/edit/${user.id}` });
        } else {
            res.status(404).send('User not found.');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading user data.');
    }
});

// POST /users/edit/:id - Update a user
router.post('/edit/:id', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            await run('UPDATE users SET username = ?, password = ?, role = ? WHERE id = ?', [username, hashedPassword, role, req.params.id]);
        } else {
            await run('UPDATE users SET username = ?, role = ? WHERE id = ?', [username, role, req.params.id]);
        }

        // Log this action
        await logAction(req.session.user.id, req.session.user.username, 'User Updated', `Updated user: ${username} (ID: ${req.params.id})`);

        req.session.flash = { type: 'success', message: 'User updated successfully!' };
        res.redirect('/users/manage');
    } catch (err) {
        console.error(err);
        req.session.flash = { type: 'danger', message: 'Error updating user.' };
        res.redirect(`/users/edit/${req.params.id}`);
    }
});

// POST /users/delete/:id - Delete a user
router.post('/delete/:id', async (req, res) => {
    // Log this action BEFORE deleting
    const userToDelete = await get('SELECT username FROM users WHERE id = ?', [req.params.id]);
    await logAction(req.session.user.id, req.session.user.username, 'User Deleted', `Deleted user: ${userToDelete.username} (ID: ${req.params.id})`);

    await run('DELETE FROM users WHERE id = ?', [req.params.id]);
    req.session.flash = { type: 'success', message: 'User deleted successfully!' };
    res.redirect('/users/manage');
});

module.exports = router;