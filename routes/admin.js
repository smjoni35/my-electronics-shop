const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAdmin, requireRole, ROLE_LABELS } = require('../middleware/auth');
const { upload, uploadImageToR2, deleteImageFromR2 } = require('../middleware/r2');
const { adminLoginLimiter } = require('../middleware/rateLimit');
const { streamInvoice } = require('../services/invoice');
const { notifyLowStock } = require('../services/notify');
const { logActivity } = require('../services/activityLog');

// Matches the admin dashboard's Low Stock widget and routes/shop.js's badge —
// keep all three in sync if this ever changes.
const LOW_STOCK_THRESHOLD = 5;

// Makes req.path (relative to /admin) available to every admin view for
// sidebar active-link highlighting, without needing every render() call to pass it.
router.use((req, res, next) => {
    res.locals.adminPath = req.path;
    next();
});

// Parses the JSON that the product-form page's JS builds from the variant
// rows (color/storage/size/stock/price/sku) into a clean array. Never
// trusts field types from the client — everything is re-parsed here.
function parseVariants(variantsJson) {
    if (!variantsJson) return [];
    let arr;
    try {
        arr = JSON.parse(variantsJson);
    } catch (e) {
        return [];
    }
    if (!Array.isArray(arr)) return [];
    return arr
        .map(v => ({
            id: v.id ? parseInt(v.id, 10) : null,
            color: (v.color || '').toString().trim() || null,
            storage: (v.storage || '').toString().trim() || null,
            sizeModel: (v.sizeModel || '').toString().trim() || null,
            priceOverride: v.priceOverride !== '' && v.priceOverride != null && !isNaN(parseFloat(v.priceOverride)) ? parseFloat(v.priceOverride) : null,
            stock: parseInt(v.stock, 10) || 0,
            sku: (v.sku || '').toString().trim() || null
        }))
        .filter(v => v.color || v.storage || v.sizeModel);
}

