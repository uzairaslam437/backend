# Task Management API - Documentation

This document describes the new task management and driver location tracking APIs integrated with real-time Socket.IO notifications.

## Overview

The system creates tasks when a bin is filled, automatically assigns them to the best available driver based on proximity and workload, and tracks task progress and driver locations in real-time.

## Database Schema

### New Tables

#### `tasks`
- `id` (PK)
- `bin_id` (FK to bins)
- `society_id` (FK to societies)
- `fill_level` (decimal)
- `priority` (varchar: normal, high, urgent)
- `status` (varchar: created, assigned, accepted, enroute, arrived, completed, failed)
- `created_by` (FK to users)
- `notes` (jsonb)
- `created_at`, `updated_at`

#### `driver_tasks` (Assignment Record)
- `id` (PK)
- `task_id` (FK to tasks)
- `driver_id` (FK to users)
- `assigned_at`
- `assigned_by` (FK to users)
- `accepted_at` (nullable)
- `completed_at` (nullable)
- `status` (varchar: assigned, accepted, enroute, arrived, completed, failed)
- `notes` (jsonb)

#### `task_events` (Audit Trail)
- `id` (PK)
- `task_id` (FK to tasks)
- `event_type` (varchar: assigned, status_update, photo_uploaded, etc.)
- `payload` (jsonb)
- `created_by` (FK to users)
- `created_at`

#### `driver_locations` (Real-time Location Trail)
- `id` (PK)
- `driver_id` (FK to users)
- `latitude`, `longitude` (decimal)
- `heading`, `speed` (double precision, optional)
- `recorded_at`

## API Endpoints

### Task Creation & Management

#### `POST /tasks` - Create Task
**Authentication:** Required (JWT Token)

**Body:**
```json
{
  "bin_id": 123,
  "fill_level": 85.5,
  "priority": "high",
  "notes": { "reason": "urgent collection" }
}
```

**Response:**
```json
{
  "success": true,
  "task": { "id": 1, "bin_id": 123, "society_id": 5, "status": "assigned", ... },
  "assignment": { 
    "assignment": { "id": 101, "task_id": 1, "driver_id": 15, "status": "assigned", ... },
    "driver": { "id": 15, "first_name": "Ali", "last_name": "Khan", "phone_number": "03001234567" },
    "score": 125.5
  }
}
```

**Description:** Creates a new task and automatically assigns it to the best available driver using the hybrid strategy.

---

