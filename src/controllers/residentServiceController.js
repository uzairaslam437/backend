// controllers/residentServiceController.js
const { pool } = require("../config/db");
const sentimentService = require("../services/sentimentAnalysisService");


/** Parse positive int safely; returns fallback for invalid input. */
const toPosInt = (v, fb = null) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fb;
};

/** Basic pagination sanitizer with offset calculation. */
const getPagination = (pageIn, limitIn, defaults = { page: 1, limit: 10, maxLimit: 200 }) => {
  const page = Math.max(toPosInt(pageIn, defaults.page), 1);
  const rawLimit = toPosInt(limitIn, defaults.limit);
  const limit = Math.min(Math.max(rawLimit || defaults.limit, 1), defaults.maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

/** Uniform 500 error response logging. */
const fail500 = (res, label, error) => {
  console.error(`${label}:`, error);
  return res.status(500).json({ success: false, message: "Internal Server Error" });
};

/** Quick wrapper for pool.query */
const run = (text, values = []) => pool.query(text, values);

/** Ensure the current user owns a specific service request id. */
const ensureUserOwnsRequest = async (userId, requestId) => {
  const q = await run(
    `SELECT id FROM service_requests WHERE id = $1 AND user_id = $2`,
    [requestId, userId]
  );
  if (q.rows.length === 0) {
    const err = new Error("Service request not found");
    err.status = 404;
    throw err;
  }
};

/** Build row for request messages list and mark as read for current user. */
const markMessagesRead = (requestId, userId) =>
  run(
    `
      UPDATE service_request_messages 
      SET is_read = true, read_at = CURRENT_TIMESTAMP 
      WHERE service_request_id = $1 AND recipient_id = $2 AND is_read = false
    `,
    [requestId, userId]
  );

/** Generate a human-friendly unique-ish service request number */
const genRequestNumber = () => `SR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/* -------------------------------------------------------
 * SERVICE TYPES
 * ----------------------------------------------------- */

const getServiceTypes = async (_req, res) => {
  try {
    const result = await run(
      `
        SELECT * 
        FROM service_types 
        WHERE is_active = true 
        ORDER BY category, name
      `
    );
    return res.status(200).json({ success: true, serviceTypes: result.rows });
  } catch (error) {
    return fail500(res, "Get service types error", error);
  }
};

/* -------------------------------------------------------
 * USER PROFILE MANAGEMENT
 * ----------------------------------------------------- */

const addUserProfile = async (req, res) => {
  const userId = req.user.id;
  const {
    dateOfBirth,
    gender,
    emergencyContactName,
    emergencyContactPhone,
    notificationPreferences,
    preferredCollectionTime,
    specialInstructions,
  } = req.body;

  try {
    const q = await run(
      `
        INSERT INTO user_profiles (
          user_id,
          date_of_birth,
          gender,
          emergency_contact_name,
          emergency_contact_phone,
          notification_preferences,
          preferred_collection_time,
          special_instructions
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        userId,
        dateOfBirth || null,
        gender || null,
        emergencyContactName || null,
        emergencyContactPhone || null,
        notificationPreferences ? JSON.stringify(notificationPreferences) : '{"email": true, "sms": true, "push": true}',
        preferredCollectionTime || "morning",
        specialInstructions || null,
      ]
    );

    return res
      .status(201)
      .json({ success: true, message: "Profile created successfully", profile: q.rows[0] });
  } catch (error) {
    return fail500(res, "Add user profile error", error);
  }
};

module.exports = { addUserProfile };