// Inserts/updates/deletes a product's variant rows to match `variants`
// exactly (full-replace, driven by whichever ids are still present).
async function saveVariants(client, productId, variants) {
    const { rows: existing } = await client.query('SELECT id FROM product_variants WHERE product_id = $1', [productId]);
    const existingIds = existing.map(r => r.id);
    const keptIds = variants.filter(v => v.id).map(v => v.id);
    const toDelete = existingIds.filter(id => !keptIds.includes(id));

    if (toDelete.length > 0) {
        await client.query('DELETE FROM product_variants WHERE id = ANY($1::int[])', [toDelete]);
    }
    for (const v of variants) {
        if (v.id && existingIds.includes(v.id)) {
            await client.query(
                `UPDATE product_variants SET color=$1, storage=$2, size_model=$3, price_override=$4, stock=$5, sku=$6 WHERE id=$7`,
                [v.color, v.storage, v.sizeModel, v.priceOverride, v.stock, v.sku, v.id]
            );
        } else {
            await client.query(
                `INSERT INTO product_variants (product_id, color, storage, size_model, price_override, stock, sku)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [productId, v.color, v.storage, v.sizeModel, v.priceOverride, v.stock, v.sku]
            );
        }
    }
}

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

// Bare /admin — send to dashboard if already logged in, otherwise to login
router.get('/', (req, res) => {
    res.redirect(req.session && req.session.isAdmin ? '/admin/dashboard' : '/admin/login');
});

// Login page
router.get('/login', (req, res) => {
    res.render('admin/login', { error: null });
});

router.post('/login', adminLoginLimiter, async (req, res) => {
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
    logActivity(req, 'Logged in');
    res.redirect('/admin/dashboard');
});

router.post('/logout', (req, res) => {
    req.session.isAdmin = false;
    req.session.adminRole = null;
    req.session.adminUsername = null;
    res.redirect('/admin/login');
});

// Helper: percentage change between two numeric periods, formatted for the stat cards.
// Returns null when there's nothing meaningful to compare (avoids a misleading "+100%"
// the first time a store has any data at all).
function periodChange(current, previous) {
    current = Number(current) || 0;
    previous = Number(previous) || 0;
    if (previous === 0) {
        return current === 0 ? { pct: 0, dir: 'flat' } : { pct: null, dir: 'up' };
    }
    const pct = ((current - previous) / previous) * 100;
    return { pct: Math.round(pct * 10) / 10, dir: pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat') };
}

// Dashboard — analytics overview (real DB figures only, no placeholder numbers)
router.get('/dashboard', requireAdmin, async (req, res) => {
    const [
        { rows: orderStatsRows },
        { rows: productStatsRows },
        { rows: customerStatsRows },
        { rows: recentOrders },
        { rows: lowStockProducts },
        { rows: topSellingProducts }
    ] = await Promise.all([
        pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status != 'cancelled') AS total_orders,
                COUNT(*) FILTER (WHERE status != 'cancelled' AND created_at >= NOW() - INTERVAL '7 days') AS orders_last7,
                COUNT(*) FILTER (WHERE status != 'cancelled' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS orders_prev7,
                COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0) AS total_revenue,
                COALESCE(SUM(total) FILTER (WHERE status = 'delivered' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS revenue_last7,
                COALESCE(SUM(total) FILTER (WHERE status = 'delivered' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'), 0) AS revenue_prev7,
                COALESCE(SUM(total) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped')), 0) AS pending_revenue,
                COALESCE(SUM(total) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped') AND created_at >= NOW() - INTERVAL '7 days'), 0) AS pending_last7,
                COALESCE(SUM(total) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped') AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'), 0) AS pending_prev7,
                COUNT(*) AS status_total,
                COUNT(*) FILTER (WHERE status = 'pending') AS status_pending,
                COUNT(*) FILTER (WHERE status = 'confirmed') AS status_confirmed,
                COUNT(*) FILTER (WHERE status = 'shipped') AS status_shipped,
                COUNT(*) FILTER (WHERE status = 'delivered') AS status_delivered,
                COUNT(*) FILTER (WHERE status = 'cancelled') AS status_cancelled
            FROM orders
        `),
        pool.query(`
            SELECT COUNT(*) AS total_products,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS products_last7
            FROM products
        `),
        pool.query(`
            SELECT COUNT(*) AS total_customers,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS customers_last7
            FROM customers
        `),
        pool.query(`
            SELECT id, customer_name, total, payment_method, status, created_at FROM orders
            ORDER BY
                CASE status
                    WHEN 'pending' THEN 1
                    WHEN 'confirmed' THEN 2
                    WHEN 'shipped' THEN 3
                    WHEN 'delivered' THEN 4
                    WHEN 'cancelled' THEN 5
                    ELSE 6
                END,
                created_at DESC
            LIMIT 5
        `),
        pool.query(`SELECT id, name, image_url, stock, price FROM products WHERE stock <= $1 ORDER BY stock ASC, name ASC LIMIT 5`, [LOW_STOCK_THRESHOLD]),
        pool.query(`
            SELECT p.id, p.name, p.image_url, p.price, COALESCE(SUM(oi.quantity), 0) AS sold
            FROM products p
            JOIN order_items oi ON oi.product_id = p.id
            JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled'
            GROUP BY p.id
            ORDER BY sold DESC
            LIMIT 5
        `)
    ]);

    const os = orderStatsRows[0];
    const ps = productStatsRows[0];
    const cs = customerStatsRows[0];

    const stats = {
        totalOrders: Number(os.total_orders),
        ordersChange: periodChange(os.orders_last7, os.orders_prev7),
        totalRevenue: Number(os.total_revenue),
        revenueChange: periodChange(os.revenue_last7, os.revenue_prev7),
        pendingRevenue: Number(os.pending_revenue),
        pendingChange: periodChange(os.pending_last7, os.pending_prev7),
        totalProducts: Number(ps.total_products),
        productsLast7: Number(ps.products_last7),
        totalCustomers: Number(cs.total_customers),
        customersLast7: Number(cs.customers_last7)
    };

    const statusTotal = Number(os.status_total) || 0;
    const statusPct = (n) => statusTotal > 0 ? Math.round((Number(n) / statusTotal) * 1000) / 10 : 0;
    const orderStatus = {
        total: statusTotal,
        breakdown: [
            { key: 'pending', label: 'Pending', count: Number(os.status_pending), pct: statusPct(os.status_pending), color: '#ffd23f' },
            { key: 'confirmed', label: 'Confirmed', count: Number(os.status_confirmed), pct: statusPct(os.status_confirmed), color: '#29b6f6' },
            { key: 'shipped', label: 'Shipped', count: Number(os.status_shipped), pct: statusPct(os.status_shipped), color: '#b7a8ff' },
            { key: 'delivered', label: 'Delivered', count: Number(os.status_delivered), pct: statusPct(os.status_delivered), color: '#2ecc71' },
            { key: 'cancelled', label: 'Cancelled', count: Number(os.status_cancelled), pct: statusPct(os.status_cancelled), color: '#ff5470' }
        ]
    };

    res.render('admin/dashboard', {
        pageTitle: 'Dashboard',
        stats,
        orderStatus,
        recentOrders,
        lowStockProducts,
        topSellingProducts
    });
});

