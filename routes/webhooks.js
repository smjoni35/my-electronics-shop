const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { mapStatus } = require('../services/courier/steadfast');
const { logActivity } = require('../services/activityLog');

// Steadfast calls this URL whenever a consignment's delivery status changes.
// Set it as the "Notification URL" in the Steadfast merchant panel as:
//   https://yourdomain.com/webhooks/steadfast/<STEADFAST_WEBHOOK_TOKEN>
// The token in the path is a shared secret — Steadfast doesn't sign its
// webhook payloads, so this is what stops random internet traffic from
// spoofing order-status changes. Pick any long random string and put the
// same value in .env as STEADFAST_WEBHOOK_TOKEN.
router.post('/steadfast/:token', async (req, res) => {
    if (!process.env.STEADFAST_WEBHOOK_TOKEN || req.params.token !== process.env.STEADFAST_WEBHOOK_TOKEN) {
        return res.status(403).json({ ok: false });
    }

    const { consignment_id, status } = req.body || {};
    if (!consignment_id || !status) {
        return res.status(400).json({ ok: false, message: 'consignment_id ও status আবশ্যক' });
    }

    try {
        const newStatus = mapStatus(status);
        const { rows } = await pool.query(
            `UPDATE orders SET courier_status = $1, status = $2
             WHERE courier_consignment_id = $3
             RETURNING id`,
            [status, newStatus, String(consignment_id)]
        );
        if (rows.length > 0) {
            logActivity(req, 'Courier status update', `Order #ORD-${String(rows[0].id).padStart(5, '0')} → ${status}`);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('Steadfast webhook error:', err.message);
        res.status(500).json({ ok: false });
    }
});

module.exports = router;
