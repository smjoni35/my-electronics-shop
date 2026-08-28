require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false }
        : false
});

async function migrate() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('Running schema...');
    await pool.query(schema);
    console.log('Schema applied.');

    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';

    const existing = await pool.query('SELECT * FROM admins WHERE username = $1', [adminUser]);
    if (existing.rows.length === 0) {
        const hash = await bcrypt.hash(adminPass, 10);
        await pool.query('INSERT INTO admins (username, password_hash, role) VALUES ($1, $2, $3)', [adminUser, hash, 'admin']);
        console.log(`Default admin created -> username: ${adminUser}, password: ${adminPass}`);
    } else {
        console.log('Admin already exists, skipping creation.');
    }

    await pool.end();
    console.log('Migration complete.');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
