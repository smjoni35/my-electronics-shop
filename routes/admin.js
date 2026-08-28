const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAdmin, requireRole, ROLE_LABELS } = require('../middleware/auth');
const { upload, uploadImageToR2, deleteImageFromR2 } = require('../middleware/r2');

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
    res.render('admin/dashboard', { products, stats: orderStats[0] });
});

// New product form
router.get('/products/new', requireRole('admin', 'manager'), (req, res) => {
    res.render('admin/product-form', { product: null, error: null });
});

router.post('/products/new', requireRole('admin', 'manager'), upload.single('image'), async (req, res) => {
    try {
        const { name, description, price, stock, category } = req.body;
        const imageUrl = req.file ? await uploadImageToR2(req.file) : null;

        await pool.query(
            `INSERT INTO products (name, description, price, stock, category, image_url)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [name, description, price, stock, category, imageUrl]
        );
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.render('admin/product-form', { product: null, error: 'প্রোডাক্ট যোগ করা যায়নি' });
    }
});

// Edit product form
router.get('/products/:id/edit', requireAdmin, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.redirect('/admin/dashboard');
    res.render('admin/product-form', { product: rows[0], error: null });
});

router.post('/products/:id/edit', requireAdmin, upload.single('image'), async (req, res) => {
    try {
        const { name, description, price, stock, category } = req.body;
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
        if (rows.length === 0) return res.redirect('/admin/dashboard');

        let imageUrl = rows[0].image_url;
        if (req.file) {
            await deleteImageFromR2(imageUrl);
            imageUrl = await uploadImageToR2(req.file);
        }

        await pool.query(
            `UPDATE products SET name=$1, description=$2, price=$3, stock=$4, category=$5, image_url=$6 WHERE id=$7`,
            [name, description, price, stock, category, imageUrl, req.params.id]
        );
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.render('admin/product-form', { product: null, error: 'আপডেট করা যায়নি' });
    }
});

// Delete product
router.post('/products/:id/delete', requireRole('admin', 'manager'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (rows.length > 0 && rows[0].image_url) {
        await deleteImageFromR2(rows[0].image_url);
    }
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.redirect('/admin/dashboard');
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
