const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { mapStatus } = require('../services/courier/steadfast');
const { logActivity } = require('../services/activityLog');

// Steadfast calls this URL whenever a consignment's delivery status changes.
// In the Steadfast merchant panel → Webhook settings, set:
//   Callback URL:        https://yourdomain.com/webhooks/steadfast
//   Auth Token (Bearer):  <STEADFAST_WEBHOOK_TOKEN> (same value as in .env)
// Steadfast sends that token back as "Authorization: Bearer <token>" on every
// call — that's what stops random internet traffic from spoofing order-status
// changes, since Steadfast doesn't sign its webhook payloads otherwise.
router.post('/steadfast', async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const sentToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!process.env.STEADFAST_WEBHOOK_TOKEN || sentToken !== process.env.STEADFAST_WEBHOOK_TOKEN) {
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
