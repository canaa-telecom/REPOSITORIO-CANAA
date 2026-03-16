const { Pool } = require('pg');
require('dotenv').config();
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function fixUser() {
  try {
    const hash = bcrypt.hashSync('Cna!@#123', 10);
    // Update the first user to make sure the login works
    const res = await pool.query(
      "UPDATE usuarios SET nome = $1, senha = $2 WHERE id = 1 RETURNING *", 
      ['Governança', hash]
    );
    console.log('User Updated:', res.rows[0]);
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

fixUser();
