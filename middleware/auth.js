// Roles, from most to least powerful: admin > manager > moderator
const ROLE_LABELS = {
    admin: 'Admin',
    manager: 'Manager',
    moderator: 'Moderator'
};

// Any logged-in staff member (admin, manager, or moderator)
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/admin/login');
}

// Restrict a route to specific roles, e.g. requireRole('admin', 'manager')
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.isAdmin) {
            return res.redirect('/admin/login');
        }
        if (!roles.includes(req.session.adminRole)) {
            return res.status(403).render('admin/forbidden', {
                message: 'এই কাজটি করার অনুমতি আপনার নেই।'
            });
        }
        next();
    };
}

module.exports = { requireAdmin, requireRole, ROLE_LABELS };
