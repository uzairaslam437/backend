const { pool } = require('../config/db');
const groqService = require('./groqService');

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getCandidateDrivers(societyId) {
  const q = `SELECT id, first_name, last_name, phone_number, society_id FROM users WHERE role='driver' AND society_id = $1 AND is_blocked = false`;
  const res = await pool.query(q, [societyId]);
  return res.rows;
}

async function getLatestLocation(driverId) {
  const q = `SELECT latitude, longitude, recorded_at FROM driver_locations WHERE driver_id = $1 ORDER BY recorded_at DESC LIMIT 1`;
  const res = await pool.query(q, [driverId]);
  return res.rows[0] || null;
}

async function getActiveTaskCount(driverId) {
  const q = `SELECT COUNT(*)::int as cnt FROM driver_tasks dt JOIN tasks t ON dt.task_id = t.id WHERE dt.driver_id = $1 AND t.status IN ('assigned','accepted','enroute')`;
  const res = await pool.query(q, [driverId]);
  return res.rows[0] ? parseInt(res.rows[0].cnt) : 0;
}

function isDriverOnline(recordedAt) {
  if (!recordedAt) return false;
  const diffMs = new Date() - new Date(recordedAt);
  return diffMs < 15 * 60 * 1000;
}

async function findBestDriverAI(societyId, binLat, binLon, fillLevel) {
  let candidates = await getCandidateDrivers(societyId);

  if (!candidates || candidates.length === 0) return null;
  // Build full driver list to send to Gemini, include drivers even if they lack recent location
  const driversForAI = [];
  for (const d of candidates) {
    const loc = await getLatestLocation(d.id);
    const workload = await getActiveTaskCount(d.id);

    driversForAI.push({
      id: d.id,
      first_name: d.first_name,
      last_name: d.last_name,
      name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
      latitude: loc && loc.latitude ? parseFloat(loc.latitude) : null,
      longitude: loc && loc.longitude ? parseFloat(loc.longitude) : null,
      recorded_at: loc ? loc.recorded_at : null,
      active_tasks: workload,
      society_id: d.society_id
    });
  }

  const context = {
    bin: {
      latitude: binLat,
      longitude: binLon,
      fill_level: fillLevel,
      society_id: societyId
    },
    drivers: driversForAI
  };

  console.log("Requesting AI (Groq) for optimal driver...");
  const aiResult = await groqService.getOptimalDriver(context);
  console.log("🤖 Groq AI Response:", JSON.stringify(aiResult, null, 2));

  if (aiResult && aiResult.driver_id) {
    // Find selected driver from the full candidate list (may lack live location)
    const candidate = driversForAI.find(c => c.id == aiResult.driver_id) || null;
    if (candidate) {
      return {
        driver: {
          id: candidate.id,
          first_name: candidate.first_name,
          last_name: candidate.last_name,
          latitude: candidate.latitude,
          longitude: candidate.longitude
        },
        score: 0,
        reason: aiResult.reason || null,
        isAI: true
      };
    }
  }

  return null;
}

async function findBestDriver(societyId, binLat, binLon) {
  const candidates = await getCandidateDrivers(societyId);
  if (!candidates || candidates.length === 0) return null;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const d of candidates) {
    let loc = await getLatestLocation(d.id);
    const workload = await getActiveTaskCount(d.id);

    // MOCK LOCATION FALLBACK (User Request for Testing)
    // MOCK LOCATION FALLBACK REMOVED - Using Real-Time Data
    if (!loc || !loc.latitude) {
      // Driver has no location history yet
      console.log(`[DEBUG] ⚠️ No location data for Driver ${d.id}. Skipping.`);
      continue;
    }

    // TEMPORARILY DISABLED ONLINE CHECK
    // if (!loc || !loc.latitude || !loc.longitude || !isDriverOnline(loc.recorded_at)) {
    if (!loc || !loc.latitude || !loc.longitude) {
      continue;
    }

    let distance = 99999;
    distance = haversineDistance(parseFloat(loc.latitude), parseFloat(loc.longitude), parseFloat(binLat), parseFloat(binLon));

    const score = distance * 1 + workload * 50;
    if (score < bestScore) {
      bestScore = score;
      // include lat/lng on returned driver object
      best = { driver: { ...d, latitude: parseFloat(loc.latitude), longitude: parseFloat(loc.longitude) }, distance, workload, score };
    }
  }

  return best;
}

