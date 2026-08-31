// Rate limiting for sensitive endpoints — login, register, checkout, coupon
// validation. Uses express-rate-limit (in-memory store, no external/paid
// service needed). Limits are per IP address.
const rateLimit = require('express-rate-limit');

// Renders back to a normal HTML page (login/register/checkout forms) with
// a Bangla error message, instead of an ugly plain-text 429.
function formLimiter({ windowMs, max, view, extraLocals = () => ({}) }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            res.status(429).render(view, {
                error: 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।',
                ...extraLocals(req)
            });
        }
    });
}

// Returns JSON 429 — for AJAX/API-style endpoints (coupon validation).
function jsonLimiter({ windowMs, max }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            res.status(429).json({ ok: false, message: 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' });
        }
    });
}

// Customer login: 10 attempts / 15 minutes per IP
const customerLoginLimiter = formLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    view: 'account/login',
    extraLocals: (req) => ({ next: req.query.next || req.body.next || '' })
});

// Customer registration: 8 accounts / hour per IP
const customerRegisterLimiter = formLimiter({
    windowMs: 60 * 60 * 1000,
    max: 8,
    view: 'account/register'
});

// Admin/staff login: 10 attempts / 15 minutes per IP
const adminLoginLimiter = formLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    view: 'admin/login'
});

// Coupon code validation: 20 tries / 10 minutes per IP (guards against
// brute-forcing coupon codes)
const couponLimiter = jsonLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20
});

// Checkout/order placement: 15 orders / 15 minutes per IP (guards against
// automated order spam / stock-draining scripts)
const checkoutLimiter = formLimiter({
    windowMs: 15 * 60 * 1000,
    max: 15,
    view: 'checkout',
    extraLocals: () => ({})
});

// Product review submission: 12 / 10 minutes per IP — redirects back to the
// product page (review form is a normal POST, not AJAX) with a flag the
// product page reads to show a Bangla rate-limit notice.
const reviewLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.redirect('/product/' + req.params.id + '?rateLimited=1#reviews');
    }
});

module.exports = {
    customerLoginLimiter,
    customerRegisterLimiter,
    adminLoginLimiter,
    couponLimiter,
    checkoutLimiter,
    reviewLimiter
};