#### `GET /tasks/:id` - Get Task Details
**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "task": { "id": 1, "bin_id": 123, "status": "enroute", ... },
  "assignment": { 
    "id": 101, 
    "task_id": 1, 
    "driver_id": 15, 
    "first_name": "Ali", 
    "phone_number": "03001234567" 
  },
  "events": [
    { "event_type": "assigned", "payload": { ... }, "created_at": "2025-12-05T10:00:00Z" },
    { "event_type": "status_update", "payload": { "status": "accepted" }, "created_at": "2025-12-05T10:05:00Z" }
  ]
}
```

---

### Driver Task Management

#### `GET /tasks/driver/:id` - List Driver Tasks
**Authentication:** Required

**Query Parameters:**
- `status` (optional): filter by status (assigned, accepted, enroute, completed)

**Response:**
```json
{
  "success": true,
  "tasks": [
    {
      "id": 101,
      "task_id": 1,
      "driver_id": 15,
      "status": "accepted",
      "assigned_at": "2025-12-05T10:00:00Z",
      "accepted_at": "2025-12-05T10:02:00Z",
      "bin_id": 123,
      "name": "Main Gate Bin",
      "address": "Sector 5, Society",
      "latitude": 33.9124,
      "longitude": 67.1910,
      "priority": "high"
    }
  ]
}
```

**Description:** Returns all assigned tasks for a driver (for mobile app).

---

#### `POST /tasks/:id/status` - Update Task Status
**Authentication:** Required

**Body:**
```json
{
  "status": "completed",
  "notes": "Bin emptied successfully",
  "photo_url": "https://cdn.example.com/photos/task_1_proof.jpg"
}
```

**Allowed Status Transitions:**
- `assigned` → `accepted` (driver accepts task)
- `accepted` → `enroute` (driver on the way)
- `enroute` → `arrived` (driver arrived at location)
- `arrived` → `completed` (task finished) OR `failed` (task failed)

**Response:**
```json
{
  "success": true,
  "driver_task": {
    "id": 101,
    "task_id": 1,
    "driver_id": 15,
    "status": "completed",
    "completed_at": "2025-12-05T10:30:00Z"
  }
}
```

---

### Driver Location Tracking

#### `POST /tasks/driver/:id/location` - Post Driver Location
**Authentication:** Required

**Body:**
```json
{
  "latitude": 33.9124,
  "longitude": 67.1910,
  "heading": 45.5,
  "speed": 25.3
}
```

**Response:**
```json
{
  "success": true,
  "location": {
    "id": 1001,
    "driver_id": 15,
    "latitude": 33.9124,
    "longitude": 67.1910,
    "heading": 45.5,
    "speed": 25.3,
    "recorded_at": "2025-12-05T10:15:30Z"
  }
}
```

**Description:** Records driver location. Automatically broadcasts to society admins via Socket.IO.

---

### Admin Map View APIs

#### `GET /tasks/admin/societies/:societyId/drivers/locations` - Get Society Drivers
**Authentication:** Required (Admin/SuperAdmin only)

**Response:**
```json
{
  "success": true,
  "drivers": [
    {
      "id": 15,
      "first_name": "Ali",
      "last_name": "Khan",
      "phone_number": "03001234567",
      "latitude": 33.9124,
      "longitude": 67.1910,
      "heading": 45.5,
      "speed": 25.3,
      "recorded_at": "2025-12-05T10:15:30Z",
      "active_tasks": 2
    }
  ]
}
```

**Description:** Gets all drivers in a specific society with their latest locations and active task counts.

---

#### `GET /tasks/admin/drivers` - Get All Drivers (SuperAdmin)
**Authentication:** Required (SuperAdmin only)

**Response:**
```json
{
  "success": true,
  "drivers": [
    {
      "id": 15,
      "first_name": "Ali",
      "society_id": 5,
      "society_name": "Green Valley Society",
      "latitude": 33.9124,
      "longitude": 67.1910,
      "active_tasks": 2,
      ...
    }
  ]
}
```

**Description:** Gets all drivers from all societies (SuperAdmin view).

---

## Socket.IO Real-Time Events

### Client Connection

```javascript
// Driver connects and goes online
socket.emit('driver-online', { driverId: 15 });

// Receive task assignment
socket.on('task-assigned', (data) => {
  console.log('New task:', data);
  // { taskId, binName, priority, fillLevel, assignedAt }
});

// Receive location update broadcasts (for admins)
socket.on('driver-location-update', (data) => {
  console.log('Driver location:', data);
  // { driverId, latitude, longitude, heading, speed, recordedAt }
});
```

### Event Types

#### `task-assigned`
**Emitted to:** Specific driver when task is assigned
**Payload:**
```javascript
{
  taskId: 1,
  binName: "Main Gate Bin",
  priority: "high",
  fillLevel: 85.5,
  assignedAt: "2025-12-05T10:00:00Z"
}
```

#### `driver-location-update`
**Emitted to:** Society room when driver updates location
**Payload:**
```javascript
{
  driverId: 15,
  latitude: 33.9124,
  longitude: 67.1910,
  heading: 45.5,
  speed: 25.3,
  recordedAt: "2025-12-05T10:15:30Z"
}
```

---

## Mobile App Integration

### Driver App Tasks

1. **Login & Online Status**
   ```javascript
   // On successful login, emit driver-online
   socket.emit('driver-online', { driverId: currentUser.id });
   ```

2. **Listen for Task Assignments**
   ```javascript
   socket.on('task-assigned', (task) => {
     // Show notification/popup
     showNotification(`New task: ${task.binName}`);
     // Fetch and update task list
     fetchDriverTasks();
   });
   ```

3. **Fetch Active Tasks**
   ```javascript
   GET /tasks/driver/:driverId
   // Use this to populate driver's task list
   ```

4. **Stream Location**
   ```javascript
   // Every 15-30 seconds while active
   POST /tasks/driver/:driverId/location
   {
     latitude: currentLocation.latitude,
     longitude: currentLocation.longitude,
     heading: currentHeading,
     speed: currentSpeed
   }
   ```

5. **Update Task Status**
   ```javascript
   POST /tasks/:taskId/status
   {
     "status": "accepted" | "enroute" | "arrived" | "completed",
     "notes": "...",
     "photo_url": "..."
   }
   ```

### Admin App Map Features

1. **Load Society Drivers**
   ```javascript
   GET /tasks/admin/societies/:societyId/drivers/locations
   // Plot drivers on map
   ```

2. **Listen to Live Location Updates**
   ```javascript
   socket.on('driver-location-update', (location) => {
     // Update driver marker position on map
   });
   ```

3. **Click on Driver to View**
   - Driver name, phone number
   - Current active tasks
   - Location and route history

---

## Assignment Strategy (Hybrid)

### Scoring Formula
```
Score = (distance_km * weight1) + (active_tasks_count * weight2)