// Sales overview chart data (JSON), used by the dashboard's period switcher.
// All figures are computed live from the orders table — nothing hardcoded.
router.get('/api/sales-overview', requireAdmin, async (req, res) => {
    const period = ['today', 'week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'week';
    let query, params = [];

    if (period === 'today') {
        query = `
            SELECT to_char(hour_slot, 'HH24:00') AS label,
                   COALESCE(SUM(o.total) FILTER (WHERE o.id IS NOT NULL AND o.status != 'cancelled'), 0) AS sales,
                   COUNT(o.id) FILTER (WHERE o.status != 'cancelled') AS orders
            FROM generate_series(date_trunc('day', NOW()), date_trunc('day', NOW()) + INTERVAL '23 hours', INTERVAL '1 hour') AS hour_slot
            LEFT JOIN orders o ON date_trunc('hour', o.created_at) = hour_slot
            GROUP BY hour_slot ORDER BY hour_slot`;
    } else if (period === 'week') {
        query = `
            SELECT to_char(day_slot, 'DD Mon') AS label,
                   COALESCE(SUM(o.total) FILTER (WHERE o.id IS NOT NULL AND o.status != 'cancelled'), 0) AS sales,
                   COUNT(o.id) FILTER (WHERE o.status != 'cancelled') AS orders
            FROM generate_series(date_trunc('day', NOW()) - INTERVAL '6 days', date_trunc('day', NOW()), INTERVAL '1 day') AS day_slot
            LEFT JOIN orders o ON date_trunc('day', o.created_at) = day_slot
            GROUP BY day_slot ORDER BY day_slot`;
    } else if (period === 'month') {
        query = `
            SELECT to_char(day_slot, 'DD Mon') AS label,
                   COALESCE(SUM(o.total) FILTER (WHERE o.id IS NOT NULL AND o.status != 'cancelled'), 0) AS sales,
                   COUNT(o.id) FILTER (WHERE o.status != 'cancelled') AS orders
            FROM generate_series(date_trunc('month', NOW()), date_trunc('day', NOW()), INTERVAL '1 day') AS day_slot
            LEFT JOIN orders o ON date_trunc('day', o.created_at) = day_slot
            GROUP BY day_slot ORDER BY day_slot`;
    } else {
        query = `
            SELECT to_char(month_slot, 'Mon') AS label,
                   COALESCE(SUM(o.total) FILTER (WHERE o.id IS NOT NULL AND o.status != 'cancelled'), 0) AS sales,
                   COUNT(o.id) FILTER (WHERE o.status != 'cancelled') AS orders
            FROM generate_series(date_trunc('year', NOW()), date_trunc('month', NOW()), INTERVAL '1 month') AS month_slot
            LEFT JOIN orders o ON date_trunc('month', o.created_at) = month_slot
            GROUP BY month_slot ORDER BY month_slot`;
    }

    try {
        const { rows } = await pool.query(query, params);
        res.json({
            period,
            labels: rows.map(r => r.label),
            sales: rows.map(r => Number(r.sales)),
            orders: rows.map(r => Number(r.orders))
        });
    } catch (err) {
        console.error('Sales overview error:', err.message);
        res.status(500).json({ error: 'ডেটা লোড করা যায়নি' });
    }
});

// Products list (moved off the old dashboard route so /admin/dashboard can be a
// pure analytics overview, matching the sidebar's separate "Products" entry)
router.get('/products', requireAdmin, async (req, res) => {
    const { rows: products } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.render('admin/products', { pageTitle: 'Products', products, addedSuccess: req.query.added === '1' });
});

// Customers — merges registered accounts with guest checkouts (grouped by phone,
// since a guest order has no customer_id) so every real customer shows up here,
// with quick Call/WhatsApp links for marketing outreach ("নতুন প্রোডাক্ট এসেছে...").
router.get('/customers', requireAdmin, async (req, res) => {
    const { rows: customers } = await pool.query(`
        WITH order_agg AS (
            SELECT
                phone,
                (ARRAY_AGG(customer_name ORDER BY created_at DESC))[1] AS latest_name,
                COUNT(*) FILTER (WHERE status != 'cancelled') AS order_count,
                COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0) AS total_spent,
                MAX(created_at) AS last_order_at
            FROM orders
            GROUP BY phone
        )
        SELECT
            COALESCE(c.phone, oa.phone) AS phone,
            COALESCE(c.name, oa.latest_name) AS name,
            c.email,
            (c.id IS NOT NULL) AS is_registered,
            c.created_at AS registered_at,
            COALESCE(oa.order_count, 0) AS order_count,
            COALESCE(oa.total_spent, 0) AS total_spent,
            oa.last_order_at
        FROM order_agg oa
        FULL OUTER JOIN customers c ON c.phone = oa.phone
        ORDER BY COALESCE(oa.last_order_at, c.created_at) DESC
    `);
    res.render('admin/customers', { pageTitle: 'Customers', customers });
});

// New product form
router.get('/products/new', requireRole('admin', 'manager'), (req, res) => {
    res.render('admin/product-form', { product: null, galleryImages: [], variants: [], error: null });
});

const productImageUpload = upload.fields([
    { name: 'image', maxCount: 1 },     // cover photo (shown in grid/dashboard)
    { name: 'gallery', maxCount: 8 }    // extra photos for the product page gallery
]);

router.post('/products/new', requireRole('admin', 'manager'), productImageUpload, async (req, res) => {
    const client = await pool.connect();
    try {
        const { name, description, price, stock, category, warranty } = req.body;
        const discountPercent = parseInt(req.body.discountPercent, 10) || 0;
        const specs = JSON.stringify(parseSpecsText(req.body.specsText));
        const variants = parseVariants(req.body.variantsJson);
        const coverFile = req.files && req.files.image ? req.files.image[0] : null;
        const galleryFiles = (req.files && req.files.gallery) || [];
        const imageUrl = coverFile ? await uploadImageToR2(coverFile) : null;

        await client.query('BEGIN');

        const { rows } = await client.query(
            `INSERT INTO products (name, description, price, stock, category, image_url, discount_percent, warranty, specs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [name, description, price, stock, category, imageUrl, discountPercent, warranty || null, specs]
        );
        const productId = rows[0].id;

        let sortOrder = 0;
        for (const file of galleryFiles) {
            const url = await uploadImageToR2(file);
            await client.query(
                'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ($1, $2, $3)',
                [productId, url, sortOrder++]
            );
        }

        await saveVariants(client, productId, variants);

        await client.query('COMMIT');
        logActivity(req, 'Added product', name);
        res.redirect('/admin/products?added=1');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.render('admin/product-form', { product: null, galleryImages: [], variants: [], error: 'প্রোডাক্ট যোগ করা যায়নি' });
    } finally {
        client.release();
    }
});

// Edit product form
router.get('/products/:id/edit', requireAdmin, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.redirect('/admin/products');
    const { rows: galleryImages } = await pool.query(
        'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
        [req.params.id]
    );
    const { rows: variants } = await pool.query(
        'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id ASC',
        [req.params.id]
    );
    const { rows: notifyRequests } = await pool.query(
        'SELECT * FROM stock_notify_requests WHERE product_id = $1 AND notified = FALSE ORDER BY created_at ASC',
        [req.params.id]
    );
    const specsText = (rows[0].specs || []).map(s => `${s.label}: ${s.value}`).join('\n');
    res.render('admin/product-form', { product: rows[0], galleryImages, variants, notifyRequests, specsText, error: null, savedSuccess: req.query.saved === '1' });
});

router.post('/products/:id/edit', requireAdmin, productImageUpload, async (req, res) => {
    const client = await pool.connect();
    try {
        const { name, description, price, stock, category, warranty } = req.body;
        const discountPercent = parseInt(req.body.discountPercent, 10) || 0;
        const specs = JSON.stringify(parseSpecsText(req.body.specsText));
        const variants = parseVariants(req.body.variantsJson);
        const { rows } = await client.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
        if (rows.length === 0) { client.release(); return res.redirect('/admin/products'); }

        const coverFile = req.files && req.files.image ? req.files.image[0] : null;
        const galleryFiles = (req.files && req.files.gallery) || [];

        let imageUrl = rows[0].image_url;
        if (coverFile) {
            await deleteImageFromR2(imageUrl);
            imageUrl = await uploadImageToR2(coverFile);
        }

        await client.query('BEGIN');

        await client.query(
            `UPDATE products SET name=$1, description=$2, price=$3, stock=$4, category=$5, image_url=$6, discount_percent=$7, warranty=$8, specs=$9 WHERE id=$10`,
            [name, description, price, stock, category, imageUrl, discountPercent, warranty || null, specs, req.params.id]
        );

        if (galleryFiles.length > 0) {
            const { rows: countRows } = await client.query(
                'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM product_images WHERE product_id = $1',
                [req.params.id]
            );
            let sortOrder = countRows[0].max_order + 1;
            for (const file of galleryFiles) {
                const url = await uploadImageToR2(file);
                await client.query(
                    'INSERT INTO product_images (product_id, image_url, sort_order) VALUES ($1, $2, $3)',
                    [req.params.id, url, sortOrder++]
                );
            }
        }

        await saveVariants(client, req.params.id, variants);

        await client.query('COMMIT');
        logActivity(req, 'Edited product', name);

        // Same low-stock transition check as checkout — only fires the first
        // time an admin edit drops stock at/below the threshold, not every save.
        const stockBefore = Number(rows[0].stock);
        const stockAfter = Number(stock);
        if (stockBefore > LOW_STOCK_THRESHOLD && stockAfter <= LOW_STOCK_THRESHOLD) {
            notifyLowStock([{ name, stock: stockAfter }]).catch(err => console.error('notifyLowStock error:', err.message));
        }

        res.redirect('/admin/products/' + req.params.id + '/edit?saved=1');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.render('admin/product-form', { product: null, galleryImages: [], variants: [], error: 'আপডেট করা যায়নি' });
    } finally {
        client.release();
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
        logActivity(req, 'Deleted product', rows.length > 0 ? rows[0].name : ('#' + req.params.id));
        res.redirect('/admin/products');
    } catch (err) {
        console.error('Product delete error:', err.message);
        res.redirect('/admin/products');
    }
});

// Orders list — optional ?status= filter, ?q= search (order ID / customer name / phone),
// and ?page= pagination. Tab counts (statusCounts) always reflect ALL orders regardless
// of the current search/filter, so the tabs stay a stable overview.
router.get('/orders', requireAdmin, async (req, res) => {
    const VALID_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    const statusFilter = VALID_STATUSES.includes(req.query.status) ? req.query.status : null;
    const searchQuery = (req.query.q || '').trim().slice(0, 100);
    const PAGE_SIZE = 20;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const conditions = [];
    const baseParams = [];
    if (statusFilter) {
        baseParams.push(statusFilter);
        conditions.push(`status = $${baseParams.length}`);
    }
    if (searchQuery) {
        baseParams.push(`%${searchQuery}%`);
        const likeIdx = baseParams.length;
        const numericId = searchQuery.replace(/\D/g, '');
        if (numericId) {
            baseParams.push(Number(numericId));
            conditions.push(`(customer_name ILIKE $${likeIdx} OR phone ILIKE $${likeIdx} OR id = $${baseParams.length})`);
        } else {
            conditions.push(`(customer_name ILIKE $${likeIdx} OR phone ILIKE $${likeIdx})`);
        }
    }
    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const dataParams = [...baseParams, PAGE_SIZE, (page - 1) * PAGE_SIZE];
    const limitIdx = baseParams.length + 1;
    const offsetIdx = baseParams.length + 2;

    const [{ rows: orders }, { rows: countRows }, { rows: filteredCountRows }] = await Promise.all([
        pool.query(`SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, dataParams),
        pool.query(`
            SELECT
                COUNT(*) AS all_count,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
                COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
                COUNT(*) FILTER (WHERE status = 'shipped') AS shipped_count,
                COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_count,
                COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
            FROM orders
        `),
        pool.query(`SELECT COUNT(*) AS total FROM orders ${whereClause}`, baseParams)
    ]);

    const totalCount = Number(filteredCountRows[0].total);
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    res.render('admin/orders', {
        pageTitle: 'Orders',
        orders,
        statusFilter,
        statusCounts: countRows[0],
        searchQuery,
        page,
        totalPages,
        totalCount
    });
});

