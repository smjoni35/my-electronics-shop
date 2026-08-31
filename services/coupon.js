const pool = require('../db/pool');

// Validates a coupon code against the current cart subtotal. Always re-run
// this at checkout time server-side — never trust a discount amount the
// client sends, since the session only stores the *code*, not the amount.
// Returns { ok, coupon, discount, message }.
async function validateCoupon(code, subtotal) {
    if (!code || !code.trim()) {
        return { ok: false, message: 'কুপন কোড দিন।' };
    }

    const { rows } = await pool.query('SELECT * FROM coupons WHERE UPPER(code) = UPPER($1)', [code.trim()]);
    if (rows.length === 0) {
        return { ok: false, message: 'এই কুপন কোডটি সঠিক নয়।' };
    }

    const coupon = rows[0];

    if (!coupon.active) {
        return { ok: false, message: 'এই কুপনটি বর্তমানে সক্রিয় নেই।' };
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        return { ok: false, message: 'এই কুপনের মেয়াদ শেষ হয়ে গেছে।' };
    }
    if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) {
        return { ok: false, message: 'এই কুপনের ব্যবহারসীমা শেষ হয়ে গেছে।' };
    }
    if (parseFloat(coupon.min_order_amount) > 0 && subtotal < parseFloat(coupon.min_order_amount)) {
        return {
            ok: false,
            message: `এই কুপন ব্যবহার করতে ন্যূনতম ৳${parseFloat(coupon.min_order_amount).toLocaleString('en-BD')} কেনাকাটা করতে হবে।`
        };
    }

    let discount;
    if (coupon.type === 'percent') {
        discount = subtotal * (parseFloat(coupon.value) / 100);
        if (coupon.max_discount_amount != null) {
            discount = Math.min(discount, parseFloat(coupon.max_discount_amount));
        }
    } else {
        discount = parseFloat(coupon.value);
    }
    discount = Math.min(Math.round(discount * 100) / 100, subtotal);

    return { ok: true, coupon, discount, message: `কুপন প্রয়োগ হয়েছে — ৳${discount.toLocaleString('en-BD')} ছাড়!` };
}

module.exports = { validateCoupon };
