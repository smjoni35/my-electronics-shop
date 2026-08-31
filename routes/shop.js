const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { notifyNewOrder } = require('../services/notify');
const cartService = require('../services/cart');
const { validateCoupon } = require('../services/coupon');
const { streamInvoice } = require('../services/invoice');
const { couponLimiter, checkoutLimiter, reviewLimiter } = require('../middleware/rateLimit');

// A product counts as "New" for this many days after it's created,
// and shows a "মাত্র N টা বাকি" badge once stock drops to/below this amount.
const NEW_PRODUCT_DAYS = 14;
const LOW_STOCK_THRESHOLD = 5;
const PAGE_SIZE = 12;

const SORT_OPTIONS = {
    newest: 'p.created_at DESC',
    price_asc: 'effective_price ASC',
    price_desc: 'effective_price DESC',
};

// Shared WHERE-clause builder for the home grid and the load-more/AJAX endpoint,
// so both stay in sync (category, search, and price-range filters).
function buildProductQuery({ category, q, minPrice, maxPrice }) {
    let query = `
        SELECT p.*,
            ROUND(p.price * (1 - p.discount_percent / 100.0), 2) AS effective_price,
            COALESCE(r.avg_rating, 0) AS avg_rating,
            COALESCE(r.review_count, 0) AS review_count
        FROM products p
        LEFT JOIN (
            SELECT product_id, AVG(rating) AS avg_rating, COUNT(*) AS review_count
            FROM product_reviews GROUP BY product_id
        ) r ON r.product_id = p.id
        WHERE 1=1
    `;
    const params = [];

    if (category) {
        params.push(category);
        query += ` AND p.category = $${params.length}`;
    }
    if (q) {
        params.push(`%${q}%`);
        query += ` AND (p.name ILIKE $${params.length} OR p.category ILIKE $${params.length})`;
    }
    if (minPrice) {
        params.push(minPrice);
        query += ` AND ROUND(p.price * (1 - p.discount_percent / 100.0), 2) >= $${params.length}`;
    }
    if (maxPrice) {
        params.push(maxPrice);
        query += ` AND ROUND(p.price * (1 - p.discount_percent / 100.0), 2) <= $${params.length}`;
    }
    return { query, params };
}

// Static info page — return / exchange policy
router.get('/return-policy', (req, res) => {
    res.render('return-policy', { title: 'রিটার্ন ও এক্সচেঞ্জ পলিসি' });
});

// Static info page — frequently asked questions
router.get('/faq', (req, res) => {
    res.render('faq', { title: 'সাধারণ জিজ্ঞাসা (FAQ)' });
});

// Home page — product grid, optional category/search/price filters, sort, pagination
router.get('/', async (req, res) => {
    const { category, q } = req.query;
    const sort = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'newest';
    const minPrice = parseFloat(req.query.minPrice) || null;
    const maxPrice = parseFloat(req.query.maxPrice) || null;

    const { query, params } = buildProductQuery({ category, q, minPrice, maxPrice });
    const pagedQuery = `${query} ORDER BY ${SORT_OPTIONS[sort]} LIMIT ${PAGE_SIZE + 1} OFFSET 0`;

    const { rows: pageRows } = await pool.query(pagedQuery, params);
    const hasMore = pageRows.length > PAGE_SIZE;
    const products = pageRows.slice(0, PAGE_SIZE);

    const { rows: categories } = await pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL');

    // One representative product image per category, for the homepage category shortcut grid
    const { rows: categoryThumbRows } = await pool.query(`
        SELECT DISTINCT ON (category) category, image_url
        FROM products
        WHERE category IS NOT NULL AND image_url IS NOT NULL
        ORDER BY category, id ASC
    `);
    const categoryThumbs = {};
    categoryThumbRows.forEach(r => { categoryThumbs[r.category] = r.image_url; });

    // Overall min/max effective price across all products — used to size the price slider
    const { rows: boundsRows } = await pool.query(`
        SELECT
            COALESCE(MIN(ROUND(price * (1 - discount_percent / 100.0), 2)), 0) AS min,
            COALESCE(MAX(ROUND(price * (1 - discount_percent / 100.0), 2)), 0) AS max
        FROM products
    `);
    const priceBounds = {
        min: Math.floor(parseFloat(boundsRows[0].min) || 0),
        max: Math.ceil(parseFloat(boundsRows[0].max) || 0) || 1000
    };

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

    // Full product rows for the best sellers, used to build the homepage hero slider
    let bestSellers = [];
    if (bestSellerIds.length > 0) {
        const { rows } = await pool.query(
            `SELECT p.*, ROUND(p.price * (1 - p.discount_percent / 100.0), 2) AS effective_price
             FROM products p
             WHERE p.id = ANY($1::int[])
             ORDER BY array_position($1::int[], p.id)`,
            [bestSellerIds]
        );
        bestSellers = rows;
    }

    res.render('home', {
        products, categories, categoryThumbs, activeCategory: category || '', q: q || '', bestSellerIds, bestSellers,
        sort, NEW_PRODUCT_DAYS, LOW_STOCK_THRESHOLD, hasMore, priceBounds,
        minPrice: minPrice || '', maxPrice: maxPrice || ''
    });
});

