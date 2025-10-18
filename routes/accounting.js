const express = require('express');
const router = express.Router();
const { all, get, run } = require('../db-helpers');

// GET /accounting - Main accounting page
router.get('/', async (req, res) => {
  try {
    const { start_date, end_date, type, q, page = 1 } = req.query;

    let sql = 'SELECT a.*, u.username FROM accounting_transactions a LEFT JOIN users u ON a.user_id = u.id';
    const whereClauses = [];
    const params = [];

    if (start_date) {
      whereClauses.push('a.transaction_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('a.transaction_date <= ?');
      params.push(end_date);
    }
    if (type && type !== 'all') {
      whereClauses.push('a.transaction_type = ?');
      params.push(type);
    }
    if (q) {
      whereClauses.push('(a.category LIKE ? OR a.description LIKE ?)');
      params.push(`%${q}%`);
      params.push(`%${q}%`);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    // Get total count for pagination and full summary
    const countSql = `SELECT COUNT(*) as count, SUM(CASE WHEN a.transaction_type = 'income' THEN a.amount ELSE 0 END) as total_income, SUM(CASE WHEN a.transaction_type = 'expenditure' THEN a.amount ELSE 0 END) as total_expenditure FROM accounting_transactions a ${whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : ''}`;
    const summaryResult = await get(countSql, params);

    const totalTransactions = summaryResult.count || 0;
    const total_income = summaryResult.total_income || 0;
    const total_expenditure = summaryResult.total_expenditure || 0;

    const pageSize = 25;
    const totalPages = Math.ceil(totalTransactions / pageSize);
    const offset = (page - 1) * pageSize;

    // Get transactions for the current page
    const pagedSql = sql + ' ORDER BY a.transaction_date DESC, a.created_at DESC LIMIT ? OFFSET ?';
    const transactions = await all(pagedSql, [...params, pageSize, offset]);
    
    const balance = total_income - total_expenditure;

    res.render('accounting', {
      title: 'Income & Expenditure',
      transactions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        pageSize,
        totalTransactions,
        hasPrevPage: page > 1,
        hasNextPage: page < totalPages
      },
      summary: {
        total_income,
        total_expenditure,
        balance
      },
      filters: {
        start_date: start_date || '',
        end_date: end_date || '',
        type: type || 'all',
        q: q || ''
      }
    });
  } catch (err) {
    console.error("Error loading accounting page:", err);
    res.status(500).send('Error loading accounting data.');
  }
});

// POST /accounting/add - Add a new transaction
router.post('/add', async (req, res) => {
  const { transaction_type, category, description, amount, transaction_date } = req.body;
  const user_id = req.session.user.id;

  if (!transaction_type || !category || !amount || !transaction_date) {
    req.session.flash = { type: 'danger', message: 'Please fill in all required fields.' };
    return res.redirect('/accounting');
  }

  try {
    const sql = `INSERT INTO accounting_transactions (transaction_type, category, description, amount, transaction_date, user_id) VALUES (?, ?, ?, ?, ?, ?)`;
    await run(sql, [transaction_type, category, description, parseFloat(amount), transaction_date, user_id]);
    req.session.flash = { type: 'success', message: 'Transaction added successfully!' };
    res.redirect('/accounting');
  } catch (err) {
    console.error("Error adding accounting transaction:", err);
    req.session.flash = { type: 'danger', message: 'Failed to add transaction. Please try again.' };
    res.redirect('/accounting');
  }
});

// GET /accounting/edit/:id - Show form to edit a transaction
router.get('/edit/:id', async (req, res) => {
  const transactionId = req.params.id;
  try {
    const transaction = await get('SELECT * FROM accounting_transactions WHERE id = ?', [transactionId]);
    if (!transaction) {
      req.session.flash = { type: 'danger', message: 'Transaction not found.' };
      return res.redirect('/accounting');
    }
    res.render('editAccountingTransaction', {
      title: 'Edit Accounting Transaction',
      transaction
    });
  } catch (err) {
    console.error(`Error loading transaction #${transactionId} for editing:`, err.message);
    req.session.flash = { type: 'danger', message: 'Error loading transaction for editing.' };
    res.redirect('/accounting');
  }
});

// POST /accounting/edit/:id - Update an existing transaction
router.post('/edit/:id', async (req, res) => {
  const transactionId = req.params.id;
  const { transaction_type, category, description, amount, transaction_date } = req.body;

  if (!transaction_type || !category || !amount || !transaction_date) {
    req.session.flash = { type: 'danger', message: 'Please fill in all required fields.' };
    return res.redirect(`/accounting/edit/${transactionId}`);
  }

  try {
    // Security check: Prevent editing of automated payment transactions
    const transaction = await get('SELECT category FROM accounting_transactions WHERE id = ?', [transactionId]);
    if (transaction && transaction.category.endsWith(' Payment')) {
      req.session.flash = { type: 'danger', message: 'Automated payment transactions cannot be edited.' };
      return res.redirect('/accounting');
    }

    const sql = `UPDATE accounting_transactions SET transaction_type = ?, category = ?, description = ?, amount = ?, transaction_date = ? WHERE id = ?`;
    await run(sql, [transaction_type, category, description, parseFloat(amount), transaction_date, transactionId]);
    req.session.flash = { type: 'success', message: 'Transaction updated successfully!' };
    res.redirect('/accounting');
  } catch (err) {
    console.error(`Error updating accounting transaction #${transactionId}:`, err.message);
    req.session.flash = { type: 'danger', message: 'Failed to update transaction. Please try again.' };
    res.redirect(`/accounting/edit/${transactionId}`);
  }
});

// POST /accounting/delete/:id - Delete a transaction
router.post('/delete/:id', async (req, res) => {
  const transactionId = req.params.id;

  try {
    // Security check: Prevent deletion of automated payment transactions
    const transaction = await get('SELECT category FROM accounting_transactions WHERE id = ?', [transactionId]);
    if (transaction && transaction.category.endsWith(' Payment')) {
      req.session.flash = { type: 'danger', message: 'Automated payment transactions cannot be deleted.' };
      return res.redirect('/accounting');
    }

    // Proceed with deletion
    const result = await run('DELETE FROM accounting_transactions WHERE id = ?', [transactionId]);
    if (result.changes > 0) {
      req.session.flash = { type: 'success', message: 'Transaction deleted successfully!' };
    } else {
      req.session.flash = { type: 'danger', message: 'Transaction not found or already deleted.' };
    }
    res.redirect('/accounting');
  } catch (err) {
    console.error(`Error deleting accounting transaction #${transactionId}:`, err.message);
    req.session.flash = { type: 'danger', message: 'Failed to delete transaction. Please try again.' };
    res.redirect('/accounting');
  }
});

// GET /accounting/report/by-category - Show summary by category
router.get('/report/by-category', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let sql = `
      SELECT
        category,
        transaction_type,
        SUM(amount) as total_amount
      FROM accounting_transactions
    `;
    const whereClauses = [];
    const params = [];

    if (start_date) {
      whereClauses.push('transaction_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('transaction_date <= ?');
      params.push(end_date);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' GROUP BY category, transaction_type ORDER BY category';

    const results = await all(sql, params);

    const summary = results.reduce((acc, row) => {
      if (!acc[row.category]) {
        acc[row.category] = { income: 0, expenditure: 0 };
      }
      if (row.transaction_type === 'income') {
        acc[row.category].income += row.total_amount;
      } else {
        acc[row.category].expenditure += row.total_amount;
      }
      return acc;
    }, {});

    res.render('accountingCategoryReport', {
      title: 'Accounting Report by Category',
      summary,
      filters: {
        start_date: start_date || '',
        end_date: end_date || ''
      }
    });
  } catch (err) {
    console.error("Error loading category report:", err);
    res.status(500).send('Error loading category report data.');
  }
});

// GET /accounting/report/by-category/csv - Export summary by category to CSV
router.get('/report/by-category/csv', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let sql = `
      SELECT
        category,
        transaction_type,
        SUM(amount) as total_amount
      FROM accounting_transactions
    `;
    const whereClauses = [];
    const params = [];

    if (start_date) {
      whereClauses.push('transaction_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('transaction_date <= ?');
      params.push(end_date);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' GROUP BY category, transaction_type ORDER BY category';

    const results = await all(sql, params);

    const summary = results.reduce((acc, row) => {
      if (!acc[row.category]) {
        acc[row.category] = { income: 0, expenditure: 0 };
      }
      if (row.transaction_type === 'income') {
        acc[row.category].income += row.total_amount;
      } else {
        acc[row.category].expenditure += row.total_amount;
      }
      return acc;
    }, {});

    // Generate CSV content
    let csv = 'Category,Total Income,Total Expenditure,Net Change\n';
    for (const category in summary) {
      const item = summary[category];
      const netChange = item.income - item.expenditure;
      csv += `"${category}",${item.income.toFixed(2)},${item.expenditure.toFixed(2)},${netChange.toFixed(2)}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="accounting-category-report.csv"');
    res.status(200).send(csv);

  } catch (err) {
    console.error("Error generating category report CSV:", err);
    res.status(500).send('Error generating CSV file.');
  }
});

// GET /accounting/csv - Export transaction list to CSV
router.get('/csv', async (req, res) => {
  try {
    const { start_date, end_date, type, q } = req.query;

    let sql = 'SELECT a.transaction_date, a.transaction_type, a.category, a.description, a.amount, u.username FROM accounting_transactions a LEFT JOIN users u ON a.user_id = u.id';
    const whereClauses = [];
    const params = [];

    if (start_date) {
      whereClauses.push('a.transaction_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('a.transaction_date <= ?');
      params.push(end_date);
    }
    if (type && type !== 'all') {
      whereClauses.push('a.transaction_type = ?');
      params.push(type);
    }
    if (q) {
      whereClauses.push('(a.category LIKE ? OR a.description LIKE ?)');
      params.push(`%${q}%`);
      params.push(`%${q}%`);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' ORDER BY a.transaction_date DESC, a.created_at DESC';

    const transactions = await all(sql, params);

    // Generate CSV content
    let csv = 'Date,Type,Category,Description,Amount,Added By\n';
    transactions.forEach(t => {
      const description = t.description ? `"${t.description.replace(/"/g, '""')}"` : '';
      csv += `${t.transaction_date},${t.transaction_type},"${t.category}",${description},${t.amount.toFixed(2)},${t.username || 'N/A'}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="accounting-transactions.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error("Error generating transactions CSV:", err);
    res.status(500).send('Error generating CSV file.');
  }
});

module.exports = router;