const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAdmin, requireRole, ROLE_LABELS } = require('../middleware/auth');
const { upload, uploadImageToR2, deleteImageFromR2 } = require('../middleware/r2');

// Parses the admin's "Label: Value" specsText textarea into the
// [{label, value}, ...] JSON shape the products.specs column stores.
function parseSpecsText(specsText) {
    if (!specsText) return [];
    return specsText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const idx = line.indexOf(':');
            if (idx === -1) return { label: line, value: '' };
            return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
        })
        .filter(s => s.label);
}

// Login page
router.get('/login', (req, res) => {
    res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);

    if (rows.length === 0) {
        return res.render('admin/login', { error: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });
    }

    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) {
        return res.render('admin/login', { error: 'ভুল ইউজারনেম বা পাসওয়ার্ড' });
    }

    req.session.isAdmin = true;
    req.session.adminUsername = username;
    req.session.adminRole = rows[0].role || 'admin';
    res.redirect('/admin/dashboard');
});

router.post('/logout', (req, res) => {
    req.session.isAdmin = false;
    req.session.adminRole = null;
    req.session.adminUsername = null;
    res.redirect('/admin/login');
});

// Dashboard
router.get('/dashboard', requireAdmin, async (req, res) => {
    const { rows: products } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    const { rows: orderStats } = await pool.query(`
        SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_revenue
        FROM orders WHERE status != 'cancelled'
    `);
    // Best sellers — total quantity sold per product, cancelled orders excluded
    const { rows: bestSellers } = await pool.query(`
        SELECT
            oi.product_id,
            oi.product_name,
            p.image_url,
            SUM(oi.quantity) AS total_sold,
            SUM(oi.quantity * oi.price) AS total_revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE o.status != 'cancelled'
        GROUP BY oi.product_id, oi.product_name, p.image_url
        ORDER BY total_sold DESC
        LIMIT 5
    `);
    res.render('admin/dashboard', { products, stats: orderStats[0], bestSellers, addedSuccess: req.query.added === '1' });
});

// New product form
router.get('/products/new', requireRole('admin', 'manager'), (req, res) => {
    res.render('admin/product-form', { product: null, galleryImages: [], error: null });
});

const productImageUpload = upload.fields([
    { name: 'image', maxCount: 1 },     // cover photo (shown in grid/dashboard)
    { name: 'gallery', maxCount: 8 }    // extra photos for the product page gallery
]);

