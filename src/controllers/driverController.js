// controllers/driverController.js
const { pool } = require("../config/db");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { logSubAdminActivity } = require("../services/subAdminLogger");
const binAssignmentModel = require("../models/binAssignment");
const binAssignmentService = require("../services/binAssignmentService");
const driverLocationModel = require("../models/driverLocation");
const websocketService = require("../services/websocketService");

/* -------------------------------------------------------
 * Helpers (DRY + validation)
 * ----------------------------------------------------- */

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const isEmailValid = (email) => EMAIL_REGEX.test(String(email || "").trim());

const toInt = (v, fb = null) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fb;
};

const splitName = (fullName = "") => {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return { first, last };
};

const usernameFromEmail = (email) => String(email || "").trim().split("@")[0];

const requireRole = (reqUser, roles = []) => {
  if (!roles.includes(reqUser?.role)) {
    const err = new Error("Access denied");
    err.status = 403;
    throw err;
  }
};

const ensureSelfOrRole = (reqUser, targetUserId, roles = []) => {
  if (roles.includes(reqUser.role)) return;
  if (reqUser.role === "driver" && reqUser.id === toInt(targetUserId)) return;
  const err = new Error("Access denied");
  err.status = 403;
  throw err;
};

const ensureDriverExists = async (id) => {
  const q = await pool.query(`SELECT * FROM users WHERE id = $1 AND role = 'driver'`, [id]);
  if (q.rows.length === 0) {
    const err = new Error("Driver not found");
    err.status = 404;
    throw err;
  }
  return q.rows[0];
};

const ensureUniqueEmailAndPhone = async (email, phone) => {
  if (email) {
    const qe = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (qe.rows.length) {
      const err = new Error("Email already in use.");
      err.status = 400;
      throw err;
    }
  }
  if (phone) {
    const qp = await pool.query(`SELECT 1 FROM users WHERE phone_number = $1`, [phone]);
    if (qp.rows.length) {
      const err = new Error("Phone number already in use.");
      err.status = 400;
      throw err;
    }
  }
};

const sendVerificationEmail = async (recipientUsername, recipientEmail, verificationToken) => {
  if (!process.env.SENDER_EMAIL || !process.env.SENDER_PASSWORD || !process.env.FRONTEND_URL) {
    const err = new Error("Email configuration missing");
    err.status = 500;
    throw err;
  }

  const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SENDER_EMAIL,
      pass: process.env.SENDER_PASSWORD,
    },
  });

  // Minimal email (reuse your branded HTML if you prefer)
  const html = `
    <h2>Verify your account</h2>
    <p>Hello ${recipientUsername}, please verify your email to set your password.</p>
    <p><a href="${verificationLink}">Verify Email</a></p>
    <p>If the button doesn't work, copy and paste this link into your browser:</p>
    <code>${verificationLink}</code>
  `;

  await transporter.sendMail({
    from: `Green Guardian <${process.env.SENDER_EMAIL}>`,
    to: recipientEmail,
    subject: "Verify your email",
    html,
  });
};

/* -------------------------------------------------------
 * Controllers
 * ----------------------------------------------------- */

// const addDriver = async (req, res) => {
//   try {
//     requireRole(req.user, ["admin", "super_admin"]);

//     const { fullName, email, phone /* status */ } = req.body;

//     if (!fullName || !email || !phone) {
//       return res.status(400).json({ message: "Full name, email, and phone are required" });
//     }
//     if (!isEmailValid(email)) {
//       return res.status(400).json({ message: "Invalid email address" });
//     }

//     await ensureUniqueEmailAndPhone(email, phone);

//     const { first, last } = splitName(fullName);
//     const username = usernameFromEmail(email);

//     // Force role to 'driver' for security (ignore body.role)
//     const insert = await pool.query(
//       `INSERT INTO users (first_name, last_name, username, phone_number, email, role)
//        VALUES ($1, $2, $3, $4, $5, 'driver') RETURNING *`,
//       [first, last, username, phone, email]
//     );
//     const createdUser = insert.rows[0];

//     // Email verification token
//     const verificationToken = crypto.randomBytes(32).toString("hex");
//     const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