async function assignTask(taskId, assignedBy = null, wsService = null) {
  const taskQ = `SELECT t.id, t.bin_id, t.society_id, t.fill_level, t.priority, b.name as bin_name, b.latitude, b.longitude FROM tasks t LEFT JOIN bins b ON t.bin_id = b.id WHERE t.id = $1`;
  const tRes = await pool.query(taskQ, [taskId]);
  if (!tRes.rows[0]) return null;
  const task = tRes.rows[0];
  const binLat = task.latitude || 0;
  const binLon = task.longitude || 0;

  // Always attempt assignment via Groq AI first (no heuristic fallback)
  let best = null;
  try {
    best = await findBestDriverAI(task.society_id, binLat, binLon, task.fill_level);
  } catch (e) {
    console.error("AI assignment failed:", e);
  }

  if (!best) {
    console.log(`❌ Groq did not return a suitable driver for Task #${taskId}. Marking task as 'created' for retry.`);
    // Ensure task remains in 'created' status so retry logic can pick it up later
    await pool.query(`UPDATE tasks SET status = 'created', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [taskId]);
    return null;
  }

  console.log(`\n===============================================================`);
  console.log(`✅ TASk ASSIGNED SUCCESSFULLY`);
  console.log(`===============================================================`);
  console.log(`🆔 Task ID: ${taskId}`);
  console.log(`🚛 Driver:  ${best.driver.first_name} ${best.driver.last_name} (ID: ${best.driver.id})`);
  console.log(`📍 Location: [${best.driver.latitude}, ${best.driver.longitude}]`);
  console.log(`🤖 Method:  ${best.isAI ? 'Groq AI' : 'Heuristic (Distance)'}`);
  console.log(`📝 Reason:  ${best.reason || 'Calculated Score'}`);
  console.log(`===============================================================\n`);

  const insertQ = `INSERT INTO driver_tasks (task_id, driver_id, assigned_by, assigned_at, status) VALUES ($1,$2,$3,CURRENT_TIMESTAMP,'assigned') RETURNING *`;
  const insertRes = await pool.query(insertQ, [taskId, best.driver.id, assignedBy]);

  await pool.query(`UPDATE tasks SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [taskId]);

  const payload = {
    assigned_to: best.driver.id,
    distance_km: best.distance || 'N/A',
    workload: best.workload || 'N/A',
    driver_location: { latitude: best.driver.latitude, longitude: best.driver.longitude },
    method: best.isAI ? 'AI_OPTIMIZED' : 'HEURISTIC',
    reason: best.reason || 'Calculated Score'
  };

  const evQ = `INSERT INTO task_events (task_id, event_type, payload, created_by) VALUES ($1, 'assigned', $2, $3)`;
  await pool.query(evQ, [taskId, JSON.stringify(payload), assignedBy]);

  if (wsService) {
    wsService.sendTaskAssignmentToDriver(best.driver.id, {
      id: taskId,
      bin_name: task.bin_name,
      priority: task.priority,
      fill_level: task.fill_level
    });
  }

  return { assignment: insertRes.rows[0], driver: best.driver, score: best.score };
}

async function checkAndCreateTask(bin, websocketService) {
  const level = Number(bin.fill_level);

  // Lowered threshold to 90% to match "Critical" event logic
  if (level >= 90) {
    const activeTaskQ = `SELECT id, status FROM tasks WHERE bin_id = $1 AND status NOT IN ('completed', 'cancelled', 'failed') LIMIT 1`;
    const activeTaskRes = await pool.query(activeTaskQ, [bin.id]);

    if (activeTaskRes.rowCount === 0) {
      console.log(`[DEBUG] No active task found for Bin ${bin.id} (Level ${level}%). Creating new task...`);

      let society_id = null;
      if (typeof bin.society === 'number') society_id = bin.society;
      else if (bin.society) {
        const sRes = await pool.query(`SELECT id FROM societies WHERE society_name = $1 LIMIT 1`, [bin.society]);
        if (sRes.rows[0]) society_id = sRes.rows[0].id;
      }

      const insertQ = `INSERT INTO tasks (bin_id, society_id, fill_level, priority, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;
      const insertRes = await pool.query(insertQ, [bin.id, society_id, level, 'critical', JSON.stringify({ source: 'auto_trigger', reason: 'fill_level_critical' }), null]);
      const newTask = insertRes.rows[0];
      console.log(`[DEBUG] Task Created: ${newTask.id}`);

      console.log(`[DEBUG] Calling assignTask for Task ${newTask.id}...`);
      assignTask(newTask.id, null, websocketService)
        .then(result => {
          if (result) console.log(`[DEBUG] ✅ Auto-assigned task ${newTask.id} to driver ${result.driver.id}`);
          else console.log(`[DEBUG] ⚠️ Could not auto-assign task ${newTask.id} immediately.`);
        })
        .catch(err => console.error("[DEBUG] ❌ Error in auto-assignment:", err));

      return newTask;
    } else {
      const existingTask = activeTaskRes.rows[0];
      console.log(`[DEBUG] Active task found for Bin ${bin.id} (Task #${existingTask.id}, Status: ${existingTask.status}).`);

      // RETRY Logic: If status is 'created', it means previous assignment failed. Retry now.
      if (existingTask.status === 'created') {
        console.log(`[DEBUG] 🔄 Task #${existingTask.id} is 'created' but not assigned. Retrying assignment...`);
        assignTask(existingTask.id, null, websocketService)
          .then(result => {
            if (result) console.log(`[DEBUG] ✅ Retry-assigned task ${existingTask.id} to driver ${result.driver.id}`);
            else console.log(`[DEBUG] ⚠️ Retry assignment failed for task ${existingTask.id}.`);
          })
          .catch(err => console.error("[DEBUG] ❌ Error in retry-assignment:", err));
      }

      return null;
    }
  } else {
    // console.log(`[DEBUG] Bin ${bin.id} level ${level}% below threshold (90%).`); 
  }
  return null;
}

async function checkAndCompleteTask(bin, websocketService) {
  const level = Number(bin.fill_level);

  if (level < 10) {
    const activeTaskQ = `SELECT t.id, t.status, dt.driver_id FROM tasks t 
                         LEFT JOIN driver_tasks dt ON t.id = dt.task_id 
                         WHERE t.bin_id = $1 AND t.status IN ('assigned', 'accepted', 'enroute', 'in_progress') 
                         ORDER BY t.created_at DESC LIMIT 1`;
    const activeTaskRes = await pool.query(activeTaskQ, [bin.id]);

    if (activeTaskRes.rowCount > 0) {
      const task = activeTaskRes.rows[0];
      console.log(`[DEBUG] Bin ${bin.id} emptied (Level ${level}%). Completing active Task #${task.id}...`);

      await pool.query(`UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [task.id]);

      if (task.driver_id) {
        await pool.query(`UPDATE driver_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE task_id = $1 AND driver_id = $2`, [task.id, task.driver_id]);
      } else {
        await pool.query(`UPDATE driver_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE task_id = $1`, [task.id]);
      }

      const payload = {
        completion_type: 'auto_sensed',
        final_fill_level: level,
        note: 'Bin sensor reported empty.'
      };
      const evQ = `INSERT INTO task_events (task_id, event_type, payload, created_by) VALUES ($1, 'completed', $2, null)`;
      await pool.query(evQ, [task.id, JSON.stringify(payload)]);

      console.log(`[DEBUG] ✅ Task #${task.id} marked as completed.`);

      if (websocketService) {
        websocketService.sendToAll('tasks:updated', { id: task.id, status: 'completed', bin_id: bin.id });
      }
      return true;
    }
  }
  return false;
}

async function assignServiceRequest(requestId, wsService = null) {
  // 1. Fetch Request Details including location
  const q = `
    SELECT sr.*, ua.latitude, ua.longitude, u.society_id
    FROM service_requests sr
    JOIN user_addresses ua ON sr.address_id = ua.id
    JOIN users u ON sr.user_id = u.id
    WHERE sr.id = $1
  `;
  const res = await pool.query(q, [requestId]);
  if (res.rowCount === 0) return null;
  const request = res.rows[0];

  // 2. Find Best Driver
  const societyId = request.society_id;
  const lat = parseFloat(request.latitude);
  const lon = parseFloat(request.longitude);

  let best = null;
  try {
    // We reuse findBestDriverAI but we need to adapt it or create a new one.
    // Actually, findBestDriverAI is tightly coupled to bins (it expects bin object).
    // Let's create a specialized look-up here or refactor findBestDriverAI.
    // For now, let's replicate the logic but passing 'request' object to groqService.

    const candidates = await getCandidateDrivers(societyId);
    if (candidates && candidates.length > 0) {
      const driversForAI = [];
      for (const d of candidates) {
        const loc = await getLatestLocation(d.id);
        const workload = await getActiveTaskCount(d.id);
        driversForAI.push({
          id: d.id,
          first_name: d.first_name,
          last_name: d.last_name,
          name: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
          latitude: loc && loc.latitude ? parseFloat(loc.latitude) : null,
          longitude: loc && loc.longitude ? parseFloat(loc.longitude) : null,
          recorded_at: loc ? loc.recorded_at : null,
          active_tasks: workload,
          society_id: d.society_id
        });
      }

      const context = {
        request: {
          requestId: request.id,
          latitude: lat,
          longitude: lon,
          type: 'service_request',
          title: request.title
        },
        drivers: driversForAI
      };

      console.log("Requesting AI (Groq) for optimal driver for Service Request...");
      const aiResult = await groqService.getOptimalDriver(context);
      console.log("🤖 Groq AI Response (SR):", JSON.stringify(aiResult, null, 2));

      if (aiResult && aiResult.driver_id) {
        const candidate = driversForAI.find(c => c.id == aiResult.driver_id);
        if (candidate) {
          best = { driver: candidate, reason: aiResult.reason, isAI: true };
        }
      }
    }

  } catch (e) {
    console.error("AI assignment failed for Service Request:", e);
  }

  if (!best) {
    console.log(`❌ Groq did not return a suitable driver for Service Request #${requestId}.`);
    return null;
  }

  // 3. Assign Driver
  console.log(`✅ SERVICE REQUEST ASSIGNED: SR-${requestId} -> Driver ${best.driver.id}`);

  // Update Service Request
  await pool.query(
    `UPDATE service_requests SET driver_id = $1, status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [best.driver.id, requestId]
  );

  // Log History
  await pool.query(
    `INSERT INTO service_request_status_history (service_request_id, old_status, new_status, changed_by, reason) VALUES ($1, 'pending', 'assigned', null, $2)`,
    [requestId, `Auto-assigned by Groq AI: ${best.reason}`]
  );

  // Log Task Event (for unified logging)
  // We don't have a 'task_id' in tasks table for this, but we want it in system logs.
  // The system logs query joins on tasks table. 
  // IMPORTANT: The user wants "Task Assignments" section to display "both bins and service requests".
  // The current "Task Assignments" query in logController.js `getTaskLogs` joins on `tasks` table.
  // We can either:
  // A) Create a dummy task in `tasks` table for this service request (adapter pattern).
  // B) Update `getTaskLogs` to union `service_request_status_history` or similar.
  // C) Insert into `task_events` with a null task_id? No, `task_id` is NOT NULL usually or acts as FK.

  // Let's check `task_events` schema in `20251205000000_create_tasks_and_driver_tables.js`:
  // `task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`
  // So we cannot insert into `task_events` without a task.

  // To unify them easily on frontend without massive refactor, creating a "shadow task" in `tasks` table seems cleanest 
  // but `tasks` table requires `bin_id`. `bin_id` can be NULL? 
  // `bin_id INTEGER REFERENCES bins(id) ON DELETE SET NULL` -> Yes, can be null.

  // Let's create a wrapper task in `tasks` table so it shows up in logs and driver standard task flow if needed.
  // BUT the user said "Service requests... assigned to driver... displayed on driver screen". 
  // If we map it to a `task`, we get `driver_tasks` handling for free?
  // `driver_tasks` links to `tasks`.

  // However, `service_requests` table exists separate from `tasks`.
  // If we mirror it to `tasks`, we have two sources of truth. 
  // The user requirement says: "display both bins and service requests" in logs.

  // Let's stick to updating `service_requests` and handle the "Backend: Mobile: Display assigned tasks" by querying both tables in `driverController.js`.

  // For Logs: We will update `logController.js` to UNION the results.

  // Notify Driver via WebSocket
  if (wsService) {
    wsService.sendToUser(best.driver.id, 'service_requests:assigned', {
      id: requestId,
      title: request.title,
      latitude: lat,
      longitude: lon
    });
  }

  return best.driver;
}

module.exports = { findBestDriver, assignTask, checkAndCreateTask, checkAndCompleteTask, assignServiceRequest };
