// Sends a "নতুন অর্ডার" WhatsApp alert to the shop owner whenever a
// customer places an order. Uses the free CallMeBot API — controlled
// purely by .env; if it isn't configured, this silently does nothing
// (never blocks or breaks checkout).
const https = require('https');

const WHATSAPP_TO = (process.env.WHATSAPP_TO || '+8801735698806').replace(/[^\d]/g, '');

function buildMessage(order, items) {
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

// Uses the free CallMeBot WhatsApp API — no paid business account needed.
// Setup: add +34 644 84 71 63 as a contact on the owner's WhatsApp, send it
// "I allow callmebot to send me messages", copy the apikey it replies with,
// and put it in CALLMEBOT_APIKEY in .env.
function sendWhatsApp(order, items) {
    return new Promise((resolve) => {
        const apiKey = process.env.CALLMEBOT_APIKEY;
        if (!apiKey || !WHATSAPP_TO) return resolve();

        const text = encodeURIComponent(buildMessage(order, items));
        const url = `https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_TO}&text=${text}&apikey=${apiKey}`;

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
// so a slow or misconfigured WhatsApp API call never delays checkout.
async function notifyNewOrder(order, items) {
    try {
        await sendWhatsApp(order, items);
    } catch (err) {
        console.error('Order notification failed:', err.message);
    }
}

module.exports = { notifyNewOrder };
