const { pool } = require('../config/db');

/**
 * Save or update driver's current location
 */
const saveDriverLocation = async (driverId, latitude, longitude, accuracy = null, heading = null, speed = null) => {
    // Deactivate previous locations
    await pool.query(
        `UPDATE driver_locations SET is_active = FALSE WHERE driver_id = $1`,
        [driverId]
    );

    // Insert new location
    const res = await pool.query(
        `INSERT INTO driver_locations (driver_id, latitude, longitude, accuracy, heading, speed, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     RETURNING *`,
        [driverId, latitude, longitude, accuracy, heading, speed]
    );

    return res.rows[0];
};

/**
 * Get driver's latest active location
 */
const getDriverLocation = async (driverId) => {
    const res = await pool.query(
        `SELECT * FROM driver_locations
     WHERE driver_id = $1 AND is_active = TRUE
     ORDER BY recorded_at DESC
     LIMIT 1`,
        [driverId]
    );
    return res.rows[0];
};

/**
 * Get all active driver locations for a society
 */
const getActiveDriverLocations = async (societyId = null) => {
    let query = `
    SELECT 
      dl.*,
      u.first_name,
      u.last_name,
      u.phone_number,
      u.society_id
    FROM driver_locations dl
    JOIN users u ON dl.driver_id = u.id
    WHERE dl.is_active = TRUE AND u.role = 'driver'
  `;

    const params = [];

    if (societyId) {
        query += ` AND u.society_id = $1`;
        params.push(societyId);
    }

    query += ` ORDER BY dl.recorded_at DESC`;

    const res = await pool.query(query, params);
    return res.rows;
};

/**
 * Get driver location history
 */
const getDriverLocationHistory = async (driverId, limit = 100) => {
    const res = await pool.query(
        `SELECT * FROM driver_locations
     WHERE driver_id = $1
     ORDER BY recorded_at DESC
     LIMIT $2`,
        [driverId, limit]
    );
    return res.rows;
};

/**
 * Clean up old location records (older than specified days)
 */
const cleanupOldLocations = async (daysToKeep = 7) => {
    const res = await pool.query(
        `DELETE FROM driver_locations
     WHERE recorded_at < NOW() - INTERVAL '${daysToKeep} days'
     AND is_active = FALSE
     RETURNING id`,
        []
    );
    return res.rowCount;
};

module.exports = {
    saveDriverLocation,
    getDriverLocation,
    getActiveDriverLocations,
    getDriverLocationHistory,
    cleanupOldLocations,
};
