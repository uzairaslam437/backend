const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function checkTables() {
    try {
        console.log('--- CHECKING TABLES ---');
        const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
        const tableNames = tables.rows.map(t => t.table_name);
        console.log('Tables:', tableNames.join(', '));

        if (tableNames.includes('bin_assignments')) {
            console.log('\n--- CHECKING BIN_ASSIGNMENTS ---');
            const ba = await pool.query('SELECT * FROM bin_assignments');
            console.log(`RowCount: ${ba.rowCount}`);
            console.table(ba.rows);
        } else {
            console.log('\nTable "bin_assignments" does NOT exist.');
        }

        console.log('\n--- RE-CHECKING DRIVER_TASKS ---');
        const dt = await pool.query('SELECT * FROM driver_tasks');
        console.log(`RowCount: ${dt.rowCount}`);
        console.table(dt.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        pool.end();
    }
}

checkTables();
