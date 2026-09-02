// Steadfast Courier API client.
// Docs: https://steadfast.com.bd/docs (merchant panel → API credentials)
//
// Needs two env vars, taken from the Steadfast merchant panel:
//   STEADFAST_API_KEY
//   STEADFAST_SECRET_KEY
// Optional (for the delivery-status webhook — see routes/webhooks.js):
//   STEADFAST_WEBHOOK_TOKEN

const BASE_URL = 'https://portal.packzy.com/api/v1';

function getCredentials() {
    const apiKey = process.env.STEADFAST_API_KEY;
    const secretKey = process.env.STEADFAST_SECRET_KEY;
    if (!apiKey || !secretKey) {
        throw new Error('Steadfast API credentials সেট করা নেই — .env এ STEADFAST_API_KEY ও STEADFAST_SECRET_KEY দিন।');
    }
    return { apiKey, secretKey };
}

function authHeaders() {
    const { apiKey, secretKey } = getCredentials();
    return {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
        'Secret-Key': secretKey
    };
}

// Creates a consignment for an order and returns Steadfast's tracking info.
// `order` is a row from the orders table; `items` is that order's order_items rows.
async function createConsignment(order, items) {
    const itemDescription = items
        .map(i => `${i.product_name}${i.variant_label ? ' (' + i.variant_label + ')' : ''} x${i.quantity}`)
        .join(', ')
        .slice(0, 250);

    const body = {
        invoice: 'ORD-' + String(order.id).padStart(5, '0'),
        recipient_name: order.customer_name,
        recipient_phone: order.phone,
        recipient_address: [order.address, order.city].filter(Boolean).join(', '),
        cod_amount: order.payment_method === 'cod' ? Number(order.total) : 0,
        note: itemDescription
    };

    let res, data;
    try {
        res = await fetch(`${BASE_URL}/create_order`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(body)
        });
        data = await res.json();
    } catch (err) {
        throw new Error('Steadfast এ যোগাযোগ করা যায়নি — ইন্টারনেট বা সার্ভিস ডাউন থাকতে পারে।');
    }

    if (!res.ok || !data || !data.consignment) {
        throw new Error((data && data.message) || 'Steadfast এ অর্ডার পাঠানো যায়নি।');
    }

    return {
        consignmentId: data.consignment.consignment_id,
        trackingCode: data.consignment.tracking_code,
        status: data.consignment.status || 'in_review'
    };
}

// Looks up the current delivery status directly from Steadfast by consignment id
// (used for a manual "refresh" button, in case a webhook update was missed).
async function checkStatus(consignmentId) {
    let res, data;
    try {
        res = await fetch(`${BASE_URL}/status_by_cid/${consignmentId}`, { headers: authHeaders() });
        data = await res.json();
    } catch (err) {
        throw new Error('Steadfast এ যোগাযোগ করা যায়নি।');
    }
    if (!res.ok || !data || typeof data.delivery_status === 'undefined') {
        throw new Error((data && data.message) || 'স্ট্যাটাস চেক করা যায়নি।');
    }
    return data.delivery_status;
}

// Maps a Steadfast consignment status to this site's own order.status values
// (pending / confirmed / shipped / delivered / cancelled).
function mapStatus(steadfastStatus) {
    const map = {
        pending: 'shipped',
        in_review: 'shipped',
        hold: 'shipped',
        delivered: 'delivered',
        partial_delivered: 'delivered',
        cancelled: 'cancelled',
        unknown: 'shipped'
    };
    return map[steadfastStatus] || 'shipped';
}

module.exports = { createConsignment, checkStatus, mapStatus };
