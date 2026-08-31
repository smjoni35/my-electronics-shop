const pool = require('../db/pool');

// Cart is stored in the session as { "productId_variantId": quantity }.
// variantId is 0 when the product has no variant selected (plain product).
function cartKey(productId, variantId) {
    return `${productId}_${variantId || 0}`;
}

function parseCartKey(key) {
    const [productId, variantId] = key.split('_').map(Number);
    return { productId, variantId: variantId || null };
}

// Builds a human-readable label from whichever variant attributes are set,
// e.g. "Black / 128GB" — used in the cart, checkout, order emails and invoice.
function variantLabel(variant) {
    if (!variant) return null;
    return [variant.color, variant.storage, variant.size_model].filter(Boolean).join(' / ') || null;
}

// The price actually charged for a line: the variant's own price if it has
// one, otherwise the product's price — with the product's discount_percent
// applied either way, so a discount campaign covers every variant too.
function effectiveUnitPrice(product, variant) {
    const base = variant && variant.price_override != null ? parseFloat(variant.price_override) : parseFloat(product.price);
    return Math.round(base * (1 - (product.discount_percent || 0) / 100) * 100) / 100;
}

// Reads req.session.cart and resolves it against the DB into full line items
// + a subtotal. Silently drops lines whose product/variant no longer exists.
async function getCartItems(session) {
    const cart = session.cart || {};
    const keys = Object.keys(cart);
    if (keys.length === 0) return { items: [], subtotal: 0 };

    const parsed = keys.map(k => ({ key: k, ...parseCartKey(k), quantity: cart[k] }));
    const productIds = [...new Set(parsed.map(p => p.productId))];
    const variantIds = [...new Set(parsed.map(p => p.variantId).filter(Boolean))];

    const { rows: products } = await pool.query('SELECT * FROM products WHERE id = ANY($1::int[])', [productIds]);
    const productsById = {};
    products.forEach(p => { productsById[p.id] = p; });

    let variantsById = {};
    if (variantIds.length > 0) {
        const { rows: variants } = await pool.query('SELECT * FROM product_variants WHERE id = ANY($1::int[])', [variantIds]);
        variants.forEach(v => { variantsById[v.id] = v; });
    }

    const items = [];
    let subtotal = 0;
    let changed = false;

    for (const line of parsed) {
        const product = productsById[line.productId];
        const variant = line.variantId ? variantsById[line.variantId] : null;
        if (!product || (line.variantId && !variant)) {
            delete session.cart[line.key];
            changed = true;
            continue;
        }
        const stock = variant ? variant.stock : product.stock;
        const quantity = Math.min(line.quantity, Math.max(stock, 0)) || line.quantity;
        if (quantity !== line.quantity) {
            session.cart[line.key] = quantity;
            changed = true;
        }
        const unitPrice = effectiveUnitPrice(product, variant);
        const itemSubtotal = Math.round(unitPrice * quantity * 100) / 100;
        subtotal += itemSubtotal;

        items.push({
            key: line.key,
            productId: product.id,
            variantId: variant ? variant.id : null,
            name: product.name,
            image_url: product.image_url,
            variantLabel: variantLabel(variant),
            price: unitPrice,
            stock,
            quantity,
            subtotal: itemSubtotal
        });
    }

    return { items, subtotal: Math.round(subtotal * 100) / 100, changed };
}

// Flat delivery charge — inside vs outside Dhaka, configurable via .env so
// the shop owner can change rates without touching code.
function calculateDeliveryCharge(city) {
    const insideDhaka = /dhaka|ঢাকা/i.test((city || '').trim());
    const inside = parseFloat(process.env.DELIVERY_CHARGE_DHAKA) || 70;
    const outside = parseFloat(process.env.DELIVERY_CHARGE_OUTSIDE) || 130;
    return insideDhaka ? inside : outside;
}

module.exports = { cartKey, parseCartKey, variantLabel, effectiveUnitPrice, getCartItems, calculateDeliveryCharge };
