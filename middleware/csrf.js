const crypto = require('crypto');

// Synchronizer-token CSRF protection, built on the session we already have
// (express-session + connect-pg-simple) — no extra package/store needed.
//
// Flow: every session gets one random token. Every page render exposes it as
// res.locals.csrfToken (views put it in a hidden <input name="_csrf"> on
// every form, or read it from the <meta name="csrf-token"> tag for fetch/AJAX
// calls). Every state-changing request must send that same token back,
// either as body._csrf or as an X-CSRF-Token header — otherwise it's rejected.

// Attach (or reuse) a per-session token, and expose it to every view.
// Runs on every request, after the session middleware.
function attachCsrfToken(req, res, next) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
    next();
}

// Verifies the token on state-changing requests (POST/PUT/PATCH/DELETE).
// Use this directly on routes whose body isn't parsed yet at the point the
// global check would normally run (e.g. multipart/form-data routes, where
// multer parses the body inside the route's own middleware chain).
function verifyCsrfToken(req, res, next) {
    const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
    const expected = req.session && req.session.csrfToken;
    const isJsonOrAjax = req.xhr || (req.get('Content-Type') || '').includes('application/json');

    if (!expected || !sent || sent !== expected) {
        const message = 'ফর্মের মেয়াদ শেষ হয়ে গেছে বা অবৈধ অনুরোধ — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।';
        if (isJsonOrAjax) {
            return res.status(403).json({ ok: false, message });
        }
        return res.status(403).send(message);
    }
    next();
}

// Global gate: applies verifyCsrfToken to every state-changing request,
// EXCEPT multipart/form-data ones — those haven't been body-parsed yet at
// this point in the middleware chain (multer runs later, per-route), so
// those routes call verifyCsrfToken themselves right after their multer
// middleware instead.
function csrfGate(req, res, next) {
    const STATE_CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!STATE_CHANGING.includes(req.method)) return next();
    const contentType = req.headers['content-type'] || '';
    if (contentType.startsWith('multipart/form-data')) return next();
    return verifyCsrfToken(req, res, next);
}

module.exports = { attachCsrfToken, verifyCsrfToken, csrfGate };
