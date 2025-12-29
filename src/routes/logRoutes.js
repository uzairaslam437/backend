const express = require('express');
const router = express.Router();
const logController = require('../controllers/logController');
const { verifyToken, verifyAdmin } = require('../middlewares/authMiddleware'); // Assuming middleware exists

// Admin only routes
router.get('/bins',  logController.getBinLogs);
router.get('/bins/stats', logController.getBinStats);
router.get('/tasks',  logController.getTaskLogs);

module.exports = router;