// Load-more endpoint — returns just the extra <div class="product-card"> markup
// (same filters/sort as the page the user is on) for the homepage's "Load More" button.
router.get('/api/products/more', async (req, res) => {
    const { category, q } = req.query;
    const sort = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'newest';
    const minPrice = parseFloat(req.query.minPrice) || null;
    const maxPrice = parseFloat(req.query.maxPrice) || null;
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { query, params } = buildProductQuery({ category, q, minPrice, maxPrice });
    const pagedQuery = `${query} ORDER BY ${SORT_OPTIONS[sort]} LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
    const { rows: pageRows } = await pool.query(pagedQuery, params);
    const hasMore = pageRows.length > PAGE_SIZE;
    const products = pageRows.slice(0, PAGE_SIZE);

    const { rows: bestSellerRows } = await pool.query(`
        SELECT oi.product_id FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status != 'cancelled'
        GROUP BY oi.product_id ORDER BY SUM(oi.quantity) DESC LIMIT 3
    `);
    const bestSellerIds = bestSellerRows.map(r => r.product_id);

    res.set('X-Has-More', hasMore ? '1' : '0');
    res.set('X-Next-Offset', String(offset + products.length));
    res.render('partials/product-cards', { products, bestSellerIds, NEW_PRODUCT_DAYS, LOW_STOCK_THRESHOLD }, (err, html) => {
        if (err) { console.error(err); return res.status(500).send(''); }
        res.send(html);
    });
});

// Product detail page
router.get('/product/:id', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT *, ROUND(price * (1 - discount_percent / 100.0), 2) AS effective_price
         FROM products WHERE id = $1`,
        [req.params.id]
    );
    if (rows.length === 0) return res.status(404).render('404');
    const { rows: galleryImages } = await pool.query(
        'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
        [req.params.id]
    );
    const { rows: variants } = await pool.query(
        'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id ASC',
        [req.params.id]
    );
    const { rows: reviews } = await pool.query(
        'SELECT * FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC',
        [req.params.id]
    );
    const { rows: ratingRows } = await pool.query(
        'SELECT AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM product_reviews WHERE product_id = $1',
        [req.params.id]
    );

    const product = rows[0];
    const storeName = process.env.STORE_NAME || 'JM Gadget Zone';
    const plainDescription = (product.description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    // Variant dropdown options with the effective (discounted) price + stock baked in
    const variantOptions = variants.map(v => ({
        id: v.id,
        label: cartService.variantLabel(v),
        price: cartService.effectiveUnitPrice(product, v),
        stock: v.stock
    }));

    const inStock = variantOptions.length > 0 ? variantOptions.some(v => v.stock > 0) : product.stock > 0;

    res.render('product', {
        product, galleryImages, reviews, variantOptions, inStock,
        basePrice: cartService.effectiveUnitPrice(product, null),
        avgRating: parseFloat(ratingRows[0].avg_rating) || 0,
        reviewCount: parseInt(ratingRows[0].review_count, 10) || 0,
        reviewError: null,
        rateLimited: req.query.rateLimited === '1',
        notifyMeSuccess: req.query.notified === '1',
        NEW_PRODUCT_DAYS, LOW_STOCK_THRESHOLD,
        // SEO / social share preview tags
        title: `${product.name} - ${storeName}`,
        ogTitle: product.name,
        ogDescription: plainDescription || `${product.name} — ${storeName}-তে অর্ডার করুন। ক্যাশ অন ডেলিভারি উপলব্ধ।`,
        ogImage: product.image_url || `${baseUrl}/img/logo.png`,
        ogUrl: `${baseUrl}/product/${product.id}`,
        ogType: 'product'
    });
});