router.post('/products/new', requireRole('admin', 'manager'), productImageUpload, async (req, res) => {
    try {
        const { name, description, price, stock, category, warranty } = req.body;
        const discountPercent = parseInt(req.body.discountPercent, 10) || 0;
        const specs = JSON.stringify(parseSpecsText(req.body.specsText));
        const coverFile = req.files && req.files.image ? req.files.image[0] : null;
        const galleryFiles = (req.files && req.files.gallery) || [];
        const imageUrl = coverFile ? await uploadImageToR2(coverFile) : null;

        const { rows } = await pool.query(
            `INSERT INTO products (name, description, price, stock, category, image_url, discount_percent, warranty, specs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [name, description, price, stock, category, imageUrl, discountPercent, warranty || null, specs]
        );
        const productId = rows[0].id;

        let sortOrder = 0;
        for (const file of galleryFiles) {
            const url = await uploadImageToR2(file);
            await pool.query(
                'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ($1, $2, $3)',
                [productId, url, sortOrder++]
            );
        }

        res.redirect('/admin/dashboard?added=1');
    } catch (err) {
        console.error(err);
        res.render('admin/product-form', { product: null, galleryImages: [], error: 'প্রোডাক্ট যোগ করা যায়নি' });
    }
});

// Edit product form
router.get('/products/:id/edit', requireAdmin, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.redirect('/admin/dashboard');
    const { rows: galleryImages } = await pool.query(
        'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
        [req.params.id]
    );
    const { rows: notifyRequests } = await pool.query(
        'SELECT * FROM stock_notify_requests WHERE product_id = $1 AND notified = FALSE ORDER BY created_at ASC',
        [req.params.id]
    );
    const specsText = (rows[0].specs || []).map(s => `${s.label}: ${s.value}`).join('\n');
    res.render('admin/product-form', { product: rows[0], galleryImages, notifyRequests, specsText, error: null, savedSuccess: req.query.saved === '1' });
});

router.post('/products/:id/edit', requireAdmin, productImageUpload, async (req, res) => {
    try {
        const { name, description, price, stock, category, warranty } = req.body;
        const discountPercent = parseInt(req.body.discountPercent, 10) || 0;
        const specs = JSON.stringify(parseSpecsText(req.body.specsText));
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
        if (rows.length === 0) return res.redirect('/admin/dashboard');

        const coverFile = req.files && req.files.image ? req.files.image[0] : null;
        const galleryFiles = (req.files && req.files.gallery) || [];

        let imageUrl = rows[0].image_url;
        if (coverFile) {
            await deleteImageFromR2(imageUrl);
            imageUrl = await uploadImageToR2(coverFile);
        }

        await pool.query(
            `UPDATE products SET name=$1, description=$2, price=$3, stock=$4, category=$5, image_url=$6, discount_percent=$7, warranty=$8, specs=$9 WHERE id=$10`,
            [name, description, price, stock, category, imageUrl, discountPercent, warranty || null, specs, req.params.id]
        );

        if (galleryFiles.length > 0) {
            const { rows: countRows } = await pool.query(
                'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM product_images WHERE product_id = $1',
                [req.params.id]
            );
            let sortOrder = countRows[0].max_order + 1;
            for (const file of galleryFiles) {
                const url = await uploadImageToR2(file);
                await pool.query(
                    'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ($1, $2, $3)',
                    [req.params.id, url, sortOrder++]
                );
            }
        }

        res.redirect('/admin/products/' + req.params.id + '/edit?saved=1');
    } catch (err) {
        console.error(err);
        res.render('admin/product-form', { product: null, galleryImages: [], error: 'আপডেট করা যায়নি' });
    }
});

// Mark all pending stock-notify requests for this product as handled
router.post('/products/:id/notify-requests/clear', requireAdmin, async (req, res) => {
    await pool.query(
        'UPDATE stock_notify_requests SET notified = TRUE WHERE product_id = $1',
        [req.params.id]
    );
    res.redirect('/admin/products/' + req.params.id + '/edit');
});

// Delete one gallery photo (not the cover photo)
router.post('/products/:id/images/:imageId/delete', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM product_images WHERE id = $1 AND product_id = $2',
            [req.params.imageId, req.params.id]
        );
        if (rows.length > 0) {
            await deleteImageFromR2(rows[0].image_url);
            await pool.query('DELETE FROM product_images WHERE id = $1', [req.params.imageId]);
        }
        res.redirect('/admin/products/' + req.params.id + '/edit');
    } catch (err) {
        console.error('Image delete error:', err.message);
        res.redirect('/admin/products/' + req.params.id + '/edit');
    }
});

// Delete product
router.post('/products/:id/delete', requireRole('admin', 'manager'), async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
        if (rows.length > 0 && rows[0].image_url) {
            await deleteImageFromR2(rows[0].image_url);
        }
        const { rows: galleryRows } = await pool.query('SELECT * FROM product_images WHERE product_id = $1', [req.params.id]);
        for (const img of galleryRows) {
            await deleteImageFromR2(img.image_url);
        }
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error('Product delete error:', err.message);
        res.redirect('/admin/dashboard');
    }
});

// Orders list
router.get('/orders', requireAdmin, async (req, res) => {
    const { rows: orders } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.render('admin/orders', { orders });
});

// Order detail
router.get('/orders/:id', requireAdmin, async (req, res) => {
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (orderRows.length === 0) return res.redirect('/admin/orders');
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    res.render('admin/order-detail', { order: orderRows[0], items });
});

// Update order status
router.post('/orders/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.redirect(`/admin/orders/${req.params.id}`);
});

// Delete order (also removes its order_items via ON DELETE CASCADE) —
// mainly for clearing out test/dummy orders so they don't skew dashboard stats.
router.post('/orders/:id/delete', requireRole('admin', 'manager'), async (req, res) => {
    try {
        await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
        res.redirect('/admin/orders');
    } catch (err) {
        console.error('Order delete error:', err.message);
        res.redirect('/admin/orders');
    }
});

// ==========================================================================
// Staff management (admin only) — create/edit/delete Manager & Moderator accounts
// ==========================================================================

router.get('/staff', requireRole('admin'), async (req, res) => {
    const { rows: staff } = await pool.query('SELECT id, username, role FROM admins ORDER BY id ASC');
    res.render('admin/staff', { staff, error: null, roleLabels: ROLE_LABELS, currentUsername: req.session.adminUsername });
});

router.get('/staff/new', requireRole('admin'), (req, res) => {
    res.render('admin/staff-form', { error: null, roleLabels: ROLE_LABELS });
});

router.post('/staff/new', requireRole('admin'), async (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!['admin', 'manager', 'moderator'].includes(role)) {
            return res.render('admin/staff-form', { error: 'সঠিক রোল বেছে নিন।', roleLabels: ROLE_LABELS });
        }
        const existing = await pool.query('SELECT id FROM admins WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.render('admin/staff-form', { error: 'এই ইউজারনেম আগে থেকেই আছে।', roleLabels: ROLE_LABELS });
        }
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [username, hash, role]);
        res.redirect('/admin/staff');
    } catch (err) {
        console.error(err);
        res.render('admin/staff-form', { error: 'অ্যাকাউন্ট তৈরি করা যায়নি।', roleLabels: ROLE_LABELS });
    }
});

// Delete a staff account (can't delete your own account, or the last remaining admin)
router.post('/staff/:id/delete', requireRole('admin'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.redirect('/admin/staff');

    if (rows[0].username === req.session.adminUsername) {
        const { rows: staff } = await pool.query('SELECT id, username, role FROM admins ORDER BY id ASC');
        return res.render('admin/staff', { staff, error: 'নিজের অ্যাকাউন্ট নিজে ডিলিট করা যাবে না।', roleLabels: ROLE_LABELS, currentUsername: req.session.adminUsername });
    }

    if (rows[0].role === 'admin') {
        const { rows: adminCount } = await pool.query("SELECT COUNT(*) FROM admins WHERE role = 'admin'");
        if (parseInt(adminCount[0].count, 10) <= 1) {
            const { rows: staff } = await pool.query('SELECT id, username, role FROM admins ORDER BY id ASC');
            return res.render('admin/staff', { staff, error: 'সিস্টেমে অন্তত একজন Admin থাকা আবশ্যক।', roleLabels: ROLE_LABELS, currentUsername: req.session.adminUsername });
        }
    }

    await pool.query('DELETE FROM admins WHERE id = $1', [req.params.id]);
    res.redirect('/admin/staff');
});

module.exports = router;
