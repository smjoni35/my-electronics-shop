const pool = require('../db/pool');

// Records one line in activity_log. Never throws — a logging failure should
// never break the actual action (order update, product save, etc.) that
// triggered it, so callers can just call this without awaiting/catching.
async function logActivity(req, action, details) {
    try {
        const username = (req.session && req.session.adminUsername) || 'unknown';
        const role = (req.session && req.session.adminRole) || null;
        await pool.query(
            'INSERT INTO activity_log (staff_username, staff_role, action, details) VALUES ($1, $2, $3, $4)',
            [username, role, action, details || null]
        );
    } catch (err) {
        console.error('Activity log failed:', err.message);
    }
}

module.exports = { logActivity };