// "Notify me when back in stock" — stores the phone number against the product.
// No automatic message is sent (that needs a paid SMS/WhatsApp API); staff see
// the list of numbers in the admin product-edit page and message people manually.
router.post('/product/:id/notify-me', async (req, res) => {
    const { phone } = req.body;
    if (phone && phone.trim()) {
        await pool.query(
            'INSERT INTO stock_notify_requests (product_id, phone) VALUES ($1, $2)',
            [req.params.id, phone.trim()]
        );
    }
    res.redirect('/product/' + req.params.id + '?notified=1#notify-me');
});

// Submit a product review (no login needed — name + star rating + optional comment)
router.post('/product/:id/review', reviewLimiter, async (req, res) => {
    const { customerName, comment, phone } = req.body;
    const rating = parseInt(req.body.rating, 10);

    const { rows } = await pool.query(
        `SELECT *, ROUND(price * (1 - discount_percent / 100.0), 2) AS effective_price
         FROM products WHERE id = $1`,
        [req.params.id]
    );
    if (rows.length === 0) return res.status(404).render('404');

    if (!customerName || !rating || rating < 1 || rating > 5) {
        const { rows: galleryImages } = await pool.query(
            'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
            [req.params.id]
        );
        const { rows: variants } = await pool.query(
            'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id ASC',
            [req.params.id]
        );
        const { rows: reviews } = await pool.query(
            'SELECT * FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC',
            [req.params.id]
        );
        const { rows: ratingRows } = await pool.query(
            'SELECT AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM product_reviews WHERE product_id = $1',
            [req.params.id]
        );
        const storeName = process.env.STORE_NAME || 'JM Gadget Zone';
        const variantOptions = variants.map(v => ({
            id: v.id,
            label: cartService.variantLabel(v),
            price: cartService.effectiveUnitPrice(rows[0], v),
            stock: v.stock
        }));
        const inStock = variantOptions.length > 0 ? variantOptions.some(v => v.stock > 0) : rows[0].stock > 0;
        return res.render('product', {
            product: rows[0], galleryImages, reviews, variantOptions, inStock,
            basePrice: cartService.effectiveUnitPrice(rows[0], null),
            avgRating: parseFloat(ratingRows[0].avg_rating) || 0,
            reviewCount: parseInt(ratingRows[0].review_count, 10) || 0,
            reviewError: 'নাম ও রেটিং (১-৫) দিতে হবে / Name and a 1-5 rating are required',
            rateLimited: false,
            notifyMeSuccess: false,
            NEW_PRODUCT_DAYS, LOW_STOCK_THRESHOLD,
            title: `${rows[0].name} - ${storeName}`,
            ogTitle: rows[0].name, ogDescription: '', ogImage: rows[0].image_url || '', ogUrl: '', ogType: 'product'
        });
    }

    // Verified purchase: matches if this phone has a non-cancelled order that included this product
    let verifiedPurchase = false;
    if (phone) {
        const { rows: purchaseCheck } = await pool.query(
            `SELECT 1 FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             WHERE o.phone = $1 AND oi.product_id = $2 AND o.status != 'cancelled'
             LIMIT 1`,
            [phone.trim(), req.params.id]
        );
        verifiedPurchase = purchaseCheck.length > 0;
    }

    await pool.query(
        'INSERT INTO product_reviews (product_id, customer_name, rating, comment, phone, verified_purchase) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.params.id, customerName, rating, comment || null, phone ? phone.trim() : null, verifiedPurchase]
    );
    res.redirect('/product/' + req.params.id + '#reviews');
});

