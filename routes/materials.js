const express = require('express');
const router = express.Router();
const { all, get, run, logAction, transaction } = require('../db-helpers');
const qrcode = require('qrcode');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const fs = require('fs');

// Ensure QR code directory exists
const qrCodeDir = path.join(__dirname, '..', 'public', 'qrcodes');
if (!fs.existsSync(qrCodeDir)) {
    fs.mkdirSync(qrCodeDir, { recursive: true });
}

// Setup multer for file uploads in memory
const upload = multer({ storage: multer.memoryStorage() });

// GET: List all materials in stock
router.get('/', async (req, res) => {
    try {
        const { q, status, page = 1 } = req.query;
        const limit = 50; // Items per page

        // Build the query for fetching the list of materials
        let materialsSql = 'SELECT * FROM material_stock';
        const whereClauses = [];
        const params = [];

        if (q) {
            whereClauses.push('(name LIKE ? OR unique_id LIKE ?)');
            params.push(`%${q}%`, `%${q}%`);
        }

        if (status && status !== 'all') {
            whereClauses.push('status = ?');
            params.push(status);
        }

        if (whereClauses.length > 0) {
            materialsSql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        // Get total count for pagination
        const countSql = `SELECT COUNT(*) as count FROM material_stock ${whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : ''}`;
        const totalResult = await get(countSql, params);
        const totalItems = totalResult.count || 0;
        const totalPages = Math.ceil(totalItems / limit);
        const currentPage = parseInt(page);
        const offset = (currentPage - 1) * limit;

        materialsSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        const fullParams = [...params, limit, offset];

        const pagination = {
            currentPage,
            totalPages,
            hasPrevPage: currentPage > 1,
            hasNextPage: currentPage < totalPages,
            totalItems
        };

        // Fetch materials and summary in parallel
        const [materials, summaryData] = await Promise.all([
            all(materialsSql, fullParams),
            all('SELECT name, status, COUNT(*) as count FROM material_stock GROUP BY name, status')
        ]);

        // Process summary data into a structured object for the view
        const materialSummary = (summaryData || []).reduce((acc, row) => {
            if (!acc[row.name]) {
                acc[row.name] = { Total: 0, Available: 0, Issued: 0, Damaged: 0 };
            }
            acc[row.name][row.status] = row.count;
            acc[row.name].Total += row.count;
            return acc;
        }, {});

        res.render('manageMaterials', {
            title: 'Manage Material Stock',
            materials: materials || [],
            materialSummary,
            pagination,
            filters: { q: q || '', status: status || 'all' },
            message: req.query.message
        });
    } catch (err) {
        console.error('Error fetching material stock:', err.message);
        res.status(500).send('Error loading page.');
    }
});

// GET: Show form to add a new material to stock
router.get('/add', (req, res) => {
    res.render('addMaterial', {
        title: 'Add New Material to Stock'
    });
});

// POST: Add a new material and generate QR code
router.post('/add', async (req, res) => {
    const { name, description, quantity } = req.body;
    const numQuantity = parseInt(quantity, 10) || 1;

    if (!name) {
        return res.status(400).send('Material Name is required.');
    }

    const activeSession = res.locals.activeSession;
    const locationCode = (activeSession.location || 'GNR').substring(0, 3).toUpperCase();
    const materialCode = name.substring(0, 1).toUpperCase();
    const prefix = `NCF/${materialCode}/${locationCode}`;

    try {
        // Find the next sequence number for this prefix
        const lastMaterial = await get(
            'SELECT MAX(sequence) as max_seq FROM material_stock WHERE unique_id LIKE ?',
            [`${prefix}/%`]
        );
        let nextSequence = (lastMaterial?.max_seq || 0) + 1;

        const logoPath = activeSession.logo_path ? path.join(__dirname, '..', 'public', activeSession.logo_path) : null;

        for (let i = 0; i < numQuantity; i++) {
            const sequenceString = (nextSequence + i).toString().padStart(4, '0');
            const uniqueId = `${prefix}/${sequenceString}`;
            const qrCodeFileName = `${uniqueId.replace(/\//g, '-')}.png`;
            const qrCodePath = path.join(qrCodeDir, qrCodeFileName);
            const qrCodeUrlPath = `/qrcodes/${qrCodeFileName}`;

            // Generate QR code and save as a file
            const qrOptions = {
                errorCorrectionLevel: 'H', // High correction for logo
                width: 256
            };
            if (logoPath && fs.existsSync(logoPath)) {
                await qrcode.toFile(qrCodePath, uniqueId, qrOptions);
            } else {
                await qrcode.toFile(qrCodePath, uniqueId);
            }

            // Insert into database
            await run(
                'INSERT INTO material_stock (name, description, unique_id, qr_code_path, sequence, event_session_id) VALUES (?, ?, ?, ?, ?, ?)',
                [name, description, uniqueId, qrCodeUrlPath, nextSequence + i, activeSession.id]
            );
        }

        await logAction(req.session.user.id, req.session.user.username, 'create_material_stock', `Added ${numQuantity} x ${name} to stock.`);
        res.redirect('/materials?message=Successfully added materials to stock.');
    } catch (err) {
        console.error('Error adding material to stock:', err.message);
        res.status(500).send('Failed to add material to stock.');
    }
});

// GET: Show form for bulk uploading materials
router.get('/bulk-upload', (req, res) => {
    res.render('bulkUploadMaterials', {
        title: 'Bulk Upload Materials'
    });
});

// POST: Handle bulk upload from CSV
router.post('/bulk-upload', upload.single('materialsCsv'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No CSV file uploaded.');
    }

    const materialsToProcess = [];
    const readableStream = Readable.from(req.file.buffer.toString());

    readableStream
        .pipe(csv())
        .on('data', (row) => {
            materialsToProcess.push(row);
        })
        .on('end', async () => {
            try {
                let itemsAddedCount = 0;
                const activeSession = res.locals.activeSession;
                const locationCode = (activeSession.location || 'GNR').substring(0, 3).toUpperCase();
                const logoPath = activeSession.logo_path ? path.join(__dirname, '..', 'public', activeSession.logo_path) : null;

                // Group materials by prefix to manage sequences
                for (const material of materialsToProcess) {
                    const name = material.name;
                    const description = material.description || '';
                    const quantity = parseInt(material.quantity, 10) || 1;

                    if (!name) continue; // Skip rows without a name

                    const materialCode = name.substring(0, 1).toUpperCase();
                    const prefix = `NCF/${materialCode}/${locationCode}`;

                    const lastMaterial = await get('SELECT MAX(sequence) as max_seq FROM material_stock WHERE unique_id LIKE ?', [`${prefix}/%`]);
                    let nextSequence = (lastMaterial?.max_seq || 0) + 1;

                    for (let i = 0; i < quantity; i++) {
                        const currentSequence = nextSequence + i;
                        const sequenceString = currentSequence.toString().padStart(4, '0');
                        const uniqueId = `${prefix}/${sequenceString}`;
                        const qrCodeFileName = `${uniqueId.replace(/\//g, '-')}.png`;
                        const qrCodePath = path.join(qrCodeDir, qrCodeFileName);
                        const qrCodeUrlPath = `/qrcodes/${qrCodeFileName}`;

                        const qrOptions = { errorCorrectionLevel: 'H', width: 256 };
                        if (logoPath && fs.existsSync(logoPath)) {
                            await qrcode.toFile(qrCodePath, uniqueId, qrOptions);
                        } else {
                            await qrcode.toFile(qrCodePath, uniqueId);
                        }

                        await run(
                            'INSERT INTO material_stock (name, description, unique_id, qr_code_path, sequence, event_session_id) VALUES (?, ?, ?, ?, ?, ?)',
                            [name, description, uniqueId, qrCodeUrlPath, currentSequence, activeSession.id]
                        );
                        itemsAddedCount++;
                    }
                }
                await logAction(req.session.user.id, req.session.user.username, 'bulk_create_material_stock', `Bulk added ${itemsAddedCount} material items from CSV.`);
                res.redirect(`/materials?message=${itemsAddedCount} materials have been successfully added from the CSV file.`);
            } catch (err) {
                console.error('Error processing bulk material upload:', err.message);
                res.status(500).send('Failed to process CSV file.');
            }
        });
});

