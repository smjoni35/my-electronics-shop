// Generates a professional-looking invoice/receipt PDF for an order using
// pdfkit — a free, open-source library (no paid API / subscription).
const PDFDocument = require('pdfkit');

function money(n) {
    return `Tk ${Number(n || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Streams the PDF straight to an HTTP response.
// order: row from `orders` (+ customer_name/phone/address/city/status/created_at/id/
//        subtotal/discount_amount/delivery_charge/coupon_code/total)
// items: rows from `order_items` (product_name, variant_label, quantity, price)
function streamInvoice(res, order, items, storeInfo) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${order.id}.pdf"`);
    doc.pipe(res);

    // ---- Header ----
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1300').text(storeInfo.name, { continued: false });
    doc.font('Helvetica').fontSize(9).fillColor('#555')
        .text(storeInfo.address || '')
        .text(storeInfo.phone ? `Phone: ${storeInfo.phone}` : '')
        .text(storeInfo.email || '');

    doc.moveUp(storeInfo.email ? 3 : 2);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text('INVOICE', 0, doc.y, { align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#333')
        .text(`Invoice / Order #: ${order.id}`, { align: 'right' })
        .text(`Order date: ${new Date(order.created_at).toLocaleDateString('en-GB')}`, { align: 'right' })
        .text(`Status: ${order.status.toUpperCase()}`, { align: 'right' });

    doc.moveDown(1.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown();

    // ---- Bill to ----
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Bill To');
    doc.font('Helvetica').fontSize(10).fillColor('#333')
        .text(order.customer_name)
        .text(order.phone)
        .text(`${order.address}${order.city ? ', ' + order.city : ''}`)
        .text('Payment method: Cash on Delivery');

    doc.moveDown(1.2);

    // ---- Items table ----
    const tableTop = doc.y;
    const col = { name: 50, variant: 220, qty: 340, price: 390, total: 470 };

    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000');
    doc.text('Product', col.name, tableTop);
    doc.text('Variant', col.variant, tableTop);
    doc.text('Qty', col.qty, tableTop, { width: 40, align: 'right' });
    doc.text('Price', col.price, tableTop, { width: 70, align: 'right' });
    doc.text('Subtotal', col.total, tableTop, { width: 75, align: 'right' });

    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor('#ccc').stroke();

    let y = tableTop + 22;
    doc.font('Helvetica').fontSize(9.5).fillColor('#222');
    items.forEach(item => {
        const lineTotal = parseFloat(item.price) * item.quantity;
        const rowHeight = 18;
        doc.text(item.product_name, col.name, y, { width: 165 });
        doc.text(item.variant_label || '-', col.variant, y, { width: 115 });
        doc.text(String(item.quantity), col.qty, y, { width: 40, align: 'right' });
        doc.text(money(item.price), col.price, y, { width: 70, align: 'right' });
        doc.text(money(lineTotal), col.total, y, { width: 75, align: 'right' });
        y += rowHeight;
    });

    doc.moveTo(50, y + 2).lineTo(545, y + 2).strokeColor('#ccc').stroke();
    y += 14;

    // ---- Totals ----
    const totalsX = 380;
    function totalRow(label, value, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#000');
        doc.text(label, totalsX, y, { width: 90, align: 'left' });
        doc.text(value, totalsX + 90, y, { width: 75, align: 'right' });
        y += bold ? 20 : 16;
    }

    totalRow('Subtotal', money(order.subtotal));
    if (parseFloat(order.discount_amount) > 0) {
        totalRow(`Discount${order.coupon_code ? ' (' + order.coupon_code + ')' : ''}`, `- ${money(order.discount_amount)}`);
    }
    totalRow('Delivery charge', money(order.delivery_charge));
    doc.moveTo(totalsX, y).lineTo(545, y).strokeColor('#000').stroke();
    y += 6;
    totalRow('Grand Total', money(order.total), true);

    // ---- Footer ----
    doc.font('Helvetica').fontSize(9).fillColor('#888')
        .text('Thank you for shopping with us!', 50, 750, { align: 'center', width: 495 });

    doc.end();
}

module.exports = { streamInvoice };
