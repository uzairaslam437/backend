const { pool } = require('../config/db');
const assignmentService = require('../services/assignmentService');
const websocketService = require('../services/websocketService');

async function createTask(req, res) {
  try {
    const { bin_id, fill_level, priority, notes } = req.body;
    if (!bin_id) return res.status(400).json({ success: false, message: 'bin_id required' });

    // retrieve bin to get society
    const binQ = `SELECT id, society, latitude, longitude FROM bins WHERE id = $1`;
    const binRes = await pool.query(binQ, [bin_id]);
    const bin = binRes.rows[0];

    let society_id = null;
    if (bin && typeof bin.society === 'number') society_id = bin.society;
    else if (bin && bin.society) {
      const sRes = await pool.query(`SELECT id FROM societies WHERE society_name = $1 LIMIT 1`, [bin.society]);
      if (sRes.rows[0]) society_id = sRes.rows[0].id;
    }

    const insertQ = `INSERT INTO tasks (bin_id, society_id, fill_level, priority, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`;
    const insertRes = await pool.query(insertQ, [bin_id, society_id, fill_level || 0, priority || 'normal', notes ? JSON.stringify(notes) : '{}' ]);
    const task = insertRes.rows[0];

    // attempt auto-assign with websocket notification
    const assignment = await assignmentService.assignTask(task.id, req.user ? req.user.id : null, websocketService);

    res.json({ success: true, task, assignment });
  } catch (err) {
    console.error('createTask error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /tasks/driver/:id - List driver's assigned tasks (for mobile)
async function getDriverTasks(req, res) {
  try {
    const driverId = req.params.id || req.user.id;
    if (!driverId) return res.status(400).json({ success: false, message: 'Driver ID required' });

    // get driver's active/pending tasks with bin details
    const q = `SELECT dt.id, dt.task_id, dt.driver_id, dt.status, dt.assigned_at, dt.accepted_at, dt.completed_at,
               t.bin_id, t.fill_level, t.priority, t.created_at as task_created_at,
               b.id as bin_id, b.name, b.address, b.latitude, b.longitude, b.status as bin_status
               FROM driver_tasks dt
               JOIN tasks t ON dt.task_id = t.id
               LEFT JOIN bins b ON t.bin_id = b.id
               WHERE dt.driver_id = $1 AND t.status != 'cancelled'
               ORDER BY dt.assigned_at DESC`;
    const res_query = await pool.query(q, [driverId]);

    res.json({ success: true, tasks: res_query.rows });
  } catch (err) {
    console.error('getDriverTasks error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// POST /tasks/:id/status - Update task status (driver acceptance, arrival, completion)
async function updateTaskStatus(req, res) {
  try {
    const { taskId } = req.params;
    const { status, notes, photo_url } = req.body;
    const driverId = req.user.id;

    if (!taskId || !status) return res.status(400).json({ success: false, message: 'taskId and status required' });

    // verify driver is assigned to this task
    const checkQ = `SELECT dt.id FROM driver_tasks dt WHERE dt.task_id = $1 AND dt.driver_id = $2`;
    const checkRes = await pool.query(checkQ, [taskId, driverId]);
    if (!checkRes.rows[0]) return res.status(403).json({ success: false, message: 'Not assigned to this task' });

    // allowed status transitions
    const validStatuses = ['accepted', 'enroute', 'arrived', 'completed', 'failed'];
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

    // update driver_tasks and tasks
    const updates = { status };
    if (status === 'accepted') updates.accepted_at = 'CURRENT_TIMESTAMP';
    if (status === 'completed') updates.completed_at = 'CURRENT_TIMESTAMP';

    const updateParts = Object.keys(updates).map((k, i) => `${k} = ${updates[k] === 'CURRENT_TIMESTAMP' ? 'CURRENT_TIMESTAMP' : `'${updates[k]}'`}`).join(', ');
    const updateQ = `UPDATE driver_tasks SET ${updateParts} WHERE task_id = $1 AND driver_id = $2 RETURNING *`;
    const updateRes = await pool.query(updateQ, [taskId, driverId]);

    // update task status too
    await pool.query(`UPDATE tasks SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, taskId]);

    // log event
    const eventPayload = { status, notes, photo_url, updated_by: driverId };
    await pool.query(`INSERT INTO task_events (task_id, event_type, payload, created_by) VALUES ($1, 'status_update', $2, $3)`,
      [taskId, JSON.stringify(eventPayload), driverId]);

    res.json({ success: true, driver_task: updateRes.rows[0] });
  } catch (err) {
    console.error('updateTaskStatus error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// POST /drivers/:id/location - Stream driver location
async function postDriverLocation(req, res) {
  try {
    const { latitude, longitude, heading, speed } = req.body;
    const driverId = req.params.id || req.user.id;

    if (!latitude || !longitude) return res.status(400).json({ success: false, message: 'latitude and longitude required' });

    const insertQ = `INSERT INTO driver_locations (driver_id, latitude, longitude, heading, speed, recorded_at) 
                     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING *`;
    const insertRes = await pool.query(insertQ, [driverId, latitude, longitude, heading, speed]);

    // Get driver's society to broadcast location
    const driverQ = `SELECT society_id FROM users WHERE id = $1`;
    const driverRes = await pool.query(driverQ, [driverId]);
    const driver = driverRes.rows[0];

    if (driver && driver.society_id) {
      websocketService.broadcastDriverLocation(driverId, driver.society_id, insertRes.rows[0]);
    }

    res.json({ success: true, location: insertRes.rows[0] });
  } catch (err) {
    console.error('postDriverLocation error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /admin/societies/:societyId/drivers/locations - Get drivers on map (for admin)
async function getSocietyDriverLocations(req, res) {
  try {
    const { societyId } = req.params;
    if (!societyId) return res.status(400).json({ success: false, message: 'societyId required' });

    const q = `SELECT u.id, u.first_name, u.last_name, u.phone_number,
               dl.latitude, dl.longitude, dl.heading, dl.speed, dl.recorded_at,
               COUNT(dt.id) FILTER (WHERE t.status IN ('assigned','accepted','enroute')) as active_tasks
               FROM users u
               LEFT JOIN driver_locations dl ON u.id = dl.driver_id AND dl.recorded_at = (
                 SELECT recorded_at FROM driver_locations WHERE driver_id = u.id ORDER BY recorded_at DESC LIMIT 1
               )
               LEFT JOIN driver_tasks dt ON u.id = dt.driver_id
               LEFT JOIN tasks t ON dt.task_id = t.id
               WHERE u.role = 'driver' AND u.society_id = $1 AND u.is_blocked = false
               GROUP BY u.id, u.first_name, u.last_name, u.phone_number, dl.latitude, dl.longitude, dl.heading, dl.speed, dl.recorded_at`;
    const res_query = await pool.query(q, [societyId]);

    res.json({ success: true, drivers: res_query.rows });
  } catch (err) {
    console.error('getSocietyDriverLocations error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /admin/drivers - Get all drivers for superadmin map
async function getAllDriverLocations(req, res) {
  try {
    const q = `SELECT u.id, u.first_name, u.last_name, u.phone_number, u.society_id,
               s.society_name,
               dl.latitude, dl.longitude, dl.heading, dl.speed, dl.recorded_at,
               COUNT(dt.id) FILTER (WHERE t.status IN ('assigned','accepted','enroute')) as active_tasks
               FROM users u
               LEFT JOIN societies s ON u.society_id = s.id
               LEFT JOIN driver_locations dl ON u.id = dl.driver_id AND dl.recorded_at = (
                 SELECT recorded_at FROM driver_locations WHERE driver_id = u.id ORDER BY recorded_at DESC LIMIT 1
               )
               LEFT JOIN driver_tasks dt ON u.id = dt.driver_id
               LEFT JOIN tasks t ON dt.task_id = t.id
               WHERE u.role = 'driver' AND u.is_blocked = false
               GROUP BY u.id, u.first_name, u.last_name, u.phone_number, u.society_id, s.society_name, dl.latitude, dl.longitude, dl.heading, dl.speed, dl.recorded_at`;
    const res_query = await pool.query(q);

    res.json({ success: true, drivers: res_query.rows });
  } catch (err) {
    console.error('getAllDriverLocations error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /tasks/:id - Get task details with events/history
async function getTaskDetails(req, res) {
  try {
    const { id } = req.params;
    const taskQ = `SELECT t.*, u.first_name as created_by_name FROM tasks t 
                   LEFT JOIN users u ON t.created_by = u.id WHERE t.id = $1`;
    const taskRes = await pool.query(taskQ, [id]);
    if (!taskRes.rows[0]) return res.status(404).json({ success: false, message: 'Task not found' });

    const task = taskRes.rows[0];

    // get assignment details
    const assignmentQ = `SELECT dt.*, d.first_name, d.last_name, d.phone_number FROM driver_tasks dt 
                         LEFT JOIN users d ON dt.driver_id = d.id WHERE dt.task_id = $1`;
    const assignmentRes = await pool.query(assignmentQ, [id]);

    // get events/history
    const eventsQ = `SELECT * FROM task_events WHERE task_id = $1 ORDER BY created_at DESC`;
    const eventsRes = await pool.query(eventsQ, [id]);

    res.json({ success: true, task, assignment: assignmentRes.rows[0], events: eventsRes.rows });
  } catch (err) {
    console.error('getTaskDetails error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { 
  createTask, 
  getDriverTasks, 
  updateTaskStatus, 
  postDriverLocation,
  getSocietyDriverLocations,
  getAllDriverLocations,
  getTaskDetails
};
