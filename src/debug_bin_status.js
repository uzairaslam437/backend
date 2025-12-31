const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function checkBinStatus() {
    try {
        console.log('--- CHECKING UNASSIGNED FULL BINS ---');

        // Find bins that are high fill level
        const fullBins = await pool.query('SELECT * FROM bins WHERE fill_level >= 90');
        console.log(`Full Bins (>90%): ${fullBins.rowCount}`);
        console.table(fullBins.rows.map(b => ({ id: b.id, name: b.name, level: b.fill_level })));

        if (fullBins.rowCount > 0) {
            // Check if they have active tasks
            const binIds = fullBins.rows.map(b => b.id);
            const tasks = await pool.query(`SELECT * FROM tasks WHERE bin_id = ANY($1) AND status NOT IN ('completed', 'cancelled')`, [binIds]);
            console.log(`Active Tasks for these bins: ${tasks.rowCount}`);
            console.table(tasks.rows.map(t => ({ id: t.id, bin_id: t.bin_id, status: t.status })));

            if (tasks.rowCount > 0) {
                const taskIds = tasks.rows.map(t => t.id);
                const dTasks = await pool.query('SELECT * FROM driver_tasks WHERE task_id = ANY($1)', [taskIds]);
                console.log(`Driver Assignments for these tasks: ${dTasks.rowCount}`);
                console.table(dTasks.rows);
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        pool.end();
    }
}

checkBinStatus();