// POST: Delete a material from stock
router.post('/delete/:id', async (req, res) => {
    const { id } = req.params;
    // Find the QR code path before deleting
    const material = await get('SELECT qr_code_path FROM material_stock WHERE id = ?', [id]);
    try {
        await run('DELETE FROM material_stock WHERE id = ?', [id]);
        if (material && material.qr_code_path) {
            const imagePath = path.join(__dirname, '..', 'public', material.qr_code_path);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }
        await logAction(req.session.user.id, req.session.user.username, 'delete_material_stock', `Deleted material stock item #${id}`);
        res.redirect('/materials?message=Material deleted successfully.');
    } catch (err) {
        console.error('Error deleting material:', err.message);
        res.status(500).send('Failed to delete material. It might be in use.');
    }
});

// POST: Bulk delete materials
router.post('/bulk-delete', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).send('No materials selected for deletion.');
    }
    try {
        const placeholders = ids.map(() => '?').join(',');
        await run(`DELETE FROM material_stock WHERE id IN (${placeholders})`, ids);
        await logAction(req.session.user.id, req.session.user.username, 'bulk_delete_material_stock', `Bulk deleted ${ids.length} material items.`);
        res.redirect('/materials?message=Selected materials deleted successfully.');
    } catch (err) {
        console.error('Error bulk deleting materials:', err.message);
        res.status(500).send('Failed to delete materials.');
    }
});