// Add to cart (session-based cart). variantId is '' / '0' for a plain
// product with no variants; otherwise it must be a real product_variants.id
// belonging to this product (checked against the DB, never trusted as-is).
router.post('/cart/add', async (req, res) => {
    const { productId, variantId, quantity } = req.body;
    if (!req.session.cart) req.session.cart = {};

    const pid = parseInt(productId, 10);
    const vid = parseInt(variantId, 10) || 0;
    const qty = parseInt(quantity, 10) || 1;

    if (vid) {
        const { rows } = await pool.query('SELECT id FROM product_variants WHERE id = $1 AND product_id = $2', [vid, pid]);
        if (rows.length === 0) {
            if (req.get('X-Requested-With') === 'fetch') return res.status(400).json({ ok: false, message: 'ভুল ভ্যারিয়েন্ট নির্বাচন।' });
            return res.redirect('back');
        }
    }

    const key = cartService.cartKey(pid, vid);
    req.session.cart[key] = (req.session.cart[key] || 0) + qty;

    // AJAX request (from the product page's fetch-based add-to-cart) — return
    // the updated cart as JSON so the front-end can open the drawer instantly
    // instead of doing a full page redirect.
    if (req.get('X-Requested-With') === 'fetch') {
        const { items, subtotal } = await cartService.getCartItems(req.session);
        const count = Object.values(req.session.cart).reduce((a, b) => a + b, 0);
        return res.json({ ok: true, items, total: subtotal, count });
    }

    res.redirect('back');
});

// View cart
router.get('/cart', async (req, res) => {
    const { items, subtotal } = await cartService.getCartItems(req.session);
    res.render('cart', { items, total: subtotal });
});

// Update cart quantity
router.post('/cart/update', async (req, res) => {
    const { productId, variantId, quantity } = req.body;
    if (!req.session.cart) req.session.cart = {};
    const key = cartService.cartKey(parseInt(productId, 10), parseInt(variantId, 10) || 0);
    const qty = parseInt(quantity, 10);

    if (qty <= 0) {
        delete req.session.cart[key];
    } else {
        req.session.cart[key] = qty;
    }
    res.redirect('/cart');
});

// Remove from cart
router.post('/cart/remove', (req, res) => {
    const { productId, variantId } = req.body;
    if (req.session.cart) delete req.session.cart[cartService.cartKey(parseInt(productId, 10), parseInt(variantId, 10) || 0)];
    res.redirect('/cart');
});

// Validate + apply a coupon code to the cart currently in session (AJAX).
// Only the coupon *code* is stored in session — the discount amount is
// always recalculated from the DB, both here and again at checkout, so a
// tampered client-side value can never change what's actually charged.
router.post('/coupon/apply', couponLimiter, async (req, res) => {
    const { subtotal } = await cartService.getCartItems(req.session);
    const result = await validateCoupon(req.body.code, subtotal);
    if (!result.ok) {
        delete req.session.couponCode;
        return res.json({ ok: false, message: result.message });
    }
    req.session.couponCode = result.coupon.code;
    res.json({ ok: true, message: result.message, discount: result.discount, code: result.coupon.code });
});

router.post('/coupon/remove', (req, res) => {
    delete req.session.couponCode;
    res.json({ ok: true });
});

// Checkout page
router.get('/checkout', async (req, res) => {
    const { items, subtotal } = await cartService.getCartItems(req.session);
    if (items.length === 0) return res.redirect('/cart');

    let coupon = null;
    if (req.session.couponCode) {
        const result = await validateCoupon(req.session.couponCode, subtotal);
        if (result.ok) {
            coupon = { code: result.coupon.code, discount: result.discount };
        } else {
            delete req.session.couponCode;
        }
    }

    res.render('checkout', {
        error: null, items, subtotal, coupon,
        customerName: req.session.customerName || '', customerPhone: ''
    });
});

