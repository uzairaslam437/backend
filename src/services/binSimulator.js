const binModel = require('../models/bin');
const websocketService = require('./websocketService');
const binAssignmentService = require('./binAssignmentService');

let intervalHandle = null;

// Default tick interval (ms)
const TICK_MS = process.env.BIN_SIM_TICK_MS ? parseInt(process.env.BIN_SIM_TICK_MS) : 5000;
// Default fill duration (ms) ~ 60s
const FILL_DURATION_MS = process.env.BIN_FILL_DURATION_MS ? parseInt(process.env.BIN_FILL_DURATION_MS) : 60000;

function computeDeltaPerTick() {
  const ticks = Math.max(1, Math.round(FILL_DURATION_MS / TICK_MS));
  return 100 / ticks;
}

async function tick() {
  try {
    const bins = await binModel.getBins();
    const delta = computeDeltaPerTick();
    const updates = [];

    for (const b of bins) {
      let fill = parseFloat(b.fill_level) || 0;
      let status = b.status || 'filling';

      if (status === 'idle') {
        status = 'filling';
      }

      if (status === 'filling') {
        fill = Math.min(100, fill + delta);
        if (fill >= 100) status = 'full';
      }

      // keep distances as FAILED unless valid_sensors > 0
      let distances = b.distances || { d1: 'FAILED', d2: 'FAILED', d3: 'FAILED', d4: 'FAILED' };
      let valid_sensors = b.valid_sensors || 0;
      let avg_distance = b.avg_distance || 'N/A';

      // Optionally simulate sensors becoming available when fill>10
      if (fill > 10 && valid_sensors === 0) {
        valid_sensors = 1; // now at least one sensor
        distances = { d1: 50, d2: 52, d3: 48, d4: 49 };
        avg_distance = ((50 + 52 + 48 + 49) / 4).toFixed(2);
      }

      // Simulate smoke slightly varying
      let smoke = b.smoke_level || 61;
      smoke = Math.max(0, Math.round(smoke + (Math.random() * 3 - 1)));

      const updatesForBin = {
        fill_level: parseFloat(fill.toFixed(2)),
        status,
        distances,
        valid_sensors,
        avg_distance,
        smoke_level: smoke,
      };

      // persist
      const updated = await binModel.updateBin(b.id, updatesForBin);
      updates.push(updated);

      // Auto-assign if bin reaches 80% or above
      if (fill >= 80 && b.fill_level < 80) {
        console.log(`Bin ${b.id} reached ${fill}% - triggering auto-assignment`);
        try {
          await binAssignmentService.autoAssignBins(b.id);
        } catch (assignError) {
          console.error(`Failed to auto-assign bin ${b.id}:`, assignError);
        }
      }
    }

    if (updates.length > 0) {
      websocketService.sendToAll('bins:update', updates);
    }
  } catch (err) {
    console.error('Bin simulator tick error:', err);
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(tick, TICK_MS);
  console.log(`Bin simulator started, tick=${TICK_MS}ms, fillDuration=${FILL_DURATION_MS}ms`);
}

function stop() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop };
