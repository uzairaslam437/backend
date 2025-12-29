const express = require('express');
const Router = express.Router();
const { 
  createTask, 
  getDriverTasks, 
  updateTaskStatus, 
  postDriverLocation,
  getSocietyDriverLocations,
  getAllDriverLocations,
  getTaskDetails
} = require('../controllers/taskController');

// Task endpoints
Router.post('/', createTask); // POST /tasks - create a new task (auto-assign attempted)
Router.get('/:id', getTaskDetails); // GET /tasks/:id - get task details with history

// Driver endpoints
Router.get('/driver/:id', getDriverTasks); // GET /tasks/driver/:id - list driver's assigned tasks
Router.post('/:id/status', updateTaskStatus); // POST /tasks/:id/status - update task status
Router.post('/location', postDriverLocation); // POST /tasks/location - post driver location (legacy, use /drivers/:id/location)

// Admin endpoints (for map views)
Router.get('/admin/societies/:societyId/drivers/locations', getSocietyDriverLocations); // GET drivers in society
Router.get('/admin/drivers', getAllDriverLocations); // GET all drivers (superadmin)

// Mobile driver location endpoint (cleaner naming)
Router.post('/driver/:id/location', postDriverLocation); // POST /tasks/driver/:id/location - post driver location

module.exports = Router;