// POST: Update a material's status (e.g., from Damaged to Available)
router.post('/update-status/:id', async (req, res) => {
    const { id } = req.params;
    const { newStatus, redirectUrl } = req.body;

    if (!newStatus) {
        return res.status(400).send('New status is required.');
    }

    try {
        const material = await get('SELECT id FROM material_stock WHERE id = ?', [id]);
        if (!material) {
            return res.status(404).send('Material not found.');
        }
        await run('UPDATE material_stock SET status = ? WHERE id = ?', [newStatus, id]);
        // Log the status change
        await run('INSERT INTO material_history (material_id, status, user_id, username) VALUES (?, ?, ?, ?)', [id, newStatus, req.session.user.id, req.session.user.username]);
        res.redirect(`${redirectUrl || '/materials'}?message=Material status updated successfully.`);
    } catch (err) {
        console.error('Error updating material status:', err.message);
        res.status(500).send('Failed to update material status.');
    }
});

// GET: Show page to issue materials by scanning QR codes
router.get('/issue', async (req, res) => {
    try {
        const selectedClientId = req.query.client_id || null;
        // Fetch clients who have active bookings to populate the dropdown
        const clients = await all(`
            SELECT c.id, c.name, s.name as space_name
            FROM clients c
            JOIN bookings b ON c.id = b.client_id
            JOIN spaces s ON b.space_id = s.id
            WHERE b.booking_status = 'active' AND b.event_session_id = ?
            ORDER BY c.name
        `, [res.locals.viewingSession.id]);

        res.render('issueMaterialByScan', {
            title: 'Issue Materials by QR Scan',
            clients: clients || [],
            selectedClientId
        });
    } catch (err) {
        console.error('Error loading material issue page:', err.message);
        res.status(500).send('Error loading page.');
    }
});

