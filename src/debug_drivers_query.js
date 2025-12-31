const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function debugDrivers() {
    try {
        console.log('--- EXECUTING getDrivers QUERY ---');
        const q = await pool.query(`
        SELECT u.*, dl.latitude, dl.longitude, dl.recorded_at as last_location_update 
        FROM users u 
        LEFT JOIN LATERAL (
          SELECT latitude, longitude, recorded_at 
          FROM driver_locations 
          WHERE driver_id = u.id 
          ORDER BY recorded_at DESC 
          LIMIT 1
        ) dl ON true
        WHERE u.role = 'driver'
    `);

        console.log(`Drivers Found: ${q.rowCount}`);
        q.rows.forEach(r => {
            console.log(`Driver ID: ${r.id}, Name: ${r.first_name}, Society: ${r.society_id}, Lat: ${r.latitude}, Lon: ${r.longitude}`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        pool.end();
    }
}

debugDrivers();
