// Sends alerts to the shop owner — new orders, and low-stock warnings.
// Two channels, both free, both optional and independent of each other:
//   1. WhatsApp via the free CallMeBot API (see setup note below)
//   2. Email via Gmail SMTP (see services/email.js)
// Whichever channel(s) are configured in .env will fire; an unconfigured
// channel silently does nothing, so this never blocks checkout or a product
// save even before either is set up.
const https = require('https');
const { sendAlertEmail } = require('./email');

const WHATSAPP_TO = (process.env.WHATSAPP_TO || '+8801735698806').replace(/[^\d]/g, '');

function buildOrderMessage(order, items) {
    const lines = [
        `🛒 নতুন অর্ডার এসেছে! (Order #${order.id})`,
        '',
        `👤 কাস্টমার: ${order.customer_name}`,
        `📞 ফোন: ${order.phone}`,
        `📍 ঠিকানা: ${order.address}${order.city ? ', ' + order.city : ''}`,
        `💰 মোট: ৳${Number(order.total).toLocaleString('en-BD')}`,
        `💳 পেমেন্ট: Cash on Delivery`,
        '',
        'পণ্যসমূহ:',
        ...items.map(i => `• ${i.product_name} x${i.quantity} — ৳${Number(i.price * i.quantity).toLocaleString('en-BD')}`)
    ];
    return lines.join('\n');
}

function buildLowStockMessage(products) {
    const lines = [
        `⚠️ স্টক কমে গেছে!`,
        '',
        ...products.map(p => `• ${p.name} — বাকি আছে মাত্র ${p.stock}টা`),
        '',
        'দ্রুত রিস্টক করুন যাতে বিক্রি বন্ধ না হয়।'
    ];
    return lines.join('\n');
}

// Uses the free CallMeBot WhatsApp API — no paid business account needed.
// Setup: add +34 644 84 71 63 as a contact on the owner's WhatsApp, send it
// "I allow callmebot to send me messages", copy the apikey it replies with,
// and put it in CALLMEBOT_APIKEY in .env.
function sendWhatsAppMessage(text) {
    return new Promise((resolve) => {
        const apiKey = process.env.CALLMEBOT_APIKEY;
        if (!apiKey || !WHATSAPP_TO) return resolve();

        const url = `https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_TO}&text=${encodeURIComponent(text)}&apikey=${apiKey}`;

        https.get(url, (res) => {
            res.resume();
            resolve();
        }).on('error', (err) => {
            console.error('WhatsApp notify failed:', err.message);
            resolve();
        });
    });
}

// Fire-and-forget from the caller's point of view — never throws,
// so a slow or misconfigured channel never delays checkout.
async function notifyNewOrder(order, items) {
    try {
        const text = buildOrderMessage(order, items);
        await Promise.all([
            sendWhatsAppMessage(text),
            sendAlertEmail(`🛒 নতুন অর্ডার #${order.id} — ৳${Number(order.total).toLocaleString('en-BD')}`, text)
        ]);
    } catch (err) {
        console.error('Order notification failed:', err.message);
    }
}

// products: [{ name, stock }] — products that just crossed into low-stock
// territory as part of the order/edit that was just made.
async function notifyLowStock(products) {
    if (!products || products.length === 0) return;
    try {
        const text = buildLowStockMessage(products);
        await Promise.all([
            sendWhatsAppMessage(text),
            sendAlertEmail(`⚠️ স্টক কম — ${products.map(p => p.name).join(', ')}`, text)
        ]);
    } catch (err) {
        console.error('Low stock notification failed:', err.message);
    }
}

module.exports = { notifyNewOrder, notifyLowStock };
