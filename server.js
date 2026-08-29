require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./db/pool');

const shopRoutes = require('./routes/shop');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

app.use((req, res, next) => {
    res.locals.storeName = process.env.STORE_NAME || 'JM Gadget Zone';
    res.locals.cartCount = req.session.cart
        ? Object.values(req.session.cart).reduce((a, b) => a + b, 0)
        : 0;
    res.locals.currentUsername = req.session.adminUsername || null;
    res.locals.currentRole = req.session.adminRole || null;
    // Absolute site URL — needed so og:image/og:url work when a link is shared on
    // WhatsApp/Facebook. Set BASE_URL in .env (e.g. https://jmgadgetzone.com) in
    // production; falls back to whatever host the request came in on.
    res.locals.baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    // Sensible defaults for pages that don't set their own OG tags
    res.locals.ogTitle = res.locals.storeName;
    res.locals.ogDescription = 'বাংলাদেশের সেরা অনলাইন ইলেকট্রনিক্স ও গ্যাজেট শপ — অরিজিনাল পণ্য, ক্যাশ অন ডেলিভারি।';
    res.locals.ogImage = `${res.locals.baseUrl}/img/logo.png`;
    next();
});

app.use('/', shopRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
    res.status(404).render('404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
