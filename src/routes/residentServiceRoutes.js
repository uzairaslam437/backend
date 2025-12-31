// routes/residentServiceRoutes.js
const express = require('express');
const router = express.Router();
const {
    // Service Types
    getServiceTypes,

    // Profile Management
    addUserProfile,
    getUserProfile,
    updateUserProfile,

    // Address Management
    getUserAddresses,
    addUserAddress,
    updateUserAddress,
    deleteUserAddress,

    // Service Requests
    createServiceRequest,
    getUserServiceRequests,
    getServiceRequestById,
    cancelServiceRequest,

    // Feedback
    submitFeedback,
    getFeedback,

    // Messages
    getRequestMessages,
    sendMessage
} = require('../controllers/residentServiceController');

// Middleware to verify if user is a Admin
const verifyAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
    }

    if (req.user.role !== 'admin' || req.user.role !== 'sub_admin') {
        return res.status(403).json({
            success: false,
            message: 'Access denied. Admin role required.'
        });
    }

    next();
};


// Middleware to verify if user is a resident
const verifyResident = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
    }

    if (req.user.role !== 'resident') {
        return res.status(403).json({
            success: false,
            message: 'Access denied. Resident role required.'
        });
    }

    next();
};

// Middleware to verify if user is admin or resident
const verifyAdminOrResident = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
    }

    const allowedRoles = ['admin', 'sub_admin', 'resident'];
    if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            message: 'Access denied. Admin or resident role required.'
        });
    }

    next();
};

// ===== SERVICE TYPES ROUTES =====
router.get('/service-types', verifyAdminOrResident, getServiceTypes);

// ===== USER PROFILE ROUTES =====
router.post('/profile', verifyAdminOrResident, addUserProfile);
router.get('/profile', verifyAdminOrResident, getUserProfile);
router.put('/profile', verifyAdminOrResident, updateUserProfile);

// ===== USER ADDRESS ROUTES =====
router.get('/addresses', verifyAdminOrResident, getUserAddresses);
router.post('/addresses', verifyAdminOrResident, addUserAddress);
router.put('/addresses/:addressId', verifyAdminOrResident, updateUserAddress);
router.delete('/addresses/:addressId', verifyAdminOrResident, deleteUserAddress);

// ===== SERVICE REQUEST ROUTES =====
router.post('/service-requests', verifyResident, createServiceRequest);
router.get('/service-requests', verifyAdminOrResident, getUserServiceRequests);
router.get('/service-requests/:requestId', getServiceRequestById);
router.put('/service-requests/:requestId/cancel', verifyResident, cancelServiceRequest);

// ===== FEEDBACK ROUTES =====
router.post('/service-requests/:requestId/feedback', verifyResident, submitFeedback);
router.get('/service-requests/:requestId/feedback', verifyAdminOrResident, getFeedback);

// ===== MESSAGE ROUTES =====
router.get('/service-requests/:requestId/messages', verifyAdminOrResident, getRequestMessages);
router.post('/service-requests/:requestId/messages', verifyAdminOrResident, sendMessage);

module.exports = router;