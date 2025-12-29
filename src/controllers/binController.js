const binModel = require('../models/bin');
const websocketService = require('../services/websocketService');
const { pool } = require('../config/db');
const assignmentService = require('../services/assignmentService');

const createBin = async (req, res) => {
  try {
    // Only super_admin can create bins
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admin can create bins' });
    }
    const bin = await binModel.createBin(req.body);
    // emit new bin
    websocketService.sendToAll('bins:created', bin);
    res.json({ success: true, data: bin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const listBins = async (req, res) => {
  try {
    let bins;
    // Super admin sees all bins, admin sees all bins (will be filtered on frontend by society)
    bins = await binModel.getBins();
    res.json({ success: true, data: bins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};


const getBin = async (req, res) => {
  try {
    const bin = await binModel.getBinById(req.params.id);
    if (!bin) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: bin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const updateBin = async (req, res) => {
  try {
    const bin = await binModel.updateBin(req.params.id, req.body);
    websocketService.sendToAll('bins:updated', bin);

    // LOGGING: Save to bin_logs
    try {
        const logQ = `INSERT INTO bin_logs (bin_id, fill_level, temperature, humidity, smoke_level, recorded_at) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`;
        await pool.query(logQ, [bin.id, bin.fill_level, bin.temperature, bin.humidity, bin.smoke_level]);
    } catch (logErr) {
        console.error("Failed to log bin update:", logErr);
    }

    // AUTO-TASK CREATION & COMPLETION Logic
    try {
        await assignmentService.checkAndCreateTask(bin, websocketService);
        await assignmentService.checkAndCompleteTask(bin, websocketService);
    } catch (taskErr) {
        console.error("Error in auto-task logic:", taskErr);
    }

    res.json({ success: true, data: bin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const removeBin = async (req, res) => {
  try {
    // Only super_admin can delete bins
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admin can delete bins' });
    }
    await binModel.deleteBin(req.params.id);
    websocketService.sendToAll('bins:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createBin,
  listBins,
  getBin,
  updateBin,
  removeBin,
};