Default weights:
- weight1 = 1 (distance)
- weight2 = 50 (workload)
```

### Constraints
1. Driver must be in same society
2. Driver must not be blocked
3. Driver must have an active location update (recent)

### Example Scenario
```
Task created for bin at (33.9124, 67.1910) in Society 5

Candidates:
- Driver A: 5 km away, 2 active tasks → score = 5*1 + 2*50 = 105
- Driver B: 12 km away, 0 active tasks → score = 12*1 + 0*50 = 12 ✓ (best)
- Driver C: 8 km away, 3 active tasks → score = 8*1 + 3*50 = 158

→ Task assigned to Driver B
→ Socket.IO notifies Driver B
```

---

## Error Handling

All endpoints return:
```json
{
  "success": false,
  "message": "Error description"
}
```

### Common Errors
- `400`: Missing required fields
- `403`: Unauthorized (not assigned to task, not admin, etc.)
- `404`: Resource not found
- `500`: Server error

---

## Migration & Setup

1. **Run migration to create tables:**
   ```bash
   npm run migrate
   # or
   npx knex migrate:latest
   ```

2. **Verify tables are created:**
   ```sql
   SELECT * FROM tasks;
   SELECT * FROM driver_tasks;
   SELECT * FROM task_events;
   SELECT * FROM driver_locations;
   ```

3. **Test endpoints:**
   ```bash
   # Create task
   curl -X POST http://localhost:3001/tasks \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"bin_id": 1, "fill_level": 85, "priority": "normal"}'

   # Get driver tasks
   curl -X GET http://localhost:3001/tasks/driver/15 \
     -H "Authorization: Bearer <token>"

   # Post location
   curl -X POST http://localhost:3001/tasks/driver/15/location \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"latitude": 33.9124, "longitude": 67.1910, "heading": 45, "speed": 20}'
   ```

---

## Performance Considerations

1. **Driver Locations Table:** Can grow large; consider:
   - TTL/retention policy (e.g., keep last 7 days)
   - Archival strategy
   - Partitioning by date

2. **Scoring Algorithm:** O(n) where n = drivers in society. Acceptable for typical society size (10-50 drivers).

3. **Socket.IO Scaling:** For large deployments:
   - Use Redis adapter: `npm install socket.io-redis`
   - Configure sticky sessions on load balancer

---

## Future Enhancements

- [ ] ML-based driver prediction model
- [ ] Route optimization for bulk tasks
- [ ] Geofencing-based auto-status updates
- [ ] Driver performance analytics dashboard
- [ ] Task reassignment on driver unavailability
- [ ] Proof of work (photos, signatures, weight measurements)
- [ ] SLA tracking and alerts
- [ ] Integration with third-party route optimization APIs

---

## Support & Troubleshooting

- **Task not assigned:** Check if drivers exist in society and have location data
- **Socket.IO not working:** Verify CORS origin matches frontend URL
- **Location not broadcast:** Ensure driver's society_id is set in users table
- **Query slow:** Check indexes on tasks, driver_tasks, driver_locations
