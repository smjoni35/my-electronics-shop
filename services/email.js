// Sends alert emails via Gmail's free SMTP (using a Gmail App Password, not the
// normal account password). Controlled purely by .env — if EMAIL_USER or
// EMAIL_APP_PASSWORD isn't set, this silently does nothing, so it never
// breaks checkout or product-save flows even before it's configured.
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
    if (transporter) return transporter;
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) return null;
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_APP_PASSWORD
        }
    });
    return transporter;
}

// Fire-and-forget — never throws, so a slow/misconfigured mail server never
// delays checkout or a product save.
async function sendAlertEmail(subject, textBody) {
    const t = getTransporter();
    if (!t) return;

    const to = process.env.ALERT_EMAIL_TO || process.env.EMAIL_USER;
    try {
        await t.sendMail({
            from: `"${process.env.STORE_NAME || 'JM Gadget Zone'}" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            text: textBody
        });
    } catch (err) {
        console.error('Email alert failed:', err.message);
    }
}

module.exports = { sendAlertEmail };