//     await pool.query(
//       `INSERT INTO email_verification_tokens (user_id, token, expires_at)
//        VALUES ($1, $2, $3)`,
//       [createdUser.id, verificationToken, expiresAt]
//     );

//     await sendVerificationEmail(username, email, verificationToken);

//     return res.status(201).json({
//       message: "Driver created. Email sent to verify and set password.",
//       driver: {
//         id: createdUser.id,
//         first_name: createdUser.first_name,
//         last_name: createdUser.last_name,
//         email: createdUser.email,
//         phone_number: createdUser.phone_number,
//         role: createdUser.role,
//       },
//     });
//   } catch (error) {
//     const status = error.status || 500;
//     console.error(`Error creating driver: ${error.message}`);
//     return res.status(status).json({ message: error.message });
//   }
// };

const getDrivers = async (req, res) => {
  try {
    const role = req.user.role;

    if (role === "admin" || role === "sub_admin" || role === "super_admin") {
      // Query to get drivers along with their latest location
      // Using LATERAL join for PostgreSQL to get the most recent location per driver efficiently
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

      return res.status(200).json({
        message: "Drivers retrieved successfully",
        drivers: q.rows,
        count: q.rows.length,
      });
    }

    if (role === "driver") {
      // Similar join for single driver if needed, though usually they just update location
      const q = await pool.query(`SELECT * FROM users WHERE role = 'driver' AND id = $1`, [req.user.id]);
      return res.status(200).json({
        message: "Drivers retrieved successfully",
        drivers: q.rows,
        count: q.rows.length,
      });
    }

    return res.status(403).json({ message: "Access denied" });
  } catch (error) {
    console.error("Error fetching drivers:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

const updateDriver = async (req, res) => {
  try {
    const id = toInt(req.params.id, null);
    ensureSelfOrRole(req.user, id, ["admin", "sub_admin", "super_admin"]);
    if (id === null) return res.status(400).json({ message: "Driver ID is required" });

    await ensureDriverExists(id);

    const { fullName, phone, email } = req.body;
    const fields = [];
    const vals = [];
    let i = 1;

    if (fullName !== undefined) {
      const { first, last } = splitName(fullName);
      fields.push(`first_name = $${i++}`);
      vals.push(first);
      if (last) {
        fields.push(`last_name = $${i++}`);
        vals.push(last);
      }
    }
    if (phone !== undefined) {
      fields.push(`phone_number = $${i++}`);
      vals.push(phone);
    }
    if (email !== undefined) {
      if (!isEmailValid(email)) {
        return res.status(400).json({ message: "Invalid email address" });
      }
      const qe = await pool.query(`SELECT 1 FROM users WHERE email = $1 AND id <> $2`, [email, id]);
      if (qe.rows.length) {
        return res.status(400).json({ message: "Email already in use." });
      }
      fields.push(`email = $${i++}`);
      vals.push(email);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No valid fields provided for update" });
    }

    const sql = `
      UPDATE users
      SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${i} AND role = 'driver'
      RETURNING *`;
    vals.push(id);

    const upd = await pool.query(sql, vals);

    if (req.user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "UPDATE_DRIVER",
        description: `Sub Admin ${req.user.id} updated data of driver with email: ${email} ${Date.now()}`,
      });
    }
    return res.status(200).json({ message: "Driver updated successfully", driver: upd.rows[0] });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error updating driver:", error);
    return res.status(status).json({ message: error.message });
  }
};

const deleteDriver = async (req, res) => {
  try {
    requireRole(req.user, ["admin", "sub_admin", "super_admin"]);

    const id = toInt(req.params.id, null);
    if (id === null) return res.status(400).json({ message: "Driver ID is required" });

    await ensureDriverExists(id);

    const del = await pool.query(
      `DELETE FROM users WHERE id = $1 AND role = 'driver' RETURNING *`,
      [id]
    );

    return res.status(200).json({ message: "Driver deleted successfully", driver: del.rows[0] });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error deleting driver:", error);
    return res.status(status).json({ message: error.message });
  }
};

const assignWorkArea = async (req, res) => {
  try {
    requireRole(req.user, ["admin", "sub_admin", "super_admin"]);

    const { driverId, workAreaId, societyId } = req.body;

    const dId = toInt(driverId, null);
    if (dId === null) return res.status(400).json({ message: "driverId is required" });
    await ensureDriverExists(dId);

    // Ensure driver is verified
    const verified = await pool.query(
      `SELECT 1 FROM users WHERE id = $1 AND is_verified = true`,
      [dId]
    );
    if (!verified.rows.length) {
      return res.status(404).json({ message: "Driver not found or not verified" });
    }

    // Stub assignment payload (replace with real persistence when ready)
    const assignmentData = {
      id: Math.floor(Math.random() * 1000000),
      driver_id: dId,
      work_area_id: workAreaId,
      society_id: societyId,
      assigned_date: new Date().toISOString(),
      status: "active",
      area_name: `Sector ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`,
      area_description: "Residential area with 150 households",
      estimated_bins: Math.floor(Math.random() * 50) + 20
    };

    return res.status(201).json({
      message: "Work area assigned successfully",
      assignment: assignmentData,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error assigning work area:", error);
    return res.status(status).json({ message: error.message });
  }
};

const getDriverWorkAreas = async (req, res) => {
  try {
    const driverId = req.user.id;

    if (driverId === null) return res.status(400).json({ message: "Invalid driver id" });

    ensureSelfOrRole(req.user, driverId, ["admin", "sub_admin", "super_admin"]);

    const workAreas = [
      {
        id: 1,
        area_name: "Sector A",
        area_description: "Residential area with 150 households",
        assigned_date: "2024-01-15T08:00:00Z",
        status: "active",
        total_bins: 25,
        estimated_collection_time: "4 hours",
        priority: "medium"
      },
      {
        id: 2,
        area_name: "Sector B",
        area_description: "Commercial area with shops and offices",
        assigned_date: "2024-01-20T08:00:00Z",
        status: "active",
        total_bins: 18,
        estimated_collection_time: "3 hours",
        priority: "high"
      }
    ];

    return res.status(200).json({
      message: "Work areas retrieved successfully",
      workAreas,
      count: workAreas.length,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error fetching work areas:", error);
    return res.status(status).json({ message: error.message });
  }
};

const getCollectionRoutes = async (req, res) => {
  try {
    const driverId = toInt(req.params.driverId, null);
    if (driverId === null) return res.status(400).json({ message: "Invalid driver id" });

    ensureSelfOrRole(req.user, driverId, ["admin", "sub_admin", "super_admin"]);

    // Stub data
    const routes = [
      {
        id: 1,
        route_name: "Route A-1",
        work_area: "Sector A",
        bins: [
          {
            bin_id: "BIN_001",
            location: { lat: 33.6844, lng: 73.0479 },
            address: "House #123, Street 5, Sector A",
            fill_level: 85,
            status: "needs_collection",
            priority: "high",
            last_collected: "2024-01-18T10:30:00Z"
          },
          {
            bin_id: "BIN_002",
            location: { lat: 33.6845, lng: 73.0480 },
            address: "House #125, Street 5, Sector A",
            fill_level: 65,
            status: "moderate",
            priority: "medium",
            last_collected: "2024-01-19T09:15:00Z"
          }
        ],
        estimated_time: "2 hours",
        distance: "5.2 km",
        status: "pending"
      }
    ];

    return res.status(200).json({
      message: "Collection routes retrieved successfully",
      routes,
      total_routes: routes.length,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error fetching collection routes:", error);
    return res.status(status).json({ message: error.message });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    requireRole(req.user, ["driver"]);
    const taskId = toInt(req.params.taskId, null);
    if (taskId === null) return res.status(400).json({ message: "taskId is required" });

    const { status, notes, completedAt, location } = req.body;

    // Ensure the driver-task exists and belongs to this driver
    const dtQ = `SELECT * FROM driver_tasks WHERE task_id = $1 AND driver_id = $2 LIMIT 1`;
    const dtRes = await pool.query(dtQ, [taskId, req.user.id]);
    if (dtRes.rowCount === 0) {
      return res.status(404).json({ message: "Task not found for this driver" });
    }

    const now = new Date().toISOString();
    const updates = [];
    const vals = [];
    let idx = 1;

    if (status) {
      updates.push(`status = $${idx++}`);
      vals.push(status);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${idx++}`);
      vals.push(JSON.stringify(notes));
    }
    if (status === 'completed') {
      updates.push(`completed_at = $${idx++}`);
      vals.push(completedAt || now);
    }

    if (updates.length > 0) {
      const updQ = `UPDATE driver_tasks SET ${updates.join(', ')}, assigned_at = COALESCE(assigned_at, CURRENT_TIMESTAMP) WHERE task_id = $${idx} AND driver_id = $${idx + 1} RETURNING *`;
      vals.push(taskId, req.user.id);
      const updRes = await pool.query(updQ, vals);

      // Update parent task status when completed
      if (status === 'completed') {
        await pool.query(`UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [taskId]);
        // Reset the corresponding bin's fill level to 0 when task is completed
        try {
          const bRes = await pool.query(`SELECT bin_id FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
          const binId = bRes.rows[0]?.bin_id;
          if (binId) {
            // Set fill_level to 0 and set status to 'filling' so simulator resumes
            const updBinRes = await pool.query(`UPDATE bins SET fill_level = 0, status = 'filling', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [binId]);
            const updatedBin = updBinRes.rows[0];

            // Notify connected clients in the society and admins/super admins
            try {
              if (updatedBin && updatedBin.society) {
                websocketService.sendToSociety(updatedBin.society, 'bins:update', [updatedBin]);
              }
              websocketService.sendToRole('admin', 'bins:update', [updatedBin]);
              websocketService.sendToRole('super_admin', 'bins:update', [updatedBin]);
            } catch (wsErr) {
              console.error('Failed to send websocket bin update', wsErr);
            }
          }
        } catch (e) {
          console.error('Failed to reset bin fill_level for task', taskId, e);
        }
      } else if (status) {
        // reflect intermediate statuses if needed
        await pool.query(`UPDATE tasks SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, taskId]);
      }

      // Insert an event record
      const eventPayload = {
        status,
        notes: notes || null,
        location: location || null,
        actor: req.user.id,
      };
      await pool.query(`INSERT INTO task_events (task_id, event_type, payload, created_by) VALUES ($1, $2, $3, $4)`, [taskId, status || 'updated', JSON.stringify(eventPayload), req.user.id]);

      const updatedTask = updRes.rows[0];

      if (req.user.role === "sub_admin") {
        await logSubAdminActivity({
          subAdmin: req.user.id,
          activityType: "UPDATE_TASK_STATUS",
          description: `Sub Admin ${req.user.id} updated task status ${Date.now()}`,
        });
      }

      return res.status(200).json({ message: "Task status updated successfully", task: updatedTask });
    }

    return res.status(400).json({ message: "No valid fields to update" });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error updating task status:", error);
    return res.status(status).json({ message: error.message });
  }
};

const updateDriverLocation = async (req, res) => {
  try {
    requireRole(req.user, ["driver"]);

    const { latitude, longitude, accuracy, heading, speed } = req.body;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return res.status(400).json({ message: "latitude and longitude are required as numbers" });
    }
    // Verify driver account is verified
    const driverVerified = await pool.query(
      `SELECT 1, society_id FROM users WHERE id = $1 AND is_verified = true`,
      [req.user.id]
    );
    if (!driverVerified.rows.length) {
      return res.status(404).json({ message: "Driver not verified" });
    }

    // persist to driver_locations
    const insertQ = `INSERT INTO driver_locations (driver_id, latitude, longitude, heading, speed, recorded_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
    const recordedAt = timestamp || new Date().toISOString();
    const insertRes = await pool.query(insertQ, [req.user.id, latitude, longitude, req.body.heading || null, req.body.speed || null, recordedAt]);
    const locationData = insertRes.rows[0];

    // broadcast to society and admins so dashboard updates in real-time
    try {
      const societyId = driverVerified.rows[0].society_id;
      websocketService.broadcastDriverLocation(req.user.id, societyId, locationData);
    } catch (e) {
      console.error('Failed to broadcast driver location', e);
    }

    if (req.user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "UPDATE_DRIVER_LOCATION",
        description: `Sub Admin ${req.user.id} updated driver location ${Date.now()}`,
      });
    }

    return res.status(200).json({
      message: "Location updated successfully",
      location: {
        driver_id: locationData.driver_id,
        latitude: parseFloat(locationData.latitude),
        longitude: parseFloat(locationData.longitude),
        recorded_at: locationData.recorded_at,
        is_active: locationData.is_active
      },
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error updating driver location:", error);
    return res.status(status).json({ message: error.message });
  }
};

const getDriverPerformance = async (req, res) => {
  try {
    const driverId = toInt(req.params.driverId, null);
    if (driverId === null) return res.status(400).json({ message: "Invalid driver id" });

    ensureSelfOrRole(req.user, driverId, ["admin", "sub_admin", "super_admin"]);

    const periodDays = toInt(req.query.period, 30);
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    // Count assigned tasks
    const assignedQ = `SELECT COUNT(*)::int AS cnt FROM driver_tasks WHERE driver_id = $1 AND assigned_at >= $2`;
    const assignedRes = await pool.query(assignedQ, [driverId, since]);
    const totalAssigned = assignedRes.rows[0] ? assignedRes.rows[0].cnt : 0;

    // Count completed tasks
    const completedQ = `SELECT COUNT(*)::int AS cnt FROM driver_tasks WHERE driver_id = $1 AND status = 'completed' AND completed_at >= $2`;
    const completedRes = await pool.query(completedQ, [driverId, since]);
    const totalCompleted = completedRes.rows[0] ? completedRes.rows[0].cnt : 0;

    // Average completion time (seconds)
    const avgQ = `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - assigned_at))) AS avg_seconds FROM driver_tasks WHERE driver_id = $1 AND status = 'completed' AND completed_at IS NOT NULL AND assigned_at IS NOT NULL AND completed_at >= $2`;
    const avgRes = await pool.query(avgQ, [driverId, since]);
    const avgSeconds = avgRes.rows[0] && avgRes.rows[0].avg_seconds ? parseFloat(avgRes.rows[0].avg_seconds) : null;

    const performanceData = {
      driver_id: driverId,
      period_days: periodDays,
      metrics: {
        total_assigned: parseInt(totalAssigned || 0, 10),
        total_completed: parseInt(totalCompleted || 0, 10),
        average_completion_time_seconds: avgSeconds,
      }
    };

    return res.status(200).json({ message: "Performance metrics retrieved successfully", performance: performanceData });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error fetching performance metrics:", error);
    return res.status(status).json({ message: error.message });
  }
};

const getCurrentTasks = async (req, res) => {
  try {
    requireRole(req.user, ["driver"]);

    // Get real assignments from database
    const assignments = await binAssignmentModel.getAssignmentsByDriver(
      req.user.id,
      null // Get all statuses except completed
    );

    // Filter out completed and cancelled
    const activeTasks = assignments.filter(
      a => a.status === 'pending' || a.status === 'in_progress'
    );

    // Format tasks for mobile app
    const tasks = activeTasks.map(assignment => ({
      id: assignment.id,
      bin_id: assignment.bin_id,
      bin_name: assignment.bin_name,
      task_type: "collection",
      priority: assignment.priority,
      status: assignment.status,
      location: {
        lat: parseFloat(assignment.bin_latitude),
        lng: parseFloat(assignment.bin_longitude),
        address: assignment.bin_address
      },
      fill_level: parseFloat(assignment.bin_fill_level),
      estimated_time: assignment.estimated_time_minutes
        ? `${assignment.estimated_time_minutes} minutes`
        : "N/A",
      distance_km: assignment.distance_km ? parseFloat(assignment.distance_km).toFixed(2) : null,
      assigned_at: assignment.assigned_at,
      society: assignment.bin_society
    }));
    // DEBUG: log authenticated user info to help diagnose missing tasks
    try {
      console.log('getCurrentTasks called by user:', {
        id: req.user?.id,
        role: req.user?.role,
        tokenPayload: req.user,
        query: req.query,
        params: req.params,
      });
    } catch (e) {
      console.log('Error logging getCurrentTasks debug info', e);
    }

    // Query real tasks assigned to this driver
    const q = `
      SELECT
        dt.id as driver_task_id,
        dt.task_id,
        COALESCE(dt.status, 'assigned') as driver_task_status,
        dt.assigned_at,
        dt.accepted_at,
        dt.completed_at,
        t.id as id,
        t.bin_id,
        t.fill_level,
        t.priority,
        t.status as task_status,
        t.notes as task_notes,
        t.created_at as task_created_at,
        b.name as bin_name,
        b.address as bin_address,
        b.latitude as bin_latitude,
        b.longitude as bin_longitude
      FROM driver_tasks dt
      JOIN tasks t ON dt.task_id = t.id
      LEFT JOIN bins b ON t.bin_id = b.id
      WHERE dt.driver_id = $1
        AND COALESCE(dt.status, 'assigned') != 'completed'
      ORDER BY dt.assigned_at DESC
    `;

    const result = await pool.query(q, [req.user.id]);

    const currentTasks = result.rows.map((r) => ({
      id: r.id,
      driver_task_id: r.driver_task_id,
      bin_id: r.bin_name || `BIN_${r.bin_id}`,
      task_type: (r.task_notes && r.task_notes.type) || 'collection',
      priority: r.priority || 'normal',
      status: r.driver_task_status || r.task_status || 'assigned',
      location: {
        lat: r.bin_latitude || null,
        lng: r.bin_longitude || null,
        address: r.bin_address || null,
      },
      estimated_time: (r.task_notes && r.task_notes.estimated_time) || null,
      fill_level: r.fill_level || 0,
      assigned_at: r.assigned_at,
      accepted_at: r.accepted_at,
      completed_at: r.completed_at,
    }));

    return res.status(200).json({
      message: "Current tasks retrieved successfully",
      tasks,
      count: tasks.length,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error fetching current tasks:", error);
    return res.status(status).json({ message: error.message });
  }
};

const getDriverSchedule = async (req, res) => {
  try {
    const driverId = toInt(req.params.driverId, null);
    if (driverId === null) return res.status(400).json({ message: "Invalid driver id" });

    ensureSelfOrRole(req.user, driverId, ["admin", "sub_admin", "super_admin"]);

    const targetDate = req.query.date || new Date().toISOString().split("T")[0];

    // Stub schedule
    const schedule = {
      date: targetDate,
      driver_id: driverId,
      shifts: [
        {
          id: 1,
          start_time: "08:00",
          end_time: "12:00",
          work_area: "Sector A",
          estimated_collections: 15,
          route_distance: "8.5 km",
          status: "scheduled"
        },
        {
          id: 2,
          start_time: "14:00",
          end_time: "17:00",
          work_area: "Sector B",
          estimated_collections: 12,
          route_distance: "6.2 km",
          status: "scheduled"
        }
      ],
      total_working_hours: 7,
      break_time: "12:00-14:00"
    };

    return res.status(200).json({
      message: "Driver schedule retrieved successfully",
      schedule,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error fetching driver schedule:", error);
    return res.status(status).json({ message: error.message });
  }
};

const completeTask = async (req, res) => {
  try {
    requireRole(req.user, ["driver"]);

    const taskId = toInt(req.params.taskId, null);
    if (taskId === null) {
      return res.status(400).json({ message: "taskId is required" });
    }

    const { notes, collection_weight } = req.body;

    // Verify assignment belongs to this driver
    const assignment = await binAssignmentModel.getAssignmentById(taskId);
    if (!assignment) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (assignment.driver_id !== req.user.id) {
      return res.status(403).json({ message: "This task is not assigned to you" });
    }

    if (assignment.status === 'completed') {
      return res.status(400).json({ message: "Task already completed" });
    }

    // Complete the assignment using the service
    const completedAssignment = await binAssignmentService.completeAssignment(
      taskId,
      { notes, collection_weight }
    );

    return res.status(200).json({
      message: "Task completed successfully",
      task: {
        id: completedAssignment.id,
        bin_id: completedAssignment.bin_id,
        status: completedAssignment.status,
        completed_at: completedAssignment.completed_at,
        notes: completedAssignment.notes,
        collection_weight: completedAssignment.collection_weight
      },
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Error completing task:", error);
    return res.status(status).json({ message: error.message });
  }
};

module.exports = {
  //addDriver,
  getDrivers,
  updateDriver,
  deleteDriver,
  assignWorkArea,
  getDriverWorkAreas,
  getCollectionRoutes,
  updateTaskStatus,
  updateDriverLocation,
  getDriverPerformance,
  getCurrentTasks,
  getDriverSchedule,
  completeTask
};
