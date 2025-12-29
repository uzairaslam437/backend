const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

class WebSocketService {
    constructor() {
        this.io = null;
        this.connectedUsers = new Map(); // userId -> socketId
        this.userSockets = new Map(); // userId -> Set of socketIds
    }

    /**
     * Initialize WebSocket server
     */
    initialize(server) {
        this.io = new Server(server, {
            cors: {
                origin: process.env.FRONTEND_URL || "http://localhost:3000",
                methods: ["GET", "POST"]
            }
        });

        this.setupEventHandlers();
        console.log('WebSocket server initialized');
    }

    /**
     * Setup WebSocket event handlers
     */
    setupEventHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`Client connected: ${socket.id}`);

            // Handle JWT authentication (for chat system)
            this.handleJWTConnection(socket);

            // Handle user authentication (for alert system)
            socket.on('authenticate', (data) => {
                this.handleAuthentication(socket, data);
            });

            // Handle user joining society room
            socket.on('join-society', (data) => {
                this.handleJoinSociety(socket, data);
            });

            // Handle user leaving society room
            socket.on('leave-society', (data) => {
                this.handleLeaveSociety(socket, data);
            });

            // Handle user notification preferences update
            socket.on('update-preferences', (data) => {
                this.handleUpdatePreferences(socket, data);
            });

            // Chat system events
            socket.on('joinRoom', (data) => {
                this.handleJoinRoom(socket, data);
            });

            socket.on('message', (data) => {
                this.handleMessage(socket, data);
            });

            // Handle disconnect
            socket.on('disconnect', () => {
                this.handleDisconnect(socket);
            });

            // Handle ping/pong for connection health
            socket.on('ping', () => {
                socket.emit('pong');
            });
        });
    }

    /**
     * Handle JWT authentication (for chat system)
     */
    handleJWTConnection(socket) {
        try {
            const token = socket.handshake.auth?.token;

            if (!token) {
                console.log("No token provided, disconnecting socket");
                socket.disconnect();
                return;
            }

            const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
            socket.user = { id: decoded.id, username: decoded.username };

            console.log("User connected:", socket.user.id);
        } catch (err) {
            console.error("Invalid token:", err.message);
            socket.disconnect();
            return;
        }
    }

    /**
     * Handle user authentication (for alert system)
     */
    handleAuthentication(socket, data) {
        try {
            const { userId, societyId, role } = data;

            if (!userId || !societyId) {
                socket.emit('auth-error', { message: 'Invalid authentication data' });
                return;
            }

            // Store user connection info
            this.connectedUsers.set(socket.id, {
                userId: parseInt(userId),
                societyId: parseInt(societyId),
                role,
                socketId: socket.id
            });

            // Add socket to user's socket set
            if (!this.userSockets.has(userId)) {
                this.userSockets.set(userId, new Set());
            }
            this.userSockets.get(userId).add(socket.id);

            // Join society room for society-wide notifications
            socket.join(`society_${societyId}`);

            // Join user-specific room for personal notifications
            socket.join(`user_${userId}`);

            // Join role-specific room
            socket.join(`role_${role}`);

            socket.emit('authenticated', {
                message: 'Successfully authenticated',
                userId,
                societyId,
                role
            });

            console.log(`User ${userId} authenticated on socket ${socket.id}`);

        } catch (error) {
            console.error('Authentication error:', error);
            socket.emit('auth-error', { message: 'Authentication failed' });
        }
    }

    /**
     * Handle user joining society room
     */
    handleJoinSociety(socket, data) {
        try {
            const { societyId } = data;
            const userInfo = this.connectedUsers.get(socket.id);

            if (!userInfo) {
                socket.emit('error', { message: 'User not authenticated' });
                return;
            }

            // Leave previous society room if any
            socket.leaveAll();
            
            // Join new society room
            socket.join(`society_${societyId}`);
            
            // Rejoin user and role rooms
            socket.join(`user_${userInfo.userId}`);
            socket.join(`role_${userInfo.role}`);

            // Update user info
            userInfo.societyId = parseInt(societyId);
            this.connectedUsers.set(socket.id, userInfo);

            socket.emit('society-joined', {
                message: `Joined society ${societyId}`,
                societyId
            });

        } catch (error) {
            console.error('Join society error:', error);
            socket.emit('error', { message: 'Failed to join society' });
        }
    }

    /**
     * Handle user leaving society room
     */
    handleLeaveSociety(socket, data) {
        try {
            const userInfo = this.connectedUsers.get(socket.id);

            if (!userInfo) {
                socket.emit('error', { message: 'User not authenticated' });
                return;
            }

            socket.leave(`society_${userInfo.societyId}`);
            socket.emit('society-left', {
                message: `Left society ${userInfo.societyId}`,
                societyId: userInfo.societyId
            });

        } catch (error) {
            console.error('Leave society error:', error);
            socket.emit('error', { message: 'Failed to leave society' });
        }
    }

    /**
     * Handle user preferences update
     */
    handleUpdatePreferences(socket, data) {
        try {
            const userInfo = this.connectedUsers.get(socket.id);

            if (!userInfo) {
                socket.emit('error', { message: 'User not authenticated' });
                return;
            }

            // Update user preferences in real-time
            socket.emit('preferences-updated', {
                message: 'Preferences updated successfully',
                data
            });

        } catch (error) {
            console.error('Update preferences error:', error);
            socket.emit('error', { message: 'Failed to update preferences' });
        }
    }

    /**
     * Handle client disconnect
     */
    handleDisconnect(socket) {
        try {
            const userInfo = this.connectedUsers.get(socket.id);

            if (userInfo) {
                // Remove socket from user's socket set
                const userSockets = this.userSockets.get(userInfo.userId);
                if (userSockets) {
                    userSockets.delete(socket.id);
                    
                    // If no more sockets for this user, remove the entry
                    if (userSockets.size === 0) {
                        this.userSockets.delete(userInfo.userId);
                    }
                }

                // Remove from connected users
                this.connectedUsers.delete(socket.id);

                console.log(`User ${userInfo.userId} disconnected from socket ${socket.id}`);
            }

        } catch (error) {
            console.error('Disconnect handling error:', error);
        }
    }

    /**
     * Send real-time notification to specific user
     */
    sendToUser(userId, event, data) {
        try {
            // Support numeric or string keys
            let userSockets = this.userSockets.get(userId);
            if (!userSockets) userSockets = this.userSockets.get(String(userId));
            if (!userSockets) userSockets = this.userSockets.get(Number(userId));

            if (userSockets && userSockets.size > 0) {
                userSockets.forEach(socketId => {
                    const socket = this.io.sockets.sockets.get(socketId);
                    if (socket) {
                        socket.emit(event, data);
                    }
                });
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error sending to user:', error);
            return false;
        }
    }

    /**
     * Send real-time notification to all users in a society
     */
    sendToSociety(societyId, event, data) {
        try {
            this.io.to(`society_${societyId}`).emit(event, data);
            return true;
        } catch (error) {
            console.error('Error sending to society:', error);
            return false;
        }
    }

    /**
     * Send real-time notification to all users with a specific role
     */
    sendToRole(role, event, data) {
        try {
            this.io.to(`role_${role}`).emit(event, data);
            return true;
        } catch (error) {
            console.error('Error sending to role:', error);
            return false;
        }
    }

    /**
     * Send a task assignment directly to a driver (by user id)
     */
    sendTaskAssignmentToDriver(driverId, data) {
        try {
            this.sendToUser(driverId, 'task:assigned', data);
            return true;
        } catch (error) {
            console.error('Error sending task assignment to driver:', error);
            return false;
        }
    }

    /**
     * Broadcast driver location to society and admin roles
     */
    broadcastDriverLocation(driverId, societyId, locationData) {
        try {
            const payload = { driverId, ...locationData };
            if (societyId) {
                this.sendToSociety(societyId, 'drivers:update', payload);
            }
            // notify admins/super admins as well
            this.sendToRole('admin', 'drivers:update', payload);
            this.sendToRole('super_admin', 'drivers:update', payload);
            // also send to the driver socket(s)
            this.sendToUser(driverId, 'location:update', payload);
            return true;
        } catch (error) {
            console.error('Error broadcasting driver location:', error);
            return false;
        }
    }

    /**
     * Send real-time notification to all connected users
     */
    sendToAll(event, data) {
        try {
            this.io.emit(event, data);
            return true;
        } catch (error) {
            console.error('Error sending to all:', error);
            return false;
        }
    }

    /**
     * Send alert notification in real-time
     */
    sendAlertNotification(alertData, recipients) {
        try {
            const { id, title, message, priority, alert_type_name, society_id } = alertData;

            // Send to society
            this.sendToSociety(society_id, 'new-alert', {
                id,
                title,
                message,
                priority,
                alertType: alert_type_name,
                timestamp: new Date().toISOString()
            });

            // Send to specific recipients if provided
            if (recipients && recipients.length > 0) {
                recipients.forEach(recipient => {
                    this.sendToUser(recipient.user_id, 'personal-alert', {
                        id,
                        title,
                        message,
                        priority,
                        alertType: alert_type_name,
                        timestamp: new Date().toISOString()
                    });
                });
            }

            return true;
        } catch (error) {
            console.error('Error sending alert notification:', error);
            return false;
        }
    }

    /**
     * Send notification delivery status update
     */
    sendDeliveryStatus(userId, alertId, channel, status, messageId = null) {
        try {
            this.sendToUser(userId, 'delivery-status', {
                alertId,
                channel,
                status,
                messageId,
                timestamp: new Date().toISOString()
            });
            return true;
        } catch (error) {
            console.error('Error sending delivery status:', error);
            return false;
        }
    }

    /**
     * Get connection statistics
     */
    getConnectionStats() {
        try {
            const totalConnections = this.io.engine.clientsCount;
            const uniqueUsers = this.userSockets.size;
            const totalSockets = Array.from(this.userSockets.values()).reduce((total, sockets) => total + sockets.size, 0);

            return {
                totalConnections,
                uniqueUsers,
                totalSockets,
                connectedUsers: Array.from(this.connectedUsers.values())
            };
        } catch (error) {
            console.error('Error getting connection stats:', error);
            return null;
        }
    }

    /**
     * Broadcast system message
     */
    broadcastSystemMessage(message, type = 'info', target = 'all') {
        try {
            const data = {
                message,
                type,
                timestamp: new Date().toISOString()
            };

            switch (target) {
                case 'all':
                    this.sendToAll('system-message', data);
                    break;
                case 'admins':
                    this.sendToRole('admin', 'system-message', data);
                    this.sendToRole('super_admin', 'system-message', data);
                    break;
                case 'super_admin':
                    this.sendToRole('super_admin', 'system-message', data);
                    break;
                default:
                    this.sendToAll('system-message', data);
            }

            return true;
        } catch (error) {
            console.error('Error broadcasting system message:', error);
            return false;
        }
    }

    /**
     * Handle joining a chat room
     */
    handleJoinRoom(socket, data) {
        try {
            const { chatId, userId } = data;
            console.log(`Joining room with chat id: ${chatId}`);

            const rooms = Array.from(socket.rooms);
            rooms.forEach((room) => {
                if (room !== socket.id) {
                    socket.leave(room);
                    console.log(`User ${userId} left room ${room}`);
                }
            });

            socket.join(chatId);
            console.log(`User ${userId} joined room ${chatId}`);
        } catch (error) {
            console.error('Join room error:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    }

    /**
     * Handle chat message
     */
    async handleMessage(socket, data) {
        try {
            const { chatId, content } = data;
            const senderId = socket.user.id;
            const sender_name = socket.user.username;

            console.log("Sender ID from the user stored in the socket:", senderId);
            console.log("Sender name from the user stored in the socket:", sender_name);

            await pool.query(
                `INSERT INTO message (chat_id, content, sender_id, sender_name)
                 VALUES ($1, $2, $3, $4)`,
                [chatId, content, senderId, sender_name]
            );

            await pool.query(`UPDATE chat SET lastmessage = $1 WHERE id = $2`, [content, chatId]);

            const messageData = {
                chatId,
                content,
                senderId,
                sender_name,
                created_at: new Date(),
            };

            this.io.to(chatId).emit("receiveMessage", messageData);
            socket.emit("messageSent", { success: true, messageData });
        } catch (err) {
            console.error("DB error:", err.message);
            socket.emit("messageSent", { success: false, error: err.message });
        }
    }

    /**
     * Health check
     */
    healthCheck() {
        try {
            const stats = this.getConnectionStats();
            return {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                stats
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                timestamp: new Date().toISOString(),
                error: error.message
            };
        }
    }
}

module.exports = new WebSocketService();
