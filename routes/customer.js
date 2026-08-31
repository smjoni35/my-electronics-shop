const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireCustomer } = require('../middleware/customerAuth');
const { customerLoginLimiter, customerRegisterLimiter } = require('../middleware/rateLimit');
const { streamInvoice } = require('../services/invoice');

// ---- Register ----
router.get('/register', (req, res) => {
    if (req.session.customerId) return res.redirect('/account/dashboard');
    res.render('account/register', { error: null, name: '', phone: '', email: '' });
});

router.post('/register', customerRegisterLimiter, async (req, res) => {
    const { name, phone, email, password, confirmPassword } = req.body;
    const cleanPhone = (phone || '').trim();

    if (!name || !cleanPhone || !password) {
        return res.render('account/register', { error: 'নাম, ফোন নম্বর ও পাসওয়ার্ড আবশ্যক।', name, phone, email });
    }
    if (password.length < 6) {
        return res.render('account/register', { error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।', name, phone, email });
    }
    if (password !== confirmPassword) {
        return res.render('account/register', { error: 'দুটি পাসওয়ার্ড মিলছে না।', name, phone, email });
    }

    try {
        const existing = await pool.query('SELECT id FROM customers WHERE phone = $1', [cleanPhone]);
        if (existing.rows.length > 0) {
            return res.render('account/register', { error: 'এই ফোন নম্বর দিয়ে আগে থেকেই একটি অ্যাকাউন্ট আছে। লগইন করুন।', name, phone, email });
        }

        const hash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            'INSERT INTO customers (name, phone, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name',
            [name.trim(), cleanPhone, (email || '').trim() || null, hash]
        );

        req.session.customerId = rows[0].id;
        req.session.customerName = rows[0].name;
        res.redirect('/account/dashboard');
    } catch (err) {
        console.error('Customer register error:', err.message);
        res.render('account/register', { error: 'অ্যাকাউন্ট তৈরি করা যায়নি, আবার চেষ্টা করুন।', name, phone, email });
    }
});

// ---- Login ----
router.get('/login', (req, res) => {
    if (req.session.customerId) return res.redirect('/account/dashboard');
    res.render('account/login', { error: null, next: req.query.next || '' });
});

router.post('/login', customerLoginLimiter, async (req, res) => {
    const { phone, password, next } = req.body;
    const cleanPhone = (phone || '').trim();

    const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1', [cleanPhone]);
    if (rows.length === 0) {
        return res.render('account/login', { error: 'ভুল ফোন নম্বর বা পাসওয়ার্ড।', next: next || '' });
    }

    const match = await bcrypt.compare(password || '', rows[0].password_hash);
    if (!match) {
        return res.render('account/login', { error: 'ভুল ফোন নম্বর বা পাসওয়ার্ড।', next: next || '' });
    }

    req.session.customerId = rows[0].id;
    req.session.customerName = rows[0].name;

    // Only allow redirecting back to a same-site path, never an external URL
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/account/dashboard';
    res.redirect(safeNext);
});

router.post('/logout', (req, res) => {
    req.session.customerId = null;
    req.session.customerName = null;
    res.redirect('/');
});

// ---- Dashboard ----
router.get('/dashboard', requireCustomer, async (req, res) => {
    const customerId = req.session.customerId;

    const { rows: statsRows } = await pool.query(`
        SELECT
            COUNT(*) AS total_orders,
            COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0) AS total_spent,
            COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_count,
            COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
            COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped')) AS pending_count
        FROM orders WHERE customer_id = $1
    `, [customerId]);

    const { rows: orders } = await pool.query(
        'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
        [customerId]
    );

    const orderItemsById = {};
    for (const order of orders) {
        const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        orderItemsById[order.id] = items;
    }

    res.render('account/dashboard', { stats: statsRows[0], orders, orderItemsById });
});

// ---- Invoice PDF (own orders only) ----
router.get('/orders/:id/invoice', requireCustomer, async (req, res) => {
    const { rows: orderRows } = await pool.query(
        'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
        [req.params.id, req.session.customerId]
    );
    if (orderRows.length === 0) return res.status(404).render('404');

    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);

    streamInvoice(res, orderRows[0], items, {
        name: process.env.STORE_NAME || 'JM Gadget Zone',
        address: process.env.STORE_ADDRESS || '',
        phone: process.env.STORE_PHONE || '',
        email: process.env.STORE_EMAIL || ''
    });
});

module.exports = router;