// Order detail
router.get('/orders/:id', requireAdmin, async (req, res) => {
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (orderRows.length === 0) return res.redirect('/admin/orders');
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    res.render('admin/order-detail', { pageTitle: 'Order #' + orderRows[0].id, order: orderRows[0], items, updatedSuccess: req.query.updated === '1' });
});

// Update order status
router.post('/orders/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
    logActivity(req, 'Updated order status', `Order #ORD-${String(req.params.id).padStart(5, '0')} → ${status}`);
    res.redirect(`/admin/orders/${req.params.id}?updated=1`);
});

// Invoice PDF for any order — staff use (e.g. printing for a delivery run)
router.get('/orders/:id/invoice', requireAdmin, async (req, res) => {
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (orderRows.length === 0) return res.redirect('/admin/orders');
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    streamInvoice(res, orderRows[0], items, {
        name: process.env.STORE_NAME || 'JM Gadget Zone',
        address: process.env.STORE_ADDRESS || '',
        phone: process.env.STORE_PHONE || '',
        email: process.env.STORE_EMAIL || ''
    }, { download: req.query.download === '1' });
});

// Delete order (also removes its order_items via ON DELETE CASCADE) —
// mainly for clearing out test/dummy orders so they don't skew dashboard stats.
router.post('/orders/:id/delete', requireRole('admin', 'manager'), async (req, res) => {
    try {
        await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
        logActivity(req, 'Deleted order', `Order #ORD-${String(req.params.id).padStart(5, '0')}`);
        res.redirect('/admin/orders');
    } catch (err) {
        console.error('Order delete error:', err.message);
        res.redirect('/admin/orders');
    }
});

