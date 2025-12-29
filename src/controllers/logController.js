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

    let q = `
      SELECT te.*, t.society_id, t.bin_id, 
             u1.first_name as created_by_name, 
             u2.first_name as driver_name 
      FROM task_events te
      JOIN tasks t ON te.task_id = t.id
      LEFT JOIN users u1 ON te.created_by = u1.id
      LEFT JOIN driver_tasks dt ON t.id = dt.task_id
      LEFT JOIN users u2 ON dt.driver_id = u2.id
    `;

    const params = [];
    const conditions = [];

    if (societyId) {
      conditions.push(`t.society_id = $${params.length + 1}`);
      params.push(societyId);
    }

    if (driverId) {
      conditions.push(`dt.driver_id = $${params.length + 1}`);
      params.push(driverId);
    }

    if (conditions.length > 0) {
      q += ` WHERE ${conditions.join(' AND ')}`;
    }

    q += ` ORDER BY te.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(q, params);
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error('getTaskLogs error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
