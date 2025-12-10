const express = require('express');
const { getDrivers, updateDriver, deleteDriver, assignWorkArea, getDriverWorkAreas, getCollectionRoutes, getCurrentTasks, updateTaskStatus, updateDriverLocation, getDriverSchedule, getDriverPerformance, completeTask } = require('../controllers/driverController');
const { addAdminAndStaff } = require('../controllers/authController');

const router = express.Router();

router.post('/add-driver', addAdminAndStaff);
router.get('/get-drivers', getDrivers);
router.put('/update-driver/:id', updateDriver);
//DELETE DRIVER REMOVED
// router.delete('/delete-driver/:id', deleteDriver);
router.post('/assign-work-area', assignWorkArea);
router.get('/work-areas', getDriverWorkAreas);
router.get('/:driverId/routes', getCollectionRoutes);
router.get('/current-tasks', getCurrentTasks);
router.put('/tasks/:taskId/status', updateTaskStatus);
router.put('/location', updateDriverLocation);
router.get('/:driverId/schedule', getDriverSchedule);
router.get('/:driverId/performance', getDriverPerformance);
router.put('/tasks/:taskId/complete', completeTask);

module.exports = router;