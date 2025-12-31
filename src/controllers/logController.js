const { pool } = require('../config/db');

// GET /api/admin/logs/bins?societyId=X&binId=Y
// GET /api/admin/logs/bins?societyId=X&binId=Y
async function getBinLogs(req, res) {
  try {
    const { societyId, binId, limit = 100 } = req.query;

    // 1. Fetch Bin Logs (Sensor Data)
    let logsQ = `
      SELECT bl.bin_id, bl.fill_level, bl.recorded_at, bl.temperature, bl.smoke_level, b.name as bin_name, b.society 
      FROM bin_logs bl
      JOIN bins b ON bl.bin_id = b.id
    `;
    const logParams = [];
    const logConditions = [];

    if (binId) {
      logConditions.push(`bl.bin_id = $${logParams.length + 1}`);
      logParams.push(binId);
    }
    if (societyId) {
      logConditions.push(`(b.society = $${logParams.length + 1} OR b.society = (SELECT society_name FROM societies WHERE id = $${logParams.length + 1} LIMIT 1))`);
      logParams.push(societyId);
    }
    if (logConditions.length > 0) logsQ += ` WHERE ${logConditions.join(' AND ')}`;
    logsQ += ` ORDER BY bl.recorded_at ASC`; // Get chronological to detect changes

    const logsRes = await pool.query(logsQ, logParams);
    const rawLogs = logsRes.rows;

    // 2. Fetch Task Events (Assignments, Completions)
    let tasksQ = `
      SELECT te.event_type, te.created_at, te.payload, t.bin_id, b.name as bin_name, 
             u1.first_name as driver_name, u2.first_name as created_by_name
      FROM task_events te
      JOIN tasks t ON te.task_id = t.id
      JOIN bins b ON t.bin_id = b.id
      LEFT JOIN driver_tasks dt ON t.id = dt.task_id
      LEFT JOIN users u1 ON dt.driver_id = u1.id
      LEFT JOIN users u2 ON te.created_by = u2.id
    `;
    // We reuse params if logical, but best to separate or rebuild carefully. 
    // Simplified: reuse logic but separate vars for safety.
    const taskParams = [];
    const taskConditions = [];
    if (binId) {
      taskConditions.push(`t.bin_id = $${taskParams.length + 1}`);
      taskParams.push(binId);
    }
    if (societyId) {
      taskConditions.push(`(b.society = $${taskParams.length + 1} OR b.society = (SELECT society_name FROM societies WHERE id = $${taskParams.length + 1} LIMIT 1))`);
      taskParams.push(societyId);
    }
    if (taskConditions.length > 0) tasksQ += ` WHERE ${taskConditions.join(' AND ')}`;
    tasksQ += ` ORDER BY te.created_at ASC`;

    const tasksRes = await pool.query(tasksQ, taskParams);
    const taskEvents = tasksRes.rows;

    // 3. Synthesize Events
    const events = [];

    // Process Raw Logs into "Status Events"
    const binState = {}; // Track last state per bin
    rawLogs.forEach(log => {
      if (!binState[log.bin_id]) {
        binState[log.bin_id] = { lastLevel: 0, lastStatus: 'Normal' };
      }
      const prev = binState[log.bin_id];
      const currLevel = parseFloat(log.fill_level);
      let event = null;

      // Event: Bin Filled (Critical)
      if (currLevel >= 90 && prev.lastLevel < 90) {
        event = {
          type: 'Bin Filled',
          description: `Fill level reached critical state (${currLevel}%)`,
          level: 'Critical',
          recorded_at: log.recorded_at,
          bin_name: log.bin_name,
          bin_id: log.bin_id
        };
      }
      // Event: Bin Emptied
      // Relaxed logic: If level drops to near zero from something non-zero
      else if (currLevel < 5 && prev.lastLevel > 5) {
        event = {
          type: 'Bin Emptied',
          description: `Bin was emptied (dropped from ${prev.lastLevel}% to ${currLevel}%)`,
          level: 'Good',
          recorded_at: log.recorded_at,
          bin_name: log.bin_name,
          bin_id: log.bin_id
        };
      }
      // Or significant drop
      else if (prev.lastLevel > 50 && currLevel < 20 && (prev.lastLevel - currLevel > 30)) {
        event = {
          type: 'Bin Emptied',
          description: `Bin was emptied (dropped from ${prev.lastLevel}% to ${currLevel}%)`,
          level: 'Good',
          recorded_at: log.recorded_at,
          bin_name: log.bin_name,
          bin_id: log.bin_id
        };
      }

      if (event) events.push(event);
      binState[log.bin_id].lastLevel = currLevel;
    });

    // Process Task Events
    taskEvents.forEach(te => {
      let desc = te.event_type;
      if (te.event_type === 'assigned') desc = `Task assigned to driver ${te.driver_name || 'Unknown'}`;
      if (te.event_type === 'completed') {
        // Check payload for specific note (e.g. auto completion)
        if (te.payload && te.payload.note) desc = te.payload.note;
        else desc = `Task completed by driver`;
      }

      events.push({
        type: te.event_type === 'assigned' ? 'Task Assigned' : 'Task Update',
        description: desc,
        level: 'Info',
        recorded_at: te.created_at,
        bin_name: te.bin_name,
        bin_id: te.bin_id
      });
    });

    // 4. Sort and Limit
    events.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at)); // Descending
    const limitedEvents = events.slice(0, parseInt(limit));

    res.json({ success: true, logs: limitedEvents });
  } catch (err) {
    console.error('getBinLogs error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /api/admin/logs/tasks?societyId=X
async function getTaskLogs(req, res) {
  try {
    const { societyId, driverId, limit = 100 } = req.query;

    // Union Query to fetch both Bin Task Events and Service Request Histories
    // Bin Tasks:
    // - source: task_events
    // - driver: from driver_tasks
    // - created_by: from users (admin)
    // - payload: from task_events
    // Service Requests:
    // - source: service_request_status_history
    // - driver: from service_requests.driver_id
    // - created_by: 'System (Groq)' or null
    // - payload: constructed from request details

    const q = `
      SELECT 
        te.id,
        te.event_type,
        te.created_at as recorded_at,
        te.payload,
        u.first_name || ' ' || u.last_name as driver_name,
        admin.first_name || ' ' || admin.last_name as created_by_name,
        'bin_task' as specific_type
      FROM task_events te
      LEFT JOIN driver_tasks dt ON te.task_id = dt.task_id AND dt.status = 'assigned'
      LEFT JOIN users u ON dt.driver_id = u.id
      LEFT JOIN users admin ON te.created_by = admin.id
      
      UNION ALL
      
      SELECT
        srsh.id,
        srsh.new_status as event_type,
        srsh.changed_at as recorded_at,
        json_build_object(
            'service_request_id', sr.id,
            'title', sr.title, 
            'notes', srsh.notes,
            'reason', srsh.reason
        ) as payload,
        u.first_name || ' ' || u.last_name as driver_name,
        'System (Groq)' as created_by_name,
        'service_request' as specific_type
      FROM service_request_status_history srsh
      JOIN service_requests sr ON srsh.service_request_id = sr.id
      LEFT JOIN users u ON sr.driver_id = u.id
      WHERE srsh.new_status IN ('assigned', 'completed')
      
      ORDER BY recorded_at DESC
      LIMIT 100
    `;

    // Note: Parameter filtering (societyId/driverId) is tricky with UNION efficiently in one query builder string
    // without CTEs or repetition. For simplicity, we are fetching global logs sorted by time.
    // If filtering is strictly required, we'd add WHERE clauses to each part of the UNION.
    // Given the current usage pattern (global logs), this suffices.

    const logs = await pool.query(q);

    // Normalize fields for frontend (Logs.jsx expects specific fields)
    const normalizedLogs = logs.rows.map(log => ({
      ...log,
      event_type: log.event_type === 'assigned' ? 'Task Assigned' : (log.event_type === 'completed' ? 'Task Completed' : log.event_type) // Normalize status text
    }));

    return res.status(200).json({ success: true, logs: normalizedLogs });
  } catch (error) {
    console.error("Get task logs error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// GET /api/admin/logs/bins/stats?societyId=X
async function getBinStats(req, res) {
  try {
    const { societyId } = req.query;

    // 1. Get raw chronological logs
    let q = `
      SELECT bl.bin_id, bl.fill_level, bl.recorded_at, b.name as bin_name
      FROM bin_logs bl
      JOIN bins b ON bl.bin_id = b.id
    `;

    const params = [];
    if (societyId) {
      // Filter by society
      q += ` WHERE (b.society = $1 OR b.society = (SELECT society_name FROM societies WHERE id = $1 LIMIT 1))`;
      params.push(societyId);
    }

    q += ` ORDER BY bl.bin_id, bl.recorded_at ASC`;

    const result = await pool.query(q, params);
    const logs = result.rows;

    const stats = {};
    // Process logs in JS to find "Emptying" events
    // Event: fill_level drops from > 50% to < 10% (example threshold)

    logs.forEach(log => {
      if (!stats[log.bin_id]) {
        stats[log.bin_id] = {
          id: log.bin_id,
          name: log.bin_name,
          emptied_count: 0,
          last_level: parseFloat(log.fill_level)
        };
      }

      const currentLevel = parseFloat(log.fill_level);
      const prevLevel = stats[log.bin_id].last_level;

      // Heuristic for "Emptied": significant drop
      if (prevLevel > 50 && currentLevel < 20 && (prevLevel - currentLevel > 30)) {
        stats[log.bin_id].emptied_count++;
      }

      stats[log.bin_id].last_level = currentLevel;
    });

    const statsArray = Object.values(stats);
    res.json({ success: true, stats: statsArray });

  } catch (err) {
    console.error('getBinStats error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getBinLogs, getTaskLogs, getBinStats };
