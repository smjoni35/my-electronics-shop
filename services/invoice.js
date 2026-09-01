// Generates a professional-looking invoice/receipt PDF for an order using
// pdfkit — a free, open-source library (no paid API / subscription).
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545;
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT; // 495
const LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logo.png');

// Draws the shop logo, large and very faint, centered on the page — behind
// everything else, since it's drawn before any other content on the page.
// Wrapped in try/catch so a missing/corrupt logo file never breaks invoice
// generation; it just skips the watermark that one time.
function drawWatermark(doc) {
    if (!fs.existsSync(LOGO_PATH)) return;
    try {
        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const watermarkWidth = 320;
        const watermarkHeight = watermarkWidth * (320 / 480); // matches logo.png's own aspect ratio

        doc.save();
        doc.opacity(0.06);
        doc.image(
            LOGO_PATH,
            (pageWidth - watermarkWidth) / 2,
            (pageHeight - watermarkHeight) / 2,
            { width: watermarkWidth, height: watermarkHeight }
        );
        doc.restore();
    } catch (err) {
        console.error('Invoice watermark skipped:', err.message);
    }
}

function money(n) {
    return `Tk ${Number(n || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Streams the PDF straight to an HTTP response.
// order: row from `orders` (+ customer_name/phone/address/city/status/created_at/id/
//        subtotal/discount_amount/delivery_charge/coupon_code/total)
// items: rows from `order_items` (product_name, variant_label, quantity, price)
function streamInvoice(res, order, items, storeInfo, options = {}) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    // "download" forces a Save-As (Download Invoice); otherwise it opens inline
    // in the browser's PDF viewer, which has its own Print button (Print Invoice).
    const disposition = options.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="invoice-${order.id}.pdf"`);
    doc.pipe(res);

    drawWatermark(doc);

    // ---- Header: two independent columns (store info left, invoice meta
    // right) both starting from the exact same Y — no moveUp() guessing,
    // so the row below always starts from whichever column ran longer. ----
    const headerTop = doc.y;
    const leftColWidth = 260;
    const rightColX = PAGE_LEFT + leftColWidth + 20; // 330
    const rightColWidth = PAGE_RIGHT - rightColX;     // 215

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1300')
        .text(storeInfo.name, PAGE_LEFT, headerTop, { width: leftColWidth });
    let leftY = doc.y + 2;
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    [storeInfo.address, storeInfo.phone ? `Phone: ${storeInfo.phone}` : null, storeInfo.email]
        .filter(Boolean)
        .forEach(line => {
            doc.text(line, PAGE_LEFT, leftY, { width: leftColWidth });
            leftY = doc.y;
        });

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000')
        .text('INVOICE', rightColX, headerTop, { width: rightColWidth, align: 'right' });
    let rightY = doc.y + 4;
    doc.font('Helvetica').fontSize(10).fillColor('#333');
    [
        `Invoice / Order #: ${order.id}`,
        `Order date: ${new Date(order.created_at).toLocaleDateString('en-GB')}`,
        `Status: ${order.status.toUpperCase()}`
    ].forEach(line => {
        doc.text(line, rightColX, rightY, { width: rightColWidth, align: 'right' });
        rightY = doc.y;
    });

    let y = Math.max(leftY, rightY) + 12;
    doc.moveTo(PAGE_LEFT, y).lineTo(PAGE_RIGHT, y).strokeColor('#ddd').stroke();
    y += 16;

    // ---- Bill to ----
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Bill To', PAGE_LEFT, y);
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(10).fillColor('#333');
    [
        order.customer_name,
        order.phone,
        `${order.address}${order.city ? ', ' + order.city : ''}`,
        'Payment method: Cash on Delivery'
    ].forEach(line => {
        doc.text(line, PAGE_LEFT, y, { width: PAGE_WIDTH });
        y = doc.y;
    });

    y += 14;

    // ---- Items table ----
    // Columns sized to fit PAGE_LEFT..PAGE_RIGHT with no overlap; product
    // name gets the most room since it's the field most likely to wrap.
    const col = {
        name: { x: PAGE_LEFT, width: 195 },
        variant: { x: PAGE_LEFT + 205, width: 90 },
        qty: { x: PAGE_LEFT + 305, width: 35 },
        price: { x: PAGE_LEFT + 350, width: 70 },
        total: { x: PAGE_LEFT + 425, width: PAGE_RIGHT - (PAGE_LEFT + 425) }
    };

    const tableTop = y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000');
    doc.text('Product', col.name.x, tableTop, { width: col.name.width });
    doc.text('Variant', col.variant.x, tableTop, { width: col.variant.width });
    doc.text('Qty', col.qty.x, tableTop, { width: col.qty.width, align: 'right' });
    doc.text('Price', col.price.x, tableTop, { width: col.price.width, align: 'right' });
    doc.text('Subtotal', col.total.x, tableTop, { width: col.total.width, align: 'right' });

    y = tableTop + 16;
    doc.moveTo(PAGE_LEFT, y).lineTo(PAGE_RIGHT, y).strokeColor('#ccc').stroke();
    y += 8;

    doc.font('Helvetica').fontSize(9.5).fillColor('#222');
    // Draws `text` vertically centered within a row of height `rowHeight`,
    // instead of pinned to the row's top — used for the short single-line
    // cells (Variant/Qty/Price/Subtotal) next to a product name that may
    // wrap onto two lines and so be taller than they are.
    function centeredCell(text, x, rowY, rowHeight, options) {
        const cellHeight = doc.heightOfString(text, options);
        doc.text(text, x, rowY + (rowHeight - cellHeight) / 2, options);
    }

    items.forEach(item => {
        const lineTotal = parseFloat(item.price) * item.quantity;
        const nameText = item.product_name;
        const variantText = item.variant_label || '-';

        // Rows can wrap (long product names) — measure the actual height
        // each cell needs so nothing below ever overlaps the wrapped text.
        const nameHeight = doc.heightOfString(nameText, { width: col.name.width });
        const variantHeight = doc.heightOfString(variantText, { width: col.variant.width });
        const rowHeight = Math.max(nameHeight, variantHeight, 14);

        // Product name stays top-aligned (it's usually what sets the row's
        // height); the shorter single-line cells are centered against it.
        doc.text(nameText, col.name.x, y, { width: col.name.width });
        centeredCell(variantText, col.variant.x, y, rowHeight, { width: col.variant.width });
        centeredCell(String(item.quantity), col.qty.x, y, rowHeight, { width: col.qty.width, align: 'right' });
        centeredCell(money(item.price), col.price.x, y, rowHeight, { width: col.price.width, align: 'right' });
        centeredCell(money(lineTotal), col.total.x, y, rowHeight, { width: col.total.width, align: 'right' });

        y += rowHeight + 8;
    });

    doc.moveTo(PAGE_LEFT, y).lineTo(PAGE_RIGHT, y).strokeColor('#ccc').stroke();
    y += 14;

    // ---- Totals ----
    const totalsLabelX = PAGE_LEFT + 300;
    const totalsLabelWidth = 100;
    const totalsValueX = totalsLabelX + totalsLabelWidth;
    const totalsValueWidth = PAGE_RIGHT - totalsValueX;

    function totalRow(label, value, bold) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#000');
        doc.text(label, totalsLabelX, y, { width: totalsLabelWidth, align: 'left' });
        doc.text(value, totalsValueX, y, { width: totalsValueWidth, align: 'right' });
        y += bold ? 20 : 16;
    }

    totalRow('Subtotal', money(order.subtotal != null ? order.subtotal : order.total));
    if (parseFloat(order.discount_amount) > 0) {
        totalRow(`Discount${order.coupon_code ? ' (' + order.coupon_code + ')' : ''}`, `- ${money(order.discount_amount)}`);
    }
    totalRow('Delivery charge', money(order.delivery_charge));
    doc.moveTo(totalsLabelX, y).lineTo(PAGE_RIGHT, y).strokeColor('#000').stroke();
    y += 6;
    totalRow('Grand Total', money(order.total), true);

    // ---- Footer ----
    doc.font('Helvetica').fontSize(9).fillColor('#888')
        .text('Thank you for shopping with us!', PAGE_LEFT, 750, { align: 'center', width: PAGE_WIDTH });

    doc.end();
}

module.exports = { streamInvoice };