// POST API: Issue a single material item to a client
router.post('/api/issue-item', async (req, res) => {
    const { uniqueId, clientId } = req.body;

    if (!uniqueId || !clientId) {
        return res.status(400).json({ success: false, message: 'Unique ID and Client ID are required.' });
    }

    try {
        const material = await get('SELECT * FROM material_stock WHERE unique_id = ?', [uniqueId]);

        if (!material) {
            return res.status(404).json({ success: false, message: `Material with ID ${uniqueId} not found.` });
        }

        if (material.status !== 'Available') {
            return res.status(409).json({ success: false, message: `Material "${material.name}" is already ${material.status}.` });
        }

        // --- Smart Billing Logic for Tables and Chairs ---
        let isPaidItem = false;
        let itemCost = 0;
        const itemName = material.name.toLowerCase();

        if (itemName === 'table' || itemName === 'chair') {
            // 1. Get booking type for the client
            const booking = await get(`
                SELECT s.type as space_type 
                FROM bookings b 
                JOIN spaces s ON b.space_id = s.id 
                WHERE b.client_id = ? AND b.booking_status = 'active' AND b.event_session_id = ?
            `, [clientId, res.locals.viewingSession.id]);

            const spaceType = booking ? booking.space_type.toLowerCase() : '';

            // 2. Define free limits and costs
            const limits = {
                table: spaceType === 'pavilion' ? 2 : 1,
                chair: 2 // Same for all
            };
            const costs = { table: 600, chair: 100 };

            // 3. Count how many of this item type are already issued to the client
            const issuedCountResult = await get(
                `SELECT COUNT(*) as count FROM material_stock WHERE issued_to_client_id = ? AND LOWER(name) = ? AND status = 'Issued'`,
                [clientId, itemName]
            );
            const issuedCount = issuedCountResult.count || 0;

            // 4. Check if the new item exceeds the free limit
            if (issuedCount >= limits[itemName]) {
                isPaidItem = true;
                itemCost = costs[itemName];
            }
        }

        await transaction(async (db) => {
            // Update the specific material_stock item's status
            await db.run("UPDATE material_stock SET status = 'Issued', issued_to_client_id = ? WHERE id = ?", [clientId, material.id]);

            // Log the issuance in the material's history
            await db.run('INSERT INTO material_history (material_id, status, client_id, user_id, username) VALUES (?, ?, ?, ?, ?)', [material.id, 'Issued', clientId, req.session.user.id, req.session.user.username]);

            // --- Record Asset ID in Material Issues for tracking ---
            if (itemName === 'table' || itemName === 'chair') {
                const assetIdSuffix = material.unique_id.slice(-4);
                const numberField = itemName === 'table' ? 'table_numbers' : 'chair_numbers';

                // Find today's material issue record for this client, if one exists
                let issueRecord = await db.get("SELECT id, table_numbers, chair_numbers FROM material_issues WHERE client_id = ? AND issue_date = date('now')", [clientId]);

                if (issueRecord) {
                    // Append the new asset ID to the existing list
                    const existingNumbers = issueRecord[numberField] || '';
                    const newNumbers = existingNumbers ? `${existingNumbers}, ${assetIdSuffix}` : assetIdSuffix;
                    await db.run(`UPDATE material_issues SET ${numberField} = ? WHERE id = ?`, [newNumbers, issueRecord.id]);
                } else {
                    // If no record for today, create a new one just for tracking the asset number
                    await db.run(`
                        INSERT INTO material_issues (client_id, issue_date, ${numberField}, notes, event_session_id) 
                        VALUES (?, date('now'), ?, ?, ?)`, [clientId, assetIdSuffix, 'Asset tracking record created via QR scan.', res.locals.viewingSession.id]
                    );
                }
            }

            // If it's a paid item, create a billable charge in material_issues
            if (isPaidItem) {
                const paidField = itemName === 'table' ? 'table_paid' : 'chair_paid';
                await db.run(`
                    INSERT INTO material_issues (client_id, issue_date, ${paidField}, total_payable, balance_due, notes, event_session_id) 
                    VALUES (?, date('now'), 1, ?, ?, ?, ?)
                `, [clientId, itemCost, itemCost, `Billed for 1 extra ${material.name} via QR scan.`, res.locals.viewingSession.id]);

                // Also update the master due amount on the booking
                const bookingForUpdate = await db.get('SELECT id FROM bookings WHERE client_id = ? AND booking_status = "active"', [clientId]);
                if (bookingForUpdate) {
                    await db.run('UPDATE bookings SET due_amount = due_amount + ? WHERE id = ?', [itemCost, bookingForUpdate.id]);
                }
            }
        });

        await logAction(req.session.user.id, req.session.user.username, 'issue_material_stock', `Issued material #${material.id} (${material.name}) to client #${clientId}`);
        res.json({ success: true, message: `Successfully issued "${material.name}" to the client.` });
    } catch (err) {
        console.error('Error issuing material item:', err.message);
        res.status(500).json({ success: false, message: 'A server error occurred while issuing the item.' });
    }
});

// GET: Show page to return materials by scanning QR codes
router.get('/return', (req, res) => {
    res.render('returnMaterialByScan', {
        title: 'Return Materials by QR Scan'
    });
});