const getUserProfile = async (req, res) => {
  const userId = req.user.id; // From auth middleware
  try {
    // LEFT JOIN to always prefer user row, profile may be missing
    const q = await run(
      `
        SELECT up.*, u.first_name, u.last_name, u.email, u.phone_number 
        FROM users u
        LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE u.id = $1
      `,
      [userId]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({ success: true, profile: q.rows[0] });
  } catch (error) {
    return fail500(res, "Get user profile error", error);
  }
};

const updateUserProfile = async (req, res) => {
  const userId = req.user.id;
  const { emergencyContactName, emergencyContactPhone, preferredCollectionTime } = req.body;

  try {
    const q = await run(
      `
        INSERT INTO user_profiles (user_id, emergency_contact_name, emergency_contact_phone, preferred_collection_time)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          emergency_contact_name = EXCLUDED.emergency_contact_name,
          emergency_contact_phone = EXCLUDED.emergency_contact_phone,
          preferred_collection_time = EXCLUDED.preferred_collection_time,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `,
      [userId, emergencyContactName, emergencyContactPhone, preferredCollectionTime]
    );
    return res
      .status(200)
      .json({ success: true, message: "Profile updated successfully", profile: q.rows[0] });
  } catch (error) {
    return fail500(res, "Update user profile error", error);
  }
};

/* -------------------------------------------------------
 * USER ADDRESSES
 * ----------------------------------------------------- */

const getUserAddresses = async (req, res) => {
  const userId = req.user.id;
  try {
    const q = await run(
      `
        SELECT * 
        FROM user_addresses 
        WHERE user_id = $1 AND is_active = true 
        ORDER BY is_default DESC, created_at ASC
      `,
      [userId]
    );
    return res.status(200).json({ success: true, addresses: q.rows });
  } catch (error) {
    return fail500(res, "Get user addresses error", error);
  }
};

const addUserAddress = async (req, res) => {
  const userId = req.user.id;
  const {
    addressType,
    streetAddress,
    apartmentUnit,
    area,
    city,
    postalCode,
    landmark,
    isDefault,
  } = req.body;

  if (!streetAddress || !city) {
    return res
      .status(400)
      .json({ success: false, message: "Street address and city are required" });
  }

  try {
    // If this is set as default, remove default from other addresses
    if (isDefault) {
      await run(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    }

    const q = await run(
      `
        INSERT INTO user_addresses 
          (user_id, address_type, street_address, apartment_unit, area, city, postal_code, landmark, is_default)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `,
      [userId, addressType, streetAddress, apartmentUnit, area, city, postalCode, landmark, !!isDefault]
    );

    return res
      .status(201)
      .json({ success: true, message: "Address added successfully", address: q.rows[0] });
  } catch (error) {
    return fail500(res, "Add user address error", error);
  }
};

const updateUserAddress = async (req, res) => {
  const userId = req.user.id;
  const addressId = toPosInt(req.params.addressId, null);
  const {
    addressType,
    streetAddress,
    apartmentUnit,
    area,
    city,
    postalCode,
    landmark,
    isDefault,
  } = req.body;

  if (addressId === null) {
    return res.status(400).json({ success: false, message: "Invalid address id" });
  }

  if (!streetAddress || !city) {
    return res
      .status(400)
      .json({ success: false, message: "Street address and city are required" });
  }

  try {
    if (isDefault) {
      await run(
        `UPDATE user_addresses SET is_default = false WHERE user_id = $1 AND id <> $2`,
        [userId, addressId]
      );
    }

    const q = await run(
      `
        UPDATE user_addresses SET 
          address_type = $1, street_address = $2, apartment_unit = $3, 
          area = $4, city = $5, postal_code = $6, landmark = $7, is_default = $8,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $9 AND user_id = $10
        RETURNING *
      `,
      [
        addressType,
        streetAddress,
        apartmentUnit,
        area,
        city,
        postalCode,
        landmark,
        !!isDefault,
        addressId,
        userId,
      ]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Address updated successfully", address: q.rows[0] });
  } catch (error) {
    return fail500(res, "Update user address error", error);
  }
};

const deleteUserAddress = async (req, res) => {
  const userId = req.user.id;
  const addressId = toPosInt(req.params.addressId, null);

  if (addressId === null) {
    return res.status(400).json({ success: false, message: "Invalid address id" });
  }

  try {
    const q = await run(
      `UPDATE user_addresses SET is_active = false WHERE id = $1 AND user_id = $2 RETURNING *`,
      [addressId, userId]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    return res.status(200).json({ success: true, message: "Address deleted successfully" });
  } catch (error) {
    return fail500(res, "Delete user address error", error);
  }
};

/* -------------------------------------------------------
 * SERVICE REQUESTS
 * ----------------------------------------------------- */

const createServiceRequest = async (req, res) => {
  const userId = req.user.id;
  const {
    serviceTypeId,
    addressId,
    title,
    description,
    preferredDate,
    preferredTimeSlot,
    specialInstructions,
    estimatedWeight,
    estimatedBags,
  } = req.body;

  if (!serviceTypeId || !title || !preferredDate) {
    return res.status(400).json({
      success: false,
      message: "Service type, title, and preferred date are required",
    });
  }

  const request_number = genRequestNumber();

  try {
    const q = await run(
      `
        INSERT INTO service_requests 
          (user_id, service_type_id, address_id, title, description, preferred_date, 
           preferred_time_slot, special_instructions, estimated_weight, estimated_bags, request_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
      [
        userId,
        serviceTypeId,
        addressId || null,
        title,
        description || null,
        preferredDate,
        preferredTimeSlot || null,
        specialInstructions || null,
        estimatedWeight || null,
        estimatedBags || null,
        request_number,
      ]
    );

    // Log initial status change
    await run(
      `
        INSERT INTO service_request_status_history 
          (service_request_id, old_status, new_status, changed_by)
        VALUES ($1, NULL, 'pending', $2)
      `,
      [q.rows[0].id, userId]
    );

    // Trigger Auto-Assignment (Async)
    const assignmentService = require("../services/assignmentService");
    const websocketService = require("../services/websocketService");

    // We don't await this to keep response fast, or we can await if we want to return assignment status immediately.
    // Usually better to do async for robustness, but here immediate feedback is nice.
    // Let's do it async (fire and forget) so we don't block.
    assignmentService.assignServiceRequest(q.rows[0].id, websocketService)
      .then(driver => {
        if (driver) console.log(`SR-${q.rows[0].id} assigned to ${driver.first_name}`);
        else console.log(`SR-${q.rows[0].id} auto-assignment deferred.`);
      })
      .catch(e => console.error("Auto-assignment error:", e));

    return res.status(201).json({
      success: true,
      message: "Service request created successfully",
      serviceRequest: q.rows[0],
    });
  } catch (error) {
    return fail500(res, "Create service request error", error);
  }
};

const getUserServiceRequests = async (req, res) => {
  const userId = req.user.id;
  const { status, page = 1, limit = 10 } = req.query;
  const { page: pg, limit: lim, offset } = getPagination(page, limit);

  try {
    let where = 'WHERE sr.user_id = $1';
    const params = [userId];

    if (status) {
      where += ` AND sr.status = $2`;
      params.push(status);
    }

    const data = await run(
      `
        SELECT 
          sr.*,
          st.name as service_type_name,
          st.category as service_category,
          ua.street_address,
          ua.city,
          driver.first_name as driver_first_name,
          driver.last_name as driver_last_name,
          driver.phone_number as driver_phone
        FROM service_requests sr
        LEFT JOIN service_types st ON sr.service_type_id = st.id
        LEFT JOIN user_addresses ua ON sr.address_id = ua.id
        LEFT JOIN users driver ON sr.driver_id = driver.id
        ${where}
        ORDER BY sr.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, lim, offset]
    );

    const count = await run(
      `SELECT COUNT(*) FROM service_requests sr ${where}`,
      params
    );

    const total = Number.parseInt(count.rows[0].count, 10) || 0;

    return res.status(200).json({
      success: true,
      serviceRequests: data.rows,
      pagination: {
        total,
        page: pg,
        limit: lim,
        pages: Math.ceil(total / lim),
      },
    });
  } catch (error) {
    return fail500(res, "Get user service requests error", error);
  }
};

const getServiceRequestById = async (req, res) => {
  const userId = req.user.id;
  const requestId = toPosInt(req.params.requestId, null);
  if (requestId === null) {
    return res.status(400).json({ success: false, message: "Invalid request id" });
  }

  try {
    const q = await run(
      `
        SELECT 
          sr.*,
          st.name as service_type_name,
          st.category as service_category,
          st.base_price,
          ua.street_address,
          ua.apartment_unit,
          ua.area,
          ua.city,
          ua.postal_code,
          ua.landmark,
          driver.first_name as driver_first_name,
          driver.last_name as driver_last_name,
          driver.phone_number as driver_phone,
          driver.email as driver_email
        FROM service_requests sr
        LEFT JOIN service_types st ON sr.service_type_id = st.id
        LEFT JOIN user_addresses ua ON sr.address_id = ua.id
        LEFT JOIN users driver ON sr.driver_id = driver.id
        WHERE sr.id = $1 AND sr.user_id = $2
      `,
      [requestId, userId]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service request not found" });
    }

    const history = await run(
      `
        SELECT 
          srsh.*,
          u.first_name,
          u.last_name
        FROM service_request_status_history srsh
        LEFT JOIN users u ON srsh.changed_by = u.id
        WHERE srsh.service_request_id = $1
        ORDER BY srsh.changed_at ASC
      `,
      [requestId]
    );

    return res.status(200).json({
      success: true,
      serviceRequest: { ...q.rows[0], statusHistory: history.rows },
    });
  } catch (error) {
    return fail500(res, "Get service request by ID error", error);
  }
};

const cancelServiceRequest = async (req, res) => {
  const userId = req.user.id;
  const requestId = toPosInt(req.params.requestId, null);
  const { reason } = req.body;

  if (requestId === null) {
    return res.status(400).json({ success: false, message: "Invalid request id" });
  }

  try {
    // Check if request exists and belongs to user
    const check = await run(
      `SELECT id, status FROM service_requests WHERE id = $1 AND user_id = $2`,
      [requestId, userId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service request not found" });
    }

    const currentStatus = check.rows[0].status;
    if (!["pending", "approved", "assigned"].includes(currentStatus)) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot cancel request in current status" });
    }

    // Update request status
    const upd = await run(
      `UPDATE service_requests SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [requestId]
    );

    // Log status change
    await run(
      `
        INSERT INTO service_request_status_history 
          (service_request_id, old_status, new_status, changed_by, reason)
        VALUES ($1, $2, 'cancelled', $3, $4)
      `,
      [requestId, currentStatus, userId, reason || null]
    );

    return res.status(200).json({
      success: true,
      message: "Service request cancelled successfully",
      serviceRequest: upd.rows[0],
    });
  } catch (error) {
    return fail500(res, "Cancel service request error", error);
  }
};

/* -------------------------------------------------------
 * SERVICE FEEDBACK
 * ----------------------------------------------------- */

const submitFeedback = async (req, res) => {
  const userId = req.user.id;
  const requestId = toPosInt(req.params.requestId, null);
  const {
    overallRating,
    timelinessRating,
    professionalismRating,
    cleanlinessRating,
    comments,
    wouldRecommend,
    suggestions,
  } = req.body;

  if (requestId === null) {
    return res.status(400).json({ success: false, message: "Invalid request id" });
  }
  if (!overallRating || overallRating < 1 || overallRating > 5) {
    return res
      .status(400)
      .json({ success: false, message: "Overall rating is required and must be between 1-5" });
  }

  try {
    // Verify request exists, belongs to user, and is completed
    const check = await run(
      `
        SELECT sr.id, sr.driver_id 
        FROM service_requests sr 
        WHERE sr.id = $1 AND sr.user_id = $2 AND sr.status = 'completed'
      `,
      [requestId, userId]
    );

    if (check.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Service request not found or not completed" });
    }

    const driverId = check.rows[0].driver_id || null;

    const q = await run(
      `
        INSERT INTO service_feedback 
          (service_request_id, user_id, driver_id, overall_rating, timeliness_rating, 
           professionalism_rating, cleanliness_rating, comments, would_recommend, suggestions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (service_request_id) 
        DO UPDATE SET 
          overall_rating = EXCLUDED.overall_rating,
          timeliness_rating = EXCLUDED.timeliness_rating,
          professionalism_rating = EXCLUDED.professionalism_rating,
          cleanliness_rating = EXCLUDED.cleanliness_rating,
          comments = EXCLUDED.comments,
          would_recommend = EXCLUDED.would_recommend,
          suggestions = EXCLUDED.suggestions,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `,
      [
        requestId,
        userId,
        driverId,
        overallRating,
        timelinessRating || null,
        professionalismRating || null,
        cleanlinessRating || null,
        comments || null,
        typeof wouldRecommend === "boolean" ? wouldRecommend : null,
        suggestions || null,
      ]
    );

    return res
      .status(200)
      .json({ success: true, message: "Feedback submitted successfully", feedback: q.rows[0] });
  } catch (error) {
    return fail500(res, "Submit feedback error", error);
  }
};

const getFeedback = async (req, res) => {
  const userId = req.user.id;
  const requestId = toPosInt(req.params.requestId, null);

  if (requestId === null) {
    return res.status(400).json({ success: false, message: "Invalid request id" });
  }

  try {
    const q = await run(
      `
        SELECT sf.*, sr.title as request_title
        FROM service_feedback sf
        JOIN service_requests sr ON sf.service_request_id = sr.id
        WHERE sf.service_request_id = $1 AND sf.user_id = $2
      `,
      [requestId, userId]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Feedback not found" });
    }

    return res.status(200).json({ success: true, feedback: q.rows[0] });
  } catch (error) {
    return fail500(res, "Get feedback error", error);
  }
};

/* -------------------------------------------------------
 * SERVICE REQUEST MESSAGES
 * ----------------------------------------------------- */

const getRequestMessages = async (req, res) => {
  const userId = req.user.id;
  const requestId = toPosInt(req.params.requestId, null);

  if (requestId === null) {
    return res.status(400).json({ success: false, message: "Invalid request id" });
  }

  try {
    await ensureUserOwnsRequest(userId, requestId);

    const q = await run(
      `
        SELECT 
          srm.*,
          u.first_name as sender_first_name,
          u.last_name as sender_last_name,
          u.role as sender_role
        FROM service_request_messages srm
        JOIN users u ON srm.sender_id = u.id
        WHERE srm.service_request_id = $1
        ORDER BY srm.created_at ASC
      `,
      [requestId]
    );

    await markMessagesRead(requestId, userId);

    return res.status(200).json({ success: true, messages: q.rows });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ success: false, message: error.message });
    }
    return fail500(res, "Get request messages error", error);
  }
};

const sendMessage = async (req, res) => {
  const userId = req.user.id;
  const requestId = toPosInt(req.params.requestId, null);
  const { message, recipientId } = req.body;

  if (requestId === null) {
    return res.status(400).json({ success: false, message: "Invalid request id" });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: "Message content is required" });
  }

  try {
    // Verify user has access (as request owner or assigned driver)
    const access = await run(
      `
        SELECT sr.id, sr.driver_id, sr.user_id 
        FROM service_requests sr 
        WHERE sr.id = $1 AND (sr.user_id = $2 OR sr.driver_id = $2)
      `,
      [requestId, userId]
    );
    if (access.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service request not found" });
    }

    // Determine recipient if not specified
    let finalRecipientId = recipientId;
    if (!finalRecipientId) {
      const reqRow = access.rows[0];
      finalRecipientId = userId === reqRow.user_id ? reqRow.driver_id : reqRow.user_id;
      if (!finalRecipientId) {
        // If driver not assigned yet and recipient not provided, reject
        return res.status(400).json({
          success: false,
          message: "Recipient not determined. Provide recipientId or wait for assignment.",
        });
      }
    }

    const q = await run(
      `
        INSERT INTO service_request_messages 
          (service_request_id, sender_id, recipient_id, message)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [requestId, userId, finalRecipientId, String(message).trim()]
    );

    return res.status(201).json({
      success: true,
      message: "Message sent successfully",
      messageData: q.rows[0],
    });
  } catch (error) {
    return fail500(res, "Send message error", error);
  }
};

/* -------------------------------------------------------
 * Exports
 * ----------------------------------------------------- */

module.exports = {
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
  sendMessage,
};