// Place order (Cash on Delivery). Everything money-related (subtotal,
// coupon discount, delivery charge) is recalculated here from the DB —
// nothing about price ever comes from the submitted form.
router.post('/checkout', checkoutLimiter, async (req, res) => {
    const { items, subtotal } = await cartService.getCartItems(req.session);
    if (items.length === 0) return res.redirect('/cart');

    const { customerName, phone, address, city } = req.body;
    if (!customerName || !phone || !address || !city || !city.trim()) {
        return res.render('checkout', { error: 'সব ফিল্ড পূরণ করুন — City আবশ্যক / Please fill all fields, City is required', items, subtotal, coupon: null, customerName: customerName || '', customerPhone: phone || '' });
    }

    // Re-check stock right before committing (cartService already clamps
    // quantities against current stock, but a race is still possible)
    for (const item of items) {
        if (item.quantity > item.stock) {
            return res.render('checkout', { error: `দুঃখিত, "${item.name}" এর জন্য পর্যাপ্ত স্টক নেই।`, items, subtotal, coupon: null, customerName, customerPhone: phone });
        }
    }

    let discountAmount = 0;
    let couponCode = null;
    let couponRow = null;
    if (req.session.couponCode) {
        const result = await validateCoupon(req.session.couponCode, subtotal);
        if (result.ok) {
            discountAmount = result.discount;
            couponCode = result.coupon.code;
            couponRow = result.coupon;
        }
    }

    const deliveryCharge = cartService.calculateDeliveryCharge(city);
    const total = Math.round((subtotal - discountAmount + deliveryCharge) * 100) / 100;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orderResult = await client.query(
            `INSERT INTO orders (customer_name, phone, address, city, total, payment_method, customer_id, subtotal, discount_amount, delivery_charge, coupon_code)
             VALUES ($1, $2, $3, $4, $5, 'cod', $6, $7, $8, $9, $10) RETURNING id`,
            [customerName, phone, address, city || '', total, req.session.customerId || null, subtotal, discountAmount, deliveryCharge, couponCode]
        );
        const orderId = orderResult.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, variant_id, variant_label)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [orderId, item.productId, item.name, item.quantity, item.price, item.variantId, item.variantLabel]
            );
            if (item.variantId) {
                await client.query('UPDATE product_variants SET stock = GREATEST(stock - $1, 0) WHERE id = $2', [item.quantity, item.variantId]);
            } else {
                await client.query('UPDATE products SET stock = GREATEST(stock - $1, 0) WHERE id = $2', [item.quantity, item.productId]);
            }
        }

        if (couponRow) {
            await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponRow.id]);
        }

        await client.query('COMMIT');
        req.session.cart = {};
        delete req.session.couponCode;

        // Notify the shop owner (Email/WhatsApp). Fire-and-forget so a slow
        // or misconfigured notification never delays the customer's page.
        const orderForNotify = { id: orderId, customer_name: customerName, phone, address, city: city || '', total };
        const itemsForNotify = items.map(i => ({ product_name: i.name, quantity: i.quantity, price: i.price }));
        notifyNewOrder(orderForNotify, itemsForNotify).catch(err => console.error('notifyNewOrder error:', err.message));

        res.render('order-success', { orderId, total, phone });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.render('checkout', { error: 'অর্ডার সম্পন্ন করা যায়নি, আবার চেষ্টা করুন / Order failed, please try again', items, subtotal, coupon: null, customerName, customerPhone: phone });
    } finally {
        client.release();
    }
});

// Guest invoice download — by order id + phone match (no login needed),
// mirrors the existing phone-based order tracking.
router.get('/order/:id/invoice', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(404).render('404');
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND phone = $2', [req.params.id, phone]);
    if (orderRows.length === 0) return res.status(404).render('404');
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    streamInvoice(res, orderRows[0], items, {
        name: process.env.STORE_NAME || 'JM Gadget Zone',
        address: process.env.STORE_ADDRESS || '',
        phone: process.env.STORE_PHONE || '',
        email: process.env.STORE_EMAIL || ''
    });
});

// Order tracking — look up past orders by phone number, no account needed
router.get('/track-order', (req, res) => {
    res.render('track-order', { phone: '', orders: null, orderItemsById: {} });
});

router.post('/track-order', async (req, res) => {
    const phone = (req.body.phone || '').trim();
    if (!phone) {
        return res.render('track-order', { phone: '', orders: null, orderItemsById: {} });
    }

    const { rows: orders } = await pool.query(
        'SELECT * FROM orders WHERE phone = $1 ORDER BY created_at DESC',
        [phone]
    );

    const orderItemsById = {};
    for (const order of orders) {
        const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
        orderItemsById[order.id] = items;
    }

    res.render('track-order', { phone, orders, orderItemsById });
});

module.exports = router;