// POST API: Return a single material item to stock
router.post('/api/return-item', async (req, res) => {
    const { uniqueId, status } = req.body;

    if (!uniqueId) {
        return res.status(400).json({ success: false, message: 'Unique ID is required.' });
    }

    // Validate the incoming status, default to 'Available'
    const newStatus = (status === 'Damaged') ? 'Damaged' : 'Available';

    try {
        const material = await get('SELECT s.*, c.name as client_name FROM material_stock s LEFT JOIN clients c ON s.issued_to_client_id = c.id WHERE s.unique_id = ?', [uniqueId]);

        if (!material) {
            return res.status(404).json({ success: false, message: `Material with ID ${uniqueId} not found.` });
        }

        if (material.status !== 'Issued') {
            return res.status(409).json({ success: false, message: `Material "${material.name}" is already ${material.status}.` });
        }

        // Update the material's status and remove client assignment
        await run("UPDATE material_stock SET status = ?, issued_to_client_id = NULL WHERE id = ?", [newStatus, material.id]);

        // Log the return action
        await run('INSERT INTO material_history (material_id, status, client_id, user_id, username) VALUES (?, ?, ?, ?, ?)', [material.id, newStatus, material.issued_to_client_id, req.session.user.id, req.session.user.username]);

        const logDetails = `Material #${material.id} (${material.name}) was returned with status: ${newStatus}. It was previously issued to ${material.client_name || 'an unknown client'}.`;
        await logAction(req.session.user.id, req.session.user.username, 'return_material_stock', logDetails);
        
        res.json({ 
            success: true, 
            message: `Successfully returned "${material.name}" with status: ${newStatus}.` 
        });

    } catch (err) {
        console.error('Error returning material item:', err.message);
        res.status(500).json({ success: false, message: 'A server error occurred while returning the item.' });
    }
});

// GET: View all materials issued to a specific client
router.get('/issued-to/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        // Fetch client details and issued materials in parallel
        const [client, issuedMaterials] = await Promise.all([
            get('SELECT * FROM clients WHERE id = ?', [clientId]),
            all('SELECT * FROM material_stock WHERE issued_to_client_id = ? AND status = ? ORDER BY name', [clientId, 'Issued'])
        ]);

        if (!client) {
            return res.status(404).send('Client not found.');
        }

        res.render('issuedMaterialsByClient', {
            title: `Materials Issued to ${client.name}`,
            client,
            materials: issuedMaterials || []
        });
    } catch (err) {
        console.error('Error fetching issued materials for client:', err.message);
        res.status(500).send('Error loading page.');
    }
});

// GET: Show history for a single material item
router.get('/history/:id', async (req, res) => {
    const materialId = req.params.id;
    try {
        const material = await get('SELECT id, name, unique_id, event_session_id FROM material_stock WHERE id = ?', [materialId]);
        if (!material) {
            return res.status(404).send('Material not found.');
        }

        const history = await all(`
            SELECT 
                h.timestamp,
                h.status,
                h.username,
                c.name as client_name,
                b.id as booking_id
            FROM material_history h
            LEFT JOIN clients c ON h.client_id = c.id
            LEFT JOIN bookings b ON h.client_id = b.client_id AND b.event_session_id = ? AND b.booking_status = 'active'
            WHERE h.material_id = ?
            ORDER BY h.timestamp DESC
        `, [material.event_session_id, materialId]);

        res.render('materialHistory', {
            title: `History for ${material.name}`,
            material,
            history: history || []
        });
    } catch (err) {
        console.error('Error fetching material history:', err.message);
        res.status(500).send('Error loading history page.');
    }
});

// GET: Show a printable page with all QR codes
router.get('/print-qrcodes', async (req, res) => {
    try {
        const { name: filterName } = req.query;

        // Fetch distinct material names for the filter dropdown
        const materialNamesResult = await all('SELECT DISTINCT name FROM material_stock ORDER BY name');
        const materialNames = materialNamesResult.map(item => item.name);

        let sql = 'SELECT unique_id, qr_code_path, name FROM material_stock';
        const params = [];

        if (filterName && filterName !== 'all') {
            sql += ' WHERE name = ?';
            params.push(filterName);
        }

        sql += ' ORDER BY name, id';

        const materials = await all(sql, params);
        res.render('printMaterialQRCodes', {
            layout: false, // This tells EJS not to use the main layout file
            title: 'Print All Material QR Codes',
            materials: materials || [],
            materialNames,
            currentFilter: filterName || 'all'
        });
    } catch (err) {
        console.error('Error fetching materials for printing:', err.message);
        res.status(500).send('Error loading QR code print page.');
    }
});

module.exports = router;