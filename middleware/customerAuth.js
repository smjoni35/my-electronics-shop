// Guards routes that require a logged-in customer (separate from admin/staff auth).
function requireCustomer(req, res, next) {
    if (req.session && req.session.customerId) {
        return next();
    }
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl));
}

module.exports = { requireCustomer };
