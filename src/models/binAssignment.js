const { pool } = require('../config/db');

/**
 * Create a new bin assignment
 */
const createAssignment = async (binId, driverId, priority = 'medium', distanceKm = null, estimatedTimeMinutes = null) => {
    const res = await pool.query(
        `INSERT INTO bin_assignments (bin_id, driver_id, priority, distance_km, estimated_time_minutes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [binId, driverId, priority, distanceKm, estimatedTimeMinutes]
    );
    return res.rows[0];
};

/**
 * Get assignments by driver ID with optional status filter
 */
const getAssignmentsByDriver = async (driverId, status = null) => {
    let query = `
    SELECT 
      ba.*,
      b.name as bin_name,
      b.address as bin_address,
      b.society as bin_society,
      b.latitude as bin_latitude,
      b.longitude as bin_longitude,
      b.fill_level as bin_fill_level,
      b.status as bin_status
    FROM bin_assignments ba
    JOIN bins b ON ba.bin_id = b.id
    WHERE ba.driver_id = $1
  `;

    const params = [driverId];

    if (status) {
        query += ` AND ba.status = $2`;
        params.push(status);
    }

    query += ` ORDER BY ba.assigned_at DESC`;

    const res = await pool.query(query, params);
    return res.rows;
};

/**
 * Get assignment by ID
 */
const getAssignmentById = async (id) => {
    const res = await pool.query(
        `SELECT 
      ba.*,
      b.name as bin_name,
      b.address as bin_address,
      b.society as bin_society,
      b.latitude as bin_latitude,
      b.longitude as bin_longitude,
      b.fill_level as bin_fill_level,
      b.status as bin_status,
      u.first_name as driver_first_name,
      u.last_name as driver_last_name,
      u.phone_number as driver_phone
    FROM bin_assignments ba
    JOIN bins b ON ba.bin_id = b.id
    JOIN users u ON ba.driver_id = u.id
    WHERE ba.id = $1`,
        [id]
    );
    return res.rows[0];
};

/**
 * Update assignment status
 */
const updateAssignmentStatus = async (id, status, data = {}) => {
    const fields = ['status = $2'];
    const values = [id, status];
    let paramIndex = 3;

    // Add timestamp based on status
    if (status === 'in_progress' && !data.started_at) {
        fields.push(`started_at = CURRENT_TIMESTAMP`);
    } else if (status === 'completed' && !data.completed_at) {
        fields.push(`completed_at = CURRENT_TIMESTAMP`);
    }

    // Add optional fields
    if (data.started_at) {
        fields.push(`started_at = $${paramIndex++}`);
        values.push(data.started_at);
    }
    if (data.completed_at) {
        fields.push(`completed_at = $${paramIndex++}`);
        values.push(data.completed_at);
    }
    if (data.notes) {
        fields.push(`notes = $${paramIndex++}`);
        values.push(data.notes);
    }
    if (data.collection_weight) {
        fields.push(`collection_weight = $${paramIndex++}`);
        values.push(data.collection_weight);
    }

    const query = `
    UPDATE bin_assignments
    SET ${fields.join(', ')}
    WHERE id = $1
    RETURNING *
  `;

    const res = await pool.query(query, values);
    return res.rows[0];
};

/**
 * Get bins that need assignment (fill_level >= threshold and no active assignment)
 */
const getUnassignedBins = async (societyId = null, fillLevelThreshold = 80) => {
    let query = `
    SELECT b.*
    FROM bins b
    LEFT JOIN bin_assignments ba ON b.id = ba.bin_id 
      AND ba.status IN ('pending', 'in_progress')
    WHERE b.fill_level >= $1
      AND ba.id IS NULL
  `;

    const params = [fillLevelThreshold];

    if (societyId) {
        query += ` AND b.society = $2`;
        params.push(societyId);
    }

    query += ` ORDER BY b.fill_level DESC, b.created_at ASC`;

    const res = await pool.query(query, params);
    return res.rows;
};

/**
 * Get driver's current workload (count of active assignments)
 */
const getDriverWorkload = async (driverId) => {
    const res = await pool.query(
        `SELECT COUNT(*) as active_tasks
     FROM bin_assignments
     WHERE driver_id = $1 AND status IN ('pending', 'in_progress')`,
        [driverId]
    );
    return parseInt(res.rows[0].active_tasks);
};

/**
 * Get all assignments with filters (for admin)
 */
const getAllAssignments = async (filters = {}) => {
    let query = `
    SELECT 
      ba.*,
      b.name as bin_name,
      b.address as bin_address,
      b.society as bin_society,
      b.fill_level as bin_fill_level,
      u.first_name as driver_first_name,
      u.last_name as driver_last_name,
      u.phone_number as driver_phone
    FROM bin_assignments ba
    JOIN bins b ON ba.bin_id = b.id
    JOIN users u ON ba.driver_id = u.id
    WHERE 1=1
  `;

    const params = [];
    let paramIndex = 1;

    if (filters.status) {
        query += ` AND ba.status = $${paramIndex++}`;
        params.push(filters.status);
    }

    if (filters.driverId) {
        query += ` AND ba.driver_id = $${paramIndex++}`;
        params.push(filters.driverId);
    }

    if (filters.society) {
        query += ` AND b.society = $${paramIndex++}`;
        params.push(filters.society);
    }

    if (filters.startDate) {
        query += ` AND ba.assigned_at >= $${paramIndex++}`;
        params.push(filters.startDate);
    }

    if (filters.endDate) {
        query += ` AND ba.assigned_at <= $${paramIndex++}`;
        params.push(filters.endDate);
    }

    query += ` ORDER BY ba.assigned_at DESC`;

    if (filters.limit) {
        query += ` LIMIT $${paramIndex++}`;
        params.push(filters.limit);
    }

    if (filters.offset) {
        query += ` OFFSET $${paramIndex++}`;
        params.push(filters.offset);
    }

    const res = await pool.query(query, params);
    return res.rows;
};

/**
 * Cancel an assignment
 */
const cancelAssignment = async (id, reason = null) => {
    const res = await pool.query(
        `UPDATE bin_assignments
     SET status = 'cancelled', notes = $2
     WHERE id = $1
     RETURNING *`,
        [id, reason]
    );
    return res.rows[0];
};

/**
 * Reassign a bin to a different driver
 */
const reassignBin = async (assignmentId, newDriverId) => {
    const res = await pool.query(
        `UPDATE bin_assignments
     SET driver_id = $2, assigned_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
        [assignmentId, newDriverId]
    );
    return res.rows[0];
};

module.exports = {
    createAssignment,
    getAssignmentsByDriver,
    getAssignmentById,
    updateAssignmentStatus,
    getUnassignedBins,
    getDriverWorkload,
    getAllAssignments,
    cancelAssignment,
    reassignBin,
};
