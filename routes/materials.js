const express = require('express');
const router = express.Router();
const { all, get, run, logAction } = require('../db-helpers');
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
        const materials = await all('SELECT * FROM material_stock ORDER BY created_at DESC');
        res.render('manageMaterials', {
            title: 'Manage Material Stock',
            materials: materials || [],
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

    try {
        const { v4: uuidv4 } = await import('uuid');
        for (let i = 0; i < numQuantity; i++) {
            const uniqueId = uuidv4();
            const qrCodeFileName = `${uniqueId}.png`;
            const qrCodePath = path.join(qrCodeDir, qrCodeFileName);
            const qrCodeUrlPath = `/qrcodes/${qrCodeFileName}`;

            // Generate QR code and save as a file
            await qrcode.toFile(qrCodePath, uniqueId);

            // Insert into database
            await run(
                'INSERT INTO material_stock (name, description, unique_id, qr_code_path) VALUES (?, ?, ?, ?)',
                [name, description, uniqueId, qrCodeUrlPath]
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
                const { v4: uuidv4 } = await import('uuid');
                let itemsAddedCount = 0;

                for (const material of materialsToProcess) {
                    const name = material.name;
                    const description = material.description || '';
                    const quantity = parseInt(material.quantity, 10) || 1;

                    if (!name) continue; // Skip rows without a name

                    for (let i = 0; i < quantity; i++) {
                        const uniqueId = uuidv4();
                        const qrCodeFileName = `${uniqueId}.png`;
                        const qrCodePath = path.join(qrCodeDir, qrCodeFileName);
                        const qrCodeUrlPath = `/qrcodes/${qrCodeFileName}`;

                        await qrcode.toFile(qrCodePath, uniqueId);

                        await run(
                            'INSERT INTO material_stock (name, description, unique_id, qr_code_path) VALUES (?, ?, ?, ?)',
                            [name, description, uniqueId, qrCodeUrlPath]
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
    try {
        // We can also delete the QR code image file from public/qrcodes if needed
        await run('DELETE FROM material_stock WHERE id = ?', [id]);
        await logAction(req.session.user.id, req.session.user.username, 'delete_material_stock', `Deleted material stock item #${id}`);
        res.redirect('/materials?message=Material deleted successfully.');
    } catch (err) {
        console.error('Error deleting material:', err.message);
        res.status(500).send('Failed to delete material. It might be in use.');
    }
});

// GET: Show page to issue materials by scanning QR codes
router.get('/issue', async (req, res) => {
    try {
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
            clients: clients || []
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

        // Update the material's status and assign it to the client
        await run("UPDATE material_stock SET status = 'Issued', issued_to_client_id = ? WHERE id = ?", [clientId, material.id]);

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

module.exports = router;