// ==========================================================================
// Coupon / promo code management (admin + manager)
// ==========================================================================

router.get('/coupons', requireRole('admin', 'manager'), async (req, res) => {
    const { rows: coupons } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.render('admin/coupons', { pageTitle: 'Coupons & Discounts', coupons, addedSuccess: req.query.added === '1' });
});

router.get('/coupons/new', requireRole('admin', 'manager'), (req, res) => {
    res.render('admin/coupon-form', { pageTitle: 'Add Coupon', coupon: null, error: null });
});

router.post('/coupons/new', requireRole('admin', 'manager'), async (req, res) => {
    try {
        const coupon = readCouponForm(req.body);
        if (!coupon.code || !coupon.value) {
            return res.render('admin/coupon-form', { coupon, error: 'কোড ও ভ্যালু আবশ্যক।' });
        }
        await pool.query(
            `INSERT INTO coupons (code, type, value, min_order_amount, max_discount_amount, usage_limit, expires_at, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [coupon.code, coupon.type, coupon.value, coupon.minOrderAmount, coupon.maxDiscountAmount, coupon.usageLimit, coupon.expiresAt, coupon.active]
        );
        logActivity(req, 'Added coupon', coupon.code);
        res.redirect('/admin/coupons?added=1');
    } catch (err) {
        console.error(err);
        const message = err.code === '23505' ? 'এই কোডটি আগে থেকেই আছে।' : 'কুপন তৈরি করা যায়নি।';
        res.render('admin/coupon-form', { coupon: req.body, error: message });
    }
});

router.get('/coupons/:id/edit', requireRole('admin', 'manager'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM coupons WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.redirect('/admin/coupons');
    res.render('admin/coupon-form', { pageTitle: 'Edit Coupon', coupon: rows[0], error: null });
});

router.post('/coupons/:id/edit', requireRole('admin', 'manager'), async (req, res) => {
    try {
        const coupon = readCouponForm(req.body);
        if (!coupon.code || !coupon.value) {
            return res.render('admin/coupon-form', { coupon: { ...coupon, id: req.params.id }, error: 'কোড ও ভ্যালু আবশ্যক।' });
        }
        await pool.query(
            `UPDATE coupons SET code=$1, type=$2, value=$3, min_order_amount=$4, max_discount_amount=$5, usage_limit=$6, expires_at=$7, active=$8 WHERE id=$9`,
            [coupon.code, coupon.type, coupon.value, coupon.minOrderAmount, coupon.maxDiscountAmount, coupon.usageLimit, coupon.expiresAt, coupon.active, req.params.id]
        );
        logActivity(req, 'Edited coupon', coupon.code);
        res.redirect('/admin/coupons?added=1');
    } catch (err) {
        console.error(err);
        const message = err.code === '23505' ? 'এই কোডটি আগে থেকেই আছে।' : 'কুপন আপডেট করা যায়নি।';
        res.render('admin/coupon-form', { coupon: { ...req.body, id: req.params.id }, error: message });
    }
});

router.post('/coupons/:id/delete', requireRole('admin', 'manager'), async (req, res) => {
    const { rows } = await pool.query('SELECT code FROM coupons WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    logActivity(req, 'Deleted coupon', rows.length > 0 ? rows[0].code : ('#' + req.params.id));
    res.redirect('/admin/coupons');
});

function readCouponForm(body) {
    return {
        code: (body.code || '').trim().toUpperCase(),
        type: body.type === 'fixed' ? 'fixed' : 'percent',
        value: parseFloat(body.value) || 0,
        minOrderAmount: parseFloat(body.minOrderAmount) || 0,
        maxDiscountAmount: body.maxDiscountAmount ? parseFloat(body.maxDiscountAmount) : null,
        usageLimit: body.usageLimit ? parseInt(body.usageLimit, 10) : null,
        expiresAt: body.expiresAt ? body.expiresAt : null,
        active: body.active === 'on' || body.active === true
    };
}

// ==========================================================================
// Staff management (admin only) — create/edit/delete Manager & Moderator accounts
// ==========================================================================

router.get('/staff', requireRole('admin'), async (req, res) => {
    const { rows: staff } = await pool.query('SELECT id, username, role FROM admins ORDER BY id ASC');
    res.render('admin/staff', { pageTitle: 'Staff & Roles', staff, error: null, roleLabels: ROLE_LABELS, currentUsername: req.session.adminUsername });
});

router.get('/staff/new', requireRole('admin'), (req, res) => {
    res.render('admin/staff-form', { pageTitle: 'Add Staff', error: null, roleLabels: ROLE_LABELS });
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
        logActivity(req, 'Added staff', `${username} (${role})`);
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
    logActivity(req, 'Deleted staff', `${rows[0].username} (${rows[0].role})`);
    res.redirect('/admin/staff');
});

// Activity log — admin only. Recent staff actions (order/product/coupon/staff
// changes, logins), newest first, with simple pagination.
router.get('/activity-log', requireRole('admin'), async (req, res) => {
    const PAGE_SIZE = 50;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const [{ rows: logs }, { rows: countRows }] = await Promise.all([
        pool.query(
            'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [PAGE_SIZE, (page - 1) * PAGE_SIZE]
        ),
        pool.query('SELECT COUNT(*) AS total FROM activity_log')
    ]);

    const totalCount = Number(countRows[0].total);
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    res.render('admin/activity-log', { pageTitle: 'Activity Log', logs, page, totalPages, totalCount });
});

module.exports = router;
