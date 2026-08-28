const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { notifyNewOrder } = require('../services/notify');

// Home page — product grid, optional category filter
router.get('/', async (req, res) => {
    const { category, q } = req.query;
    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (category) {
        params.push(category);
        query += ` AND category = $${params.length}`;
    }
    if (q) {
        params.push(`%${q}%`);
        query += ` AND name ILIKE $${params.length}`;
    }
    query += ' ORDER BY created_at DESC';

    const { rows: products } = await pool.query(query, params);
    const { rows: categories } = await pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL');

    // Top 3 best-selling product ids, used to show a "Best Seller" badge in the grid
    const { rows: bestSellerRows } = await pool.query(`
        SELECT oi.product_id
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status != 'cancelled'
        GROUP BY oi.product_id
        ORDER BY SUM(oi.quantity) DESC
        LIMIT 3
    `);
    const bestSellerIds = bestSellerRows.map(r => r.product_id);

    res.render('home', { products, categories, activeCategory: category || '', q: q || '', bestSellerIds });
});

// Product detail page
router.get('/product/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).render('404');
    const { rows: galleryImages } = await pool.query(
        'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
        [req.params.id]
    );
    res.render('product', { product: rows[0], galleryImages });
});

// Add to cart (session-based cart)
router.post('/cart/add', async (req, res) => {
    const { productId, quantity } = req.body;
    if (!req.session.cart) req.session.cart = {};

    const qty = parseInt(quantity) || 1;
    req.session.cart[productId] = (req.session.cart[productId] || 0) + qty;

    res.redirect('back');
});

// View cart
router.get('/cart', async (req, res) => {
    const cart = req.session.cart || {};
    const ids = Object.keys(cart);
    let items = [];
    let total = 0;

    if (ids.length > 0) {
        const { rows } = await pool.query('SELECT * FROM products WHERE id = ANY($1::int[])', [ids]);
        items = rows.map(p => {
            const quantity = cart[p.id];
            const subtotal = quantity * parseFloat(p.price);
            total += subtotal;
            return { ...p, quantity, subtotal };
        });
    }

    res.render('cart', { items, total });
});

// Update cart quantity
router.post('/cart/update', (req, res) => {
    const { productId, quantity } = req.body;
    if (!req.session.cart) req.session.cart = {};
    const qty = parseInt(quantity);

    if (qty <= 0) {
        delete req.session.cart[productId];
    } else {
        req.session.cart[productId] = qty;
    }
    res.redirect('/cart');
});

// Remove from cart
router.post('/cart/remove', (req, res) => {
    const { productId } = req.body;
    if (req.session.cart) delete req.session.cart[productId];
    res.redirect('/cart');
});

// Checkout page
router.get('/checkout', (req, res) => {
    const cart = req.session.cart || {};
    if (Object.keys(cart).length === 0) return res.redirect('/cart');
    res.render('checkout', { error: null });
});

// Place order (Cash on Delivery)
router.post('/checkout', async (req, res) => {
    const cart = req.session.cart || {};
    const ids = Object.keys(cart);
    if (ids.length === 0) return res.redirect('/cart');

    const { customerName, phone, address, city } = req.body;
    if (!customerName || !phone || !address) {
        return res.render('checkout', { error: 'সব ফিল্ড পূরণ করুন / Please fill all fields' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: products } = await client.query('SELECT * FROM products WHERE id = ANY($1::int[])', [ids]);
        let total = 0;
        const orderItems = products.map(p => {
            const quantity = cart[p.id];
            total += quantity * parseFloat(p.price);
            return { product: p, quantity };
        });

        const orderResult = await client.query(
            `INSERT INTO orders (customer_name, phone, address, city, total, payment_method)
             VALUES ($1, $2, $3, $4, $5, 'cod') RETURNING id`,
            [customerName, phone, address, city || '', total]
        );
        const orderId = orderResult.rows[0].id;

        for (const item of orderItems) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_name, quantity, price)
                 VALUES ($1, $2, $3, $4, $5)`,
                [orderId, item.product.id, item.product.name, item.quantity, item.product.price]
            );
            await client.query('UPDATE products SET stock = GREATEST(stock - $1, 0) WHERE id = $2', [item.quantity, item.product.id]);
        }

        await client.query('COMMIT');
        req.session.cart = {};

        // Notify the shop owner (Email/WhatsApp). Fire-and-forget so a slow
        // or misconfigured notification never delays the customer's page.
        const orderForNotify = { id: orderId, customer_name: customerName, phone, address, city: city || '', total };
        const itemsForNotify = orderItems.map(i => ({ product_name: i.product.name, quantity: i.quantity, price: i.product.price }));
        notifyNewOrder(orderForNotify, itemsForNotify).catch(err => console.error('notifyNewOrder error:', err.message));

        res.render('order-success', { orderId, total });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.render('checkout', { error: 'অর্ডার সম্পন্ন করা যায়নি, আবার চেষ্টা করুন / Order failed, please try again' });
    } finally {
        client.release();
    }
});

module.exports = router;
