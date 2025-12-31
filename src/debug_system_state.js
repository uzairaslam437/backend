const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function debugSystem() {
    try {
        const driverId = 8; // From logs
        const societyId = 2; // From logs

        console.log('--- DEBUGGING DRIVER (ID: 8) ---');

        // 1. Check User Location
        const userRes = await pool.query('SELECT id, username, role, society_id, latitude, longitude, last_location_update FROM users WHERE id = $1', [driverId]);
        console.log('User Record:', userRes.rows[0]);

        // 2. Check Driver Tasks
        const dtRes = await pool.query('SELECT * FROM driver_tasks WHERE driver_id = $1', [driverId]);
        console.log(`Driver Tasks Found: ${dtRes.rowCount}`);
        console.table(dtRes.rows);

        // 3. Check Tasks Table (for the tasks found above)
        if (dtRes.rowCount > 0) {
            const taskIds = dtRes.rows.map(r => r.task_id);
            const tasksRes = await pool.query('SELECT * FROM tasks WHERE id = ANY($1)', [taskIds]);
            console.log('Associated Tasks Details:');
            console.table(tasksRes.rows);
        } else {
            console.log('No tasks assigned to this driver.');
        }

        // 4. Check Pending Service Requests for this driver
        const srRes = await pool.query('SELECT * FROM service_requests WHERE driver_id = $1', [driverId]);
        console.log(`Service Requests Assigned: ${srRes.rowCount}`);
        console.table(srRes.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        pool.end();
    }
}

debugSystem();
