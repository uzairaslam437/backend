const express = require("express");
const http = require("http");
const cors = require("cors");
const morgan = require("morgan");
const bodyParser = require('body-parser');

// Load environment variables
require("dotenv").config();

// Import services and config
const websocketService = require("./services/websocketService");

// Import middleware
const { verifyToken } = require("./middlewares/authMiddleware");

// Import routes
const authRouter = require("./routes/authRoutes");
const vehicleRouter = require("./routes/vehicleRoutes");
const superAdminVehicleRouter = require("./routes/superAdminVehicleRoutes");
const societyRouter = require("./routes/societyRoutes");
const licenseRouter = require("./routes/licenseRoutes");
const driverRouter = require("./routes/driverRoutes");
const alertRouter = require("./routes/alertRoutes");
const serviceRouter = require("./routes/residentServiceRoutes");
const chatRouter = require("./routes/chatRoutes");
const analyticsRouter = require("./routes/analyticsRoutes");
const subAdminRouter = require("./routes/subAdminRoutes");
const systemFeedbackRouter = require("./routes/systemFeedbackRoutes");
const sentimentAnalyticsRouter = require("./routes/sentimentAnalyticsRoutes");
const binRouter = require("./routes/binRoutes");
const binSimulator = require("./services/binSimulator");

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);

// Initialize unified WebSocket service (handles both alerts and chat)
websocketService.initialize(server);

// Middleware
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Routes
app.use("/auth", authRouter);
app.use("/vehicle", verifyToken, vehicleRouter);
app.use("/super-admin/vehicle", verifyToken, superAdminVehicleRouter);
app.use("/society", verifyToken, societyRouter);
app.use("/license", verifyToken, licenseRouter);
app.use("/driver", verifyToken, driverRouter);
app.use("/alerts", verifyToken, alertRouter);
app.use("/services", verifyToken, serviceRouter);
app.use("/chat", verifyToken, chatRouter);
app.use("/analytics", verifyToken, analyticsRouter);
app.use("/sub-admin", verifyToken, subAdminRouter);
app.use("/feedback/system", verifyToken, systemFeedbackRouter);
app.use("/analytics/sentiment", verifyToken, sentimentAnalyticsRouter);

const taskRouter = require("./routes/taskRoutes");
const logRouter = require("./routes/logRoutes");

// ...

// Bins routes (requires authentication)
app.use("/bins", verifyToken, binRouter);
app.use("/tasks", verifyToken, taskRouter);
app.use("/logs", verifyToken, logRouter);


// Health endpoints
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    websocket: websocketService.healthCheck(),
  });
});

app.get("/websocket/stats", verifyToken, (req, res) => {
  if (req.user.role !== "super_admin" || req.user.role !== "admin" || req.user.role !== "sub_admin") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const stats = websocketService.getConnectionStats();
  res.json({
    success: true,
    data: stats,
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server is running on PORT:${PORT}`);
  // start bin simulator
  try {
    binSimulator.start();
  } catch (err) {
    console.error('Failed to start bin simulator', err);
  }
});