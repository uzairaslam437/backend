// controllers/authController.js

const { pool } = require("../config/db");
require("dotenv").config();
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const { generateTokens } = require("../utils/generateToken");
const { hashPassword, comparePassword } = require("../utils/hashPassword");
const { logSubAdminActivity } = require("../services/subAdminLogger");

// Generate OTP function
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const isEmailValid = (email) => EMAIL_REGEX.test(String(email || "").trim());
const getUsernameFromEmail = (email) =>
  String(email || "")
    .trim()
    .split("@")[0];

const requireAll = (fields) => {
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null || String(val).trim() === "") {
      return { ok: false, key };
    }
  }
  return { ok: true };
};

const runQuery = (text, values = []) => pool.query(text, values);

const getUserByEmail = async (email) => {
  const r = await runQuery(`SELECT * FROM users WHERE email = $1`, [
    String(email).trim(),
  ]);
  return r.rows[0] || null;
};

const getUserByPhone = async (phone) => {
  const r = await runQuery(`SELECT * FROM users WHERE phone_number = $1`, [
    phone,
  ]);
  return r.rows[0] || null;
};

const createRandomToken = () => crypto.randomBytes(32).toString("hex");

const verificationEmailHTML = (recipientUsername, verificationLink) => `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Email Verification</title></head>
<body style="margin:0;padding:0;font-family:'Arial',sans-serif;background-color:#f4f7f5;">
<div style="max-width:600px;margin:0 auto;background-color:#ffffff;box-shadow:0 4px 10px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#4CAF50 0%,#2E7D32 100%);padding:40px 20px;text-align:center;">
    <div style="background-color:white;width:80px;height:80px;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 15px rgba(0,0,0,0.2);"><span style="font-size:40px;">🌱</span></div>
    <h1 style="color:#ffffff;margin:0;font-size:28px;font-weight:bold;">Green Guardian</h1>
    <p style="color:#e8f5e8;margin:10px 0 0 0;font-size:16px;">Your Environmental Journey Starts Here</p>
  </div>
  <div style="padding:40px 30px;">
    <h2 style="color:#2E7D32;margin-bottom:20px;font-size:24px;">Hello ${recipientUsername}! 👋</h2>
    <p style="color:#555;line-height:1.6;font-size:16px;margin-bottom:25px;">Welcome to the Green Guardian community! We're excited to have you join us in making our planet a greener, more sustainable place.</p>
    <div style="background-color:#f8fff9;border-left:4px solid #4CAF50;padding:20px;margin:25px 0;border-radius:4px;">
      <h3 style="color:#2E7D32;margin:0 0 15px 0;font-size:18px;">📧 Verify Your Email Address</h3>
      <p style="color:#666;margin:0;line-height:1.5;">To complete your registration and start your eco-friendly journey, please verify your email address by clicking the button below.</p>
    </div>
    <div style="text-align:center;margin:35px 0;">
      <a href="${verificationLink}" style="background:linear-gradient(135deg,#4CAF50 0%,#45a049 100%);color:#fff;text-decoration:none;padding:15px 35px;border-radius:50px;font-weight:bold;font-size:16px;display:inline-block;box-shadow:0 4px 15px rgba(76,175,80,.3);transition:all .3s ease;">✨ Verify Email & Set Password</a>
    </div>
    <div style="background-color:#fff3cd;border:1px solid #ffeaa7;border-radius:6px;padding:15px;margin:30px 0;">
      <p style="color:#856404;margin:0;font-size:14px;text-align:center;">⏰ This verification link will expire in 24 hours for security purposes.</p>
    </div>
    <div style="border-top:1px solid #eee;padding-top:25px;margin-top:30px;">
      <p style="color:#888;font-size:14px;line-height:1.5;margin-bottom:15px;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="background-color:#f8f9fa;padding:10px;border-radius:4px;word-break:break-all;font-size:13px;color:#666;margin:0;">${verificationLink}</p>
    </div>
  </div>
  <div style="background-color:#f8fff9;padding:30px;text-align:center;border-top:1px solid #e8f5e8;">
    <div style="margin-bottom:20px;"><span style="font-size:24px;margin:0 5px;">🌍</span><span style="font-size:24px;margin:0 5px;">🌿</span><span style="font-size:24px;margin:0 5px;">♻️</span></div>
    <p style="color:#2E7D32;margin:0 0 10px 0;font-weight:bold;font-size:16px;">Together, we can make a difference!</p>
    <p style="color:#666;font-size:14px;margin:0 0 15px 0;line-height:1.4;">Join thousands of eco-warriors already making positive environmental impact.</p>
    <p style="color:#888;font-size:12px;margin:0;">This email was sent from Green Guardian. If you didn't create an account with us, please ignore this email.</p>
    <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e8f5e8;"><p style="color:#aaa;font-size:11px;margin:0;">© 2025 Green Guardian. All rights reserved.</p></div>
  </div>
</div>
</body></html>
`;

const resetEmailHTML = (recipientUsername, resetLink) => `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Password Reset</title></head>
<body style="margin:0;padding:0;font-family:'Arial',sans-serif;background-color:#f4f7f5;">
<div style="max-width:600px;margin:0 auto;background-color:#ffffff;box-shadow:0 4px 10px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#4CAF50 0%,#2E7D32 100%);padding:40px 20px;text-align:center;">
    <div style="background-color:white;width:80px;height:80px;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 15px rgba(0,0,0,0.2);"><span style="font-size:40px;">🔐</span></div>
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:bold;">Green Guardian</h1>
    <p style="color:#e8f5e8;margin:10px 0 0 0;font-size:16px;">Password Reset Request</p>
  </div>
  <div style="padding:40px 30px;">
    <h2 style="color:#2E7D32;margin-bottom:20px;font-size:24px;">Hello ${recipientUsername}! 👋</h2>
    <p style="color:#555;line-height:1.6;font-size:16px;margin-bottom:25px;">We received a request to reset your password for your Green Guardian account. If you didn't make this request, you can safely ignore this email.</p>
    <div style="background-color:#fff3cd;border-left:4px solid #ffc107;padding:20px;margin:25px 0;border-radius:4px;">
      <h3 style="color:#856404;margin:0 0 15px 0;font-size:18px;">🔒 Reset Your Password</h3>
      <p style="color:#856404;margin:0;line-height:1.5;">Click the button below to create a new password for your account.</p>
    </div>
    <div style="text-align:center;margin:35px 0;">
      <a href="${resetLink}" style="background:linear-gradient(135deg,#4CAF50 0%,#45a049 100%);color:#fff;text-decoration:none;padding:15px 35px;border-radius:50px;font-weight:bold;font-size:16px;display:inline-block;box-shadow:0 4px 15px rgba(76,175,80,.3);transition:all .3s ease;">🔑 Reset Password</a>
    </div>
    <div style="background-color:#f8d7da;border:1px solid #f5c6cb;border-radius:6px;padding:15px;margin:30px 0;">
      <p style="color:#721c24;margin:0;font-size:14px;text-align:center;">⏰ This reset link will expire in 1 hour for security purposes.</p>
    </div>
    <div style="border-top:1px solid #eee;padding-top:25px;margin-top:30px;">
      <p style="color:#888;font-size:14px;line-height:1.5;margin-bottom:15px;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="background-color:#f8f9fa;padding:10px;border-radius:4px;word-break:break-all;font-size:13px;color:#666;margin:0;">${resetLink}</p>
    </div>
  </div>
  <div style="background-color:#f8fff9;padding:30px;text-align:center;border-top:1px solid #e8f5e8;">
    <div style="margin-bottom:20px;"><span style="font-size:24px;margin:0 5px;">🔐</span><span style="font-size:24px;margin:0 5px;">🌱</span><span style="font-size:24px;margin:0 5px;">🛡️</span></div>
    <p style="color:#2E7D32;margin:0 0 10px 0;font-weight:bold;font-size:16px;">Your security is important to us!</p>
    <p style="color:#666;font-size:14px;margin:0 0 15px 0;line-height:1.4;">If you didn't request this password reset, please contact our support team immediately.</p>
    <p style="color:#888;font-size:12px;margin:0;">This email was sent from Green Guardian. If you didn't request a password reset, please ignore this email.</p>
    <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e8f5e8;"><p style="color:#aaa;font-size:11px;margin:0;">© 2025 Green Guardian. All rights reserved.</p></div>
  </div>
</div>
</body></html>
`;

const addAdminAndStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const { firstName, lastName, phone, role, email, societyId } = req.body;
    const currentUser = req.user;

    const need = requireAll({ firstName, lastName, phone, role, email });
    if (!need.ok)
      return res.status(400).json({ message: "All fields are required" });

    // Determine the society ID and created_by based on user role
    let finalSocietyId = societyId;
    let createdBy = null;

    if (role !== "super_admin") {
      if (currentUser.role === "admin" || currentUser.role === "sub_admin") {
        // Admin users can only add staff to their own society
        finalSocietyId = currentUser.society_id;

        // If society_id is not in token, fetch it from database
        if (!finalSocietyId) {
          const userQuery = await runQuery(
            `SELECT society_id FROM users WHERE id = $1`,
            [currentUser.id]
          );
          if (userQuery.rows.length > 0) {
            finalSocietyId = userQuery.rows[0].society_id;
          }
        }

        // If still no society_id, return error
        if (!finalSocietyId) {
          return res
            .status(400)
            .json({ message: "Admin user must be associated with a society" });
        }

        // Store the admin's ID as creator for sub_admin role
        if (role === "sub_admin") {
          createdBy = currentUser.id;
        }

        // Only admin can create sub_admin, sub_admin cannot create another sub_admin
        if (role === "sub_admin" && currentUser.role === "sub_admin") {
          return res
            .status(403)
            .json({ message: "Sub-admin cannot create other sub-admins" });
        }
      } else if (currentUser.role === "super_admin") {
        // Super admin can choose society, but it's required
        if (!societyId) {
          return res
            .status(400)
            .json({
              message: "Society ID is required for non-super admin roles",
            });
        }
        finalSocietyId = societyId;

        // Store super_admin's ID as creator for sub_admin role
        if (role === "sub_admin") {
          createdBy = currentUser.id;
        }
      } else {
        return res.status(403).json({ message: "Unauthorized to add staff" });
      }
    } else {
      // For super_admin role creation, store the creator
      if (currentUser.role === "super_admin") {
        createdBy = currentUser.id;
      }
    }

    if (!isEmailValid(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    // App-level duplicate checks
    const dupEmail = await getUserByEmail(email);
    if (dupEmail)
      return res.status(400).json({ message: "Email already in use." });
    const dupPhone = await getUserByPhone(phone);
    if (dupPhone)
      return res.status(400).json({ message: "Phone number already in use." });

    const username = getUsernameFromEmail(email);

    await client.query("BEGIN");

    // Insert user with MFA enabled for admin/super_admin
    const mfaEnabled = role === "admin" || role === "super_admin";
    const userInsert = await client.query(
      role === "super_admin"
        ? `INSERT INTO users (first_name, last_name, username, phone_number, email, role, mfa_enabled,created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`
        : `INSERT INTO users (first_name, last_name, username, phone_number, email, role, society_id, mfa_enabled,created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      role === "super_admin"
        ? [
          firstName.trim(),
          lastName.trim(),
          username,
          phone,
          String(email).trim(),
          role,
          mfaEnabled,
          createdBy,
        ]
        : [
          firstName.trim(),
          lastName.trim(),
          username,
          phone,
          String(email).trim(),
          role,
          finalSocietyId,
          mfaEnabled,
          createdBy,
        ]
    );
    const newUser = userInsert.rows[0];

    if (currentUser.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "CREATED_STAFF",
        description: `Sub Admin ${req.user.id} created ${role} with email: ${email} at ${Date.now()}`,
      });
    }

    // If admin or sub_admin, add to society chat
    if (role === "admin" || role === "sub_admin") {
      const chat = await client.query(
        `SELECT * FROM chat WHERE society_id = $1`,
        [finalSocietyId]
      );
      if (chat.rows.length > 0) {
        const row = chat.rows[0];
        const currentParticipants = row.chatparticipants || [];
        if (!currentParticipants.includes(newUser.id)) {
          const updatedParticipants = [...currentParticipants, newUser.id];
          await client.query(
            `UPDATE chat SET chatparticipants = $1 WHERE id = $2`,
            [updatedParticipants, row.id]
          );
        }
      } else {
        await client.query(
          `INSERT INTO chat (society_id, chatparticipants, lastmessage)
           VALUES ($1, $2, $3)`,
          [finalSocietyId, [newUser.id], null]
        );
      }
    }

    // Create verification token row
    const verificationToken = createRandomToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [newUser.id, verificationToken, expiresAt]
    );

    await sendVerificationEmail(
      username,
      String(email).trim(),
      verificationToken
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: `Staff created. Email sent to verify and set password.`,
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        createdBy: newUser.created_by,
      },
    });
  } catch (error) {
    // If anything failed (including email), rollback so no partial user is left
    try {
      await client.query("ROLLBACK");
    } catch (_) { }
    console.error(`Error creating user: ${error.message}`);
    if (
      error.code === "EMAIL_SEND_FAILED" ||
      error.code === "EMAIL_CONFIG_MISSING"
    ) {
      return res
        .status(502)
        .json({ error: "Unable to send verification email" });
    }
    return res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

const addResident = async (req, res) => {
  try {
    console.log("Checkpoint 1");

    const { first_name, last_name, phone_number, email } = req.body;
    const requesterId = req.user?.id;

    console.log("Request Body:", req.body);

    console.log("Requester ID:", requesterId);

    if (!first_name || !last_name || !phone_number || !email) {
      return res.status(400).json({ message: "All fields are required" });
    }
    console.log("Checkpoint 2");

    // Validate email
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!regex.test(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    let societyId;
    const requester = await pool.query(
      `SELECT id, role, society_id FROM users WHERE id = $1`,
      [requesterId]
    );

    if (requester.rows.length === 0) {
      return res.status(404).json({ message: "SocietyId not found" });
    }

    const requesterData = requester.rows[0];

    if (requesterData.role === "super_admin") {
      societyId = req.body.societyId;
      if (!societyId) {
        return res.status(400).json({ message: "Society ID is required" });
      }
    } else if (requesterData.role === "admin" || "sub_admin") {
      societyId = requesterData.society_id;
      if (!societyId) {
        return res
          .status(400)
          .json({ message: "Admin has no society assigned" });
      }
    } else {
      return res
        .status(403)
        .json({ message: "Only admins or super_admin can add residents" });
    }

    const username = email.split("@")[0];

    // Check duplicate email
    const existingUser = await pool.query(
      `SELECT * FROM users WHERE email = $1`,
      [email]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: "Email already in use." });
    }

    // Check duplicate phone
    const existingPhone = await pool.query(
      `SELECT * FROM users WHERE phone_number = $1`,
      [phone_number]
    );
    if (existingPhone.rows.length > 0) {
      return res.status(400).json({ message: "Phone number already in use." });
    }

    // Insert resident
    const insertUser = await pool.query(
      `INSERT INTO users (first_name, last_name, username, phone_number, email, role, society_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        first_name,
        last_name,
        username,
        phone_number,
        email,
        "resident",
        societyId,
      ]
    );

    const newUser = insertUser.rows[0];
    console.log("✅ Created Resident:", newUser);

    if (requesterData.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "CREATED_RESIDENT",
        description: `Sub Admin ${req.user.id} created resident with email: ${email} ${Date.now()}`,
      });
    }

    // Email verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at) 
       VALUES ($1, $2, $3)`,
      [newUser.id, verificationToken, expiresAt]
    );

    await sendVerificationEmail(username, email, verificationToken);

    return res.status(201).json({
      message: `Resident created. Email sent to verify and set password.`,
    });
  } catch (error) {
    console.error(`❌ Error creating resident: ${error.message}`);
    return res.status(500).json({ error: "Server Error" });
  }
};

const signIn = async (req, res) => {
  const { email, password, totpCode } = req.body;

  try {
    const queryRes = await runQuery(`SELECT * FROM users WHERE email = $1`, [
      String(email).trim(),
    ]);
    if (queryRes.rows.length === 0) {
      return res.status(404).json({ message: "Invalid Email" });
    }
    const user = queryRes.rows[0];

    // Check if user is blocked
    if (user.is_blocked) {
      return res
        .status(403)
        .json({ message: "Account has been blocked. Please contact support." });
    }

    if (user.society_id) {
      const societyCheck = await runQuery(
        `SELECT is_blocked FROM societies WHERE id = $1`,
        [user.society_id]
      );
      if (societyCheck.rows.length > 0 && societyCheck.rows[0].is_blocked) {
        return res.status(403).json({
          message: "Your society has been blocked. Please contact support."
        });
      }
    }

    // Check if user is verified
    if (!user.is_verified) {
      return res.status(403).json({
        message:
          "Please verify your email address before signing in. Check your email for a verification link.",
      });
    }

    const match = await comparePassword(password, user.password_hash);
    if (!match) {
      return res.status(404).json({ message: "Invalid Password" });
    }

    if (user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: user.id,
        activityType: "LOGIN",
        description: `Sub Admin ${user.first_name} ${user.last_name} Logged in at ${Date.now()}`,
      });
    }

    const isAdmin = user.role === "admin" || user.role === "super_admin" || user.role === "sub_admin";
    const mfaEnabled = user.mfa_enabled || false;
    const hasSecret = !!user.totp_secret;

    const userSociety = await runQuery(`SELECT * FROM societies WHERE id = $1`, [
      user.society_id,
    ]);

    if (isAdmin) {
      if (!mfaEnabled) {
        await runQuery(`UPDATE users SET mfa_enabled = TRUE WHERE id = $1`, [
          user.id,
        ]);
      }

      if (hasSecret) {
        if (!totpCode) {
          return res.status(400).json({
            message: "TOTP code is required",
            requiresMFA: true,
          });
        }

        const cleanTotpCode = String(totpCode).trim().replace(/\s/g, "");
        if (!/^\d{6}$/.test(cleanTotpCode)) {
          return res
            .status(400)
            .json({ message: "TOTP code must be 6 digits" });
        }

        const cleanSecret = String(user.totp_secret).trim().replace(/\s/g, "");

        const verified = speakeasy.totp.verify({
          secret: cleanSecret,
          encoding: "base32",
          token: cleanTotpCode,
          window: 4,
          step: 30,
        });

        if (!verified) {
          return res.status(400).json({ message: "Invalid TOTP code" });
        }
        // TOTP verified successfully, continue to generate tokens below
      } else {
        const tokens = generateTokens(user);

        await runQuery(
          `INSERT INTO refresh_tokens (user_id, token, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          [user.id, tokens.refresh_token]
        );

        return res.status(200).json({
          message:
            "Login successful. Please set up MFA to continue using the system.",
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          username: user.username,
          is_verified: user.is_verified,
          role: user.role,
          society_id: user.society_id,
          requiresMFASetup: true,
          society: userSociety.rows.length > 0 ? userSociety.rows[0].society_name : null,

        });
      }
    } else if (mfaEnabled && hasSecret) {
      if (!totpCode) {
        return res.status(400).json({
          message: "TOTP code is required",
          requiresMFA: true,
        });
      }

      const cleanTotpCode = String(totpCode).trim().replace(/\s/g, "");
      if (!/^\d{6}$/.test(cleanTotpCode)) {
        return res.status(400).json({ message: "TOTP code must be 6 digits" });
      }

      const cleanSecret = String(user.totp_secret).trim().replace(/\s/g, "");

      const verified = speakeasy.totp.verify({
        secret: cleanSecret,
        encoding: "base32",
        token: cleanTotpCode,
        window: 4,
        step: 30,
      });

      if (!verified) {
        return res.status(400).json({ message: "Invalid TOTP code" });
      }
    }

    const tokens = generateTokens(user);

    await runQuery(
      `INSERT INTO refresh_tokens (user_id, token, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP)`,
      [user.id, tokens.refresh_token]
    );


    const response = {
      message: "User logged in successfully",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      username: user.username,
      is_verified: user.is_verified,
      role: user.role,
      society_id: user.society_id || null,
      society: userSociety.rows.length > 0 ? userSociety.rows[0].society_name : null,
    };

    return res.status(200).json(response);
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Unable to sign in`, error: error.message });
  }
};

const signOut = async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ message: "Refresh token is required" });
    }

    await runQuery(`DELETE FROM refresh_tokens WHERE token = $1`, [
      refresh_token,
    ]);

    if (req.user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "SIGNED_OUT",
        description: `Sub Admin ${req.user.id} Signed Out at ${Date.now()}`,
      });
    }
    return res.status(200).json({ message: "User signed out successfully" });
  } catch (error) {
    return res.status(500).json({ message: `Unable to sign out` });
  }
};

const sendVerificationEmail = async (
  recipientUsername,
  recipientEmail,
  verificationToken
) => {
  const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

  try {
    if (!process.env.SENDER_EMAIL || !process.env.SENDER_PASSWORD) {
      const err = new Error("Email credentials missing");
      err.code = "EMAIL_CONFIG_MISSING";
      throw err;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SENDER_EMAIL,
        pass: process.env.SENDER_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `Green Guardian <${process.env.SENDER_EMAIL}>`,
      to: recipientEmail,
      subject: "🌱 Welcome to Green Guardian - Verify Your Email",
      html: verificationEmailHTML(recipientUsername, verificationLink),
    });
  } catch (error) {
    console.error("Error sending email:", error);
    if (!error.code) error.code = "EMAIL_SEND_FAILED";
    throw error;
  }
};

const verifyEmailAndSetPassword = async (req, res) => {
  const client = await pool.connect();
  try {
    const token = req.query.token;
    const { password, confirmPassword } = req.body;

    if (!token) return res.status(400).json({ message: "Token is required" });
    if (!password)
      return res.status(400).json({ message: `Password field is required.` });
    if (!confirmPassword)
      return res
        .status(400)
        .json({ message: `Confirm Password field is required.` });
    if (password !== confirmPassword)
      return res.status(400).json({ message: `Passwords donot match.` });

    // Validate token and current verification state
    const tokenQuery = await runQuery(
      `
      SELECT vt.*, u.id as uid, u.is_verified
      FROM email_verification_tokens vt
      JOIN users u ON vt.user_id = u.id
      WHERE vt.token = $1 AND vt.is_used = FALSE AND vt.expires_at > NOW()
      `,
      [token]
    );

    if (tokenQuery.rows.length === 0) {
      return res.status(400).json({ message: `Expired or invalid token` });
    }

    const row = tokenQuery.rows[0];
    if (row.is_verified === true) {
      return res.status(400).json({ message: `Email Already verified.` });
    }

    await client.query("BEGIN");

    const hashedPassword = await hashPassword(password);

    const updatePassword = await client.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [hashedPassword, row.user_id]
    );

    if (updatePassword.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({ message: `Error updating password.` });
    }

    await client.query(
      `UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1`,
      [row.user_id]
    );

    await client.query(
      `UPDATE email_verification_tokens SET is_used = TRUE WHERE token = $1`,
      [token]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: `Email successfully Verified and password is set. You can now log in. `,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.log(`Email Verification Failed`);
    return res
      .status(500)
      .json({ message: `Email Verification Failed`, error: error.message });
  } finally {
    client.release();
  }
};

const refreshToken = async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token)
      return res.status(401).json({ message: "Refresh token required" });

    // ✅ Validate refresh token signature
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);

    // ✅ Ensure token exists in DB (not revoked)
    const rtRow = await runQuery(
      `SELECT user_id FROM refresh_tokens WHERE token = $1`,
      [refresh_token]
    );
    if (rtRow.rows.length === 0) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    //  Load real user & role
    const userRes = await runQuery(`SELECT id, role FROM users WHERE id = $1`, [
      decoded.id,
    ]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ message: "Invalid user" });
    }
    const user = userRes.rows[0];

    const access_token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRY }
    );

    return res.status(200).json({ access_token });
  } catch (err) {
    return res
      .status(401)
      .json({ message: "Invalid refresh token", error: err.message });
  }
};

const listAdmins = async (req, res) => {
  try {
    const result = await runQuery(`SELECT * FROM users WHERE role = 'admin'`);
    return res.status(200).json({ admins: result.rows });
  } catch (error) {
    console.error("Error fetching admins:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    const userId = req.user.id; // From token verification middleware

    const need = requireAll({
      currentPassword,
      newPassword,
      confirmNewPassword,
    });
    if (!need.ok)
      return res.status(400).json({ message: "All fields are required" });

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ message: "New passwords do not match" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long" });
    }

    const userQuery = await runQuery(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId]
    );
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];

    const isCurrentPasswordValid = await comparePassword(
      currentPassword,
      user.password_hash
    );
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashedNewPassword = await hashPassword(newPassword);

    await runQuery(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hashedNewPassword, userId]
    );

    return res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    console.error(`Error changing password: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};

const updateProfile = async (req, res) => {
  try {
    console.log("Update profile request body:", req.body);

    const userId = req.user.id;
    let { first_name, last_name, phone_number, email, profile_picture } =
      req.body;

    if (
      !first_name ||
      !last_name ||
      !phone_number ||
      !email ||
      !profile_picture
    ) {
      return res.status(400).json({ message: "All fields  are required" });
    }

    console.log("Checkpoint 1");

    const phoneCheck = await pool.query(
      `SELECT * FROM users WHERE phone_number = $1 AND id != $2`,
      [phone_number, userId]
    );
    if (phoneCheck.rows.length > 0) {
      return res.status(400).json({ message: "Phone number already in use." });
    }

    console.log("Checkpoint 2");

    //check if the email format is valid
    const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!regex.test(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    const emailCheck = await pool.query(
      `SELECT * FROM users WHERE email = $1 AND id != $2`,
      [email, userId]
    );

    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ message: "Email already in use." });
    }

    console.log("Checkpoint 3");

    const updateQuery = await pool.query(
      `
      UPDATE users 
      SET first_name = $1, 
          last_name = $2, 
          phone_number = $3, 
          email = $4,
          profile_picture = $5,
          updated_at = NOW()
      WHERE id = $6
      RETURNING id, first_name, last_name, username, phone_number, email, profile_picture, role, society_id, is_verified, is_blocked, created_at, updated_at
      `,
      [first_name, last_name, phone_number, email, profile_picture, userId]
    );

    console.log("Checkpoint 4");

    if (req.user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "UPDATED_PROFILE",
        description: `Sub Admin ${req.user.id} updated profile at ${Date.now()}`,
      });
    }

    return res.status(200).json({
      message: "Profile updated successfully",
      user: updateQuery.rows[0],
    });
  } catch (error) {
    console.error(`Error updating profile: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};

const getProfileData = async (req, res) => {
  try {
    const userId = req.user.id;

    const userQuery = await pool.query(
      `SELECT id, first_name, last_name, username, phone_number, email, role,profile_picture, created_at, updated_at
        FROM users WHERE id = $1`,
      [userId]
    );
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    const user = userQuery.rows[0];
    return res.status(200).json({ user });
  } catch (error) {
    console.error(`Error fetching profile data: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email, client_type = "web" } = req.body;

    if (!email) return res.status(400).json({ message: "Email is required" });

    if (!isEmailValid(email))
      return res.status(400).json({ message: "Invalid email address" });

    if (!["web", "mobile"].includes(client_type)) {
      return res
        .status(400)
        .json({ message: "Invalid client_type. Must be 'web' or 'mobile'" });
    }

    const userQuery = await pool.query(
      `SELECT id, username, email, is_verified FROM users WHERE email = $1`,
      [email]
    );

    if (userQuery.rows.length === 0) {
      return res
        .status(200)
        .json({
          message: "If the email exists, a password reset link has been sent",
        });
    }

    const user = userQuery.rows[0];

    if (!user.is_verified) {
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await pool.query(
        `DELETE FROM email_verification_tokens WHERE user_id = $1`,
        [user.id]
      );

      await pool.query(
        `
            INSERT INTO email_verification_tokens (user_id, token, expires_at) 
            VALUES ($1, $2, $3)`,
        [user.id, verificationToken, expiresAt]
      );

      await sendVerificationEmail(user.username, user.email, verificationToken);

      return res.status(200).json({
        message:
          "Your email is not verified. A verification link has been sent to your email address.",
      });
    }

    if (client_type === "mobile") {
      const otp = generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.query(`DELETE FROM password_reset_otps WHERE user_id = $1`, [
        user.id,
      ]);

      await pool.query(
        `
            INSERT INTO password_reset_otps (user_id, otp, expires_at) 
            VALUES ($1, $2, $3)`,
        [user.id, otp, expiresAt]
      );

      await sendPasswordResetOTPEmail(user.username, user.email, otp);

      return res.status(200).json({
        message: "If the email exists, a password reset OTP has been sent",
      });
    } else {
      const resetToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [
        user.id,
      ]);

      await pool.query(
        `
            INSERT INTO password_reset_tokens (user_id, token, expires_at) 
            VALUES ($1, $2, $3)`,
        [user.id, resetToken, expiresAt]
      );

      await sendPasswordResetEmail(user.username, user.email, resetToken);

      return res.status(200).json({
        message: "If the email exists, a password reset link has been sent",
      });
    }
  } catch (error) {
    console.error(`Error in forgot password: ${error.message}`);
    if (
      error.code === "EMAIL_SEND_FAILED" ||
      error.code === "EMAIL_CONFIG_MISSING"
    ) {
      return res
        .status(502)
        .json({ message: "Unable to send email right now" });
    }
    return res.status(500).json({ message: "Server Error" });
  }
};

const resetPassword = async (req, res) => {
  const client = await pool.connect();
  try {
    const token = req.query.token;
    const { newPassword, confirmPassword } = req.body;

    if (!token)
      return res.status(400).json({ message: "Reset token is required" });
    if (!newPassword || !confirmPassword)
      return res.status(400).json({ message: "All fields are required" });
    if (newPassword !== confirmPassword)
      return res.status(400).json({ message: "Passwords do not match" });
    if (newPassword.length < 6)
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long" });

    const tokenQuery = await runQuery(
      `
      SELECT rt.*, u.id as user_id, u.email
      FROM password_reset_tokens rt
      JOIN users u ON rt.user_id = u.id
      WHERE rt.token = $1 AND rt.is_used = FALSE AND rt.expires_at > NOW()`,
      [token]
    );

    if (tokenQuery.rows.length === 0) {
      return res
        .status(400)
        .json({ message: "Invalid or expired reset token" });
    }

    const resetTokenData = tokenQuery.rows[0];

    await client.query("BEGIN");

    const hashedPassword = await hashPassword(newPassword);

    // Update user password and mark as verified (since they have access to email)
    await client.query(
      `UPDATE users SET password_hash = $1, is_verified = TRUE, updated_at = NOW() WHERE id = $2`,
      [hashedPassword, resetTokenData.user_id]
    );

    await client.query(
      `UPDATE password_reset_tokens SET is_used = TRUE WHERE token = $1`,
      [token]
    );

    await client.query("COMMIT");

    return res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error resetting password: ${error.message}`);
    return res.status(500).json({ message: "Server Error" });
  } finally {
    client.release();
  }
};

const sendPasswordResetEmail = async (
  recipientUsername,
  recipientEmail,
  resetToken
) => {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  try {
    if (!process.env.SENDER_EMAIL || !process.env.SENDER_PASSWORD) {
      const err = new Error("Email credentials missing");
      err.code = "EMAIL_CONFIG_MISSING";
      throw err;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SENDER_EMAIL,
        pass: process.env.SENDER_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `Green Guardian <${process.env.SENDER_EMAIL}>`,
      to: recipientEmail,
      subject: "🔐 Green Guardian - Password Reset Request",
      html: resetEmailHTML(recipientUsername, resetLink),
    });
  } catch (error) {
    console.error("Error sending password reset email:", error);
    if (!error.code) error.code = "EMAIL_SEND_FAILED";
    throw error;
  }
};

const sendPasswordResetOTPEmail = async (
  recipientUsername,
  recipientEmail,
  otp
) => {
  console.log(`Password Reset OTP: ${otp}`);

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SENDER_EMAIL,
        pass: process.env.SENDER_PASSWORD,
      },
    });

    const mailOptions = {
      from: `Green Guardian <${process.env.SENDER_EMAIL}>`,
      to: recipientEmail,
      subject: "🔐 Green Guardian - Password Reset OTP",
      html: `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Password Reset OTP</title>
                </head>
                <body style="margin: 0; padding: 0; font-family: 'Arial', sans-serif; background-color: #f4f7f5;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                        
                        <!-- Header -->
                        <div style="background: linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%); padding: 40px 20px; text-align: center;">
                            <div style="background-color: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                                <span style="font-size: 40px;">🔐</span>
                            </div>
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: bold;">Green Guardian</h1>
                            <p style="color: #e8f5e8; margin: 10px 0 0 0; font-size: 16px;">Password Reset OTP</p>
                        </div>

                        <!-- Content -->
                        <div style="padding: 40px 30px;">
                            <h2 style="color: #2E7D32; margin-bottom: 20px; font-size: 24px;">Hello ${recipientUsername}! 👋</h2>
                            
                            <p style="color: #555555; line-height: 1.6; font-size: 16px; margin-bottom: 25px;">
                                We received a request to reset your password for your Green Guardian mobile app. Use the OTP below to proceed with password reset.
                            </p>

                            <div style="background-color: #f8fff9; border-left: 4px solid #4CAF50; padding: 20px; margin: 25px 0; border-radius: 4px;">
                                <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">🔢 Your Password Reset OTP</h3>
                                <p style="color: #666666; margin: 0; line-height: 1.5;">
                                    Enter this 6-digit code in your mobile app to reset your password:
                                </p>
                            </div>

                            <!-- OTP Display -->
                            <div style="text-align: center; margin: 35px 0;">
                                <div style="background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); 
                                            color: #ffffff; 
                                            padding: 20px 40px; 
                                            border-radius: 15px; 
                                            font-weight: bold; 
                                            font-size: 32px; 
                                            display: inline-block;
                                            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
                                            letter-spacing: 8px;">
                                    ${otp}
                                </div>
                            </div>

                            <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 15px; margin: 30px 0;">
                                <p style="color: #856404; margin: 0; font-size: 14px; text-align: center;">
                                    ⏰ This OTP will expire in 10 minutes for security purposes.
                                </p>
                            </div>

                            <div style="background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 6px; padding: 15px; margin: 30px 0;">
                                <p style="color: #721c24; margin: 0; font-size: 14px; text-align: center;">
                                    🔒 If you didn't request this password reset, please ignore this email and contact support.
                                </p>
                            </div>
                        </div>

                        <!-- Footer -->
                        <div style="background-color: #f8fff9; padding: 30px; text-align: center; border-top: 1px solid #e8f5e8;">
                            <div style="margin-bottom: 20px;">
                                <span style="font-size: 24px; margin: 0 5px;">🔐</span>
                                <span style="font-size: 24px; margin: 0 5px;">🌱</span>
                                <span style="font-size: 24px; margin: 0 5px;">📱</span>
                            </div>
                            
                            <p style="color: #2E7D32; margin: 0 0 10px 0; font-weight: bold; font-size: 16px;">
                                Secure Mobile Experience!
                            </p>
                            
                            <p style="color: #666666; font-size: 14px; margin: 0 0 15px 0; line-height: 1.4;">
                                This OTP is specifically for your mobile app password reset.
                            </p>
                            
                            <p style="color: #888888; font-size: 12px; margin: 0;">
                                This email was sent from Green Guardian. If you didn't request a password reset, please ignore this email.
                            </p>
                            
                            <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e8f5e8;">
                                <p style="color: #aaaaaa; font-size: 11px; margin: 0;">
                                    © 2025 Green Guardian. All rights reserved.
                                </p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
            `,
    };

    const result = await transporter.sendMail(mailOptions);
    console.log("Password reset OTP email sent successfully:", result.response);
    return result;
  } catch (error) {
    console.error("Error sending password reset OTP email:", error);
    throw error;
  }
};

const verifyOTPAndResetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword, confirmPassword } = req.body;

    if (!email || !otp || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long" });
    }

    // Verify OTP and get user
    const otpQuery = await pool.query(
      `
            SELECT o.*, u.id as user_id, u.email, u.username
            FROM password_reset_otps o
            JOIN users u ON o.user_id = u.id
            WHERE u.email = $1 AND o.otp = $2 AND o.is_used = FALSE AND o.expires_at > NOW()`,
      [email, otp]
    );

    if (otpQuery.rows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const otpData = otpQuery.rows[0];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Hash new password
      const hashedPassword = await hashPassword(newPassword);

      // Update user password and mark as verified (since they have access to email)
      await client.query(
        `UPDATE users SET password_hash = $1, is_verified = TRUE, updated_at = NOW() WHERE id = $2`,
        [hashedPassword, otpData.user_id]
      );

      // Mark OTP as used
      await client.query(
        `UPDATE password_reset_otps SET is_used = TRUE WHERE id = $1`,
        [otpData.id]
      );

      await client.query("COMMIT");

      return res.status(200).json({ message: "Password reset successfully" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(
      `Error verifying OTP and resetting password: ${error.message}`
    );
    return res.status(500).json({ message: "Server Error" });
  }
};

// Super Admin Functions
const getAllUsers = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page ?? "1", 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? "10", 10) || 10;
    const { role, search, societyId } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = "";
    const values = [];
    let idx = 1;

    // Role-based access control
    const currentUserRole = req.user.role;
    const currentUserId = req.user.id;
    const currentUserSocietyId = req.user.society_id;

    // Super admin can see all users, admin can only see users from their society
    if (currentUserRole === "admin" || currentUserRole === "sub_admin") {
      const cond = `u.society_id = $${idx++} AND u.id != $${idx++}`;
      whereClause = `WHERE ${cond}`;
      values.push(currentUserSocietyId, currentUserId);
    } else if (currentUserRole === "super_admin") {
      const cond = `u.id != $${idx++}`;
      whereClause = `WHERE ${cond}`;
      values.push(currentUserId);
    }

    // Handle role filtering
    if (role && role !== "all") {
      // Support comma-separated roles
      const roles = role
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r);
      if (roles.length > 0) {
        const rolePlaceholders = roles.map(() => `$${idx++}`).join(",");
        const cond = `u.role IN (${rolePlaceholders})`;
        whereClause = whereClause
          ? `${whereClause} AND ${cond}`
          : `WHERE ${cond}`;
        values.push(...roles);
      }
    }

    // Society filtering (only for super admin)
    if (currentUserRole === "super_admin" && societyId && societyId !== "all") {
      const cond = `u.society_id = $${idx++}`;
      whereClause = whereClause
        ? `${whereClause} AND ${cond}`
        : `WHERE ${cond}`;
      values.push(societyId);
    }

    if (search) {
      const cond = `(u.first_name ILIKE $${idx} OR u.last_name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.username ILIKE $${idx})`;
      whereClause = whereClause
        ? `${whereClause} AND ${cond}`
        : `WHERE ${cond}`;
      values.push(`%${search}%`);
      idx++;
    }

    const countQuery = `
      SELECT COUNT(*)
      FROM users u
      LEFT JOIN societies s ON u.society_id = s.id
      ${whereClause}
    `;
    const countResult = await runQuery(countQuery, values);
    const totalUsers = Number.parseInt(countResult.rows[0].count, 10);

    const usersQuery = `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.username,
        u.email,
        u.phone_number,
        u.role,
        u.is_verified,
        u.is_blocked,
        u.created_at,
        u.updated_at,
        u.society_id,
        s.society_name,
        s.city,
        s.state
      FROM users u
      LEFT JOIN societies s ON u.society_id = s.id
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const usersResult = await runQuery(usersQuery, [...values, limit, offset]);

    const usersBySociety = {};
    const usersWithoutSociety = [];

    usersResult.rows.forEach((user) => {
      if (user.society_id) {
        if (!usersBySociety[user.society_id]) {
          usersBySociety[user.society_id] = {
            society: {
              id: user.society_id,
              name: user.society_name,
              city: user.city,
              state: user.state,
            },
            users: [],
          };
        }
        usersBySociety[user.society_id].users.push({
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          username: user.username,
          email: user.email,
          phone_number: user.phone_number,
          role: user.role,
          is_verified: user.is_verified,
          is_blocked: user.is_blocked,
          created_at: user.created_at,
          updated_at: user.updated_at,
        });
      } else {
        usersWithoutSociety.push({
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          username: user.username,
          email: user.email,
          phone_number: user.phone_number,
          role: user.role,
          is_verified: user.is_verified,
          is_blocked: user.is_blocked,
          created_at: user.created_at,
          updated_at: user.updated_at,
        });
      }
    });

    return res.status(200).json({
      users: usersResult.rows,
      usersBySociety,
      usersWithoutSociety,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalUsers / limit),
        totalUsers,
        limit,
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

//Get users based on society id
const getUsersBySociety = async (req, res) => {
  console.log("Get users by society request initiated");

  console.log("Requesting user info:", req.user);

  try {
    const userId = req.user.id;

    // First, get the society_id of the requesting user
    const userQuery = await pool.query(
      `SELECT society_id FROM users
      WHERE id = $1`,
      [userId]
    );
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    const societyId = userQuery.rows[0].society_id;

    if (!societyId) {
      return res
        .status(400)
        .json({ message: "User is not associated with any society" });
    }

    const result = await pool.query(
      `SELECT id, first_name, last_name, username, email, phone_number, role, is_verified, is_blocked, created_at, updated_at

            FROM users WHERE society_id = $1`,
      [societyId]
    );
    return res.status(200).json({
      users: result.rows,
    });
  } catch (error) {
    console.error("Error fetching users by society:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { firstName, lastName, phone, email, role } = req.body;
    const currentUser = req.user;

    // Check if user exists
    const userCheck = await runQuery(
      `SELECT id, role FROM users WHERE id = $1`,
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const targetUser = userCheck.rows[0];

    // Authorization checks
    if (currentUser.role === "admin" || currentUser.role === "sub_admin") {
      // Admin can only update users from their own society
      const adminSocietyCheck = await runQuery(
        `SELECT society_id FROM users WHERE id = $1`,
        [currentUser.id]
      );

      if (
        adminSocietyCheck.rows.length === 0 ||
        !adminSocietyCheck.rows[0].society_id
      ) {
        return res
          .status(403)
          .json({ message: "Admin must be associated with a society" });
      }

      const targetSocietyCheck = await runQuery(
        `SELECT society_id FROM users WHERE id = $1`,
        [userId]
      );

      if (
        targetSocietyCheck.rows.length === 0 ||
        targetSocietyCheck.rows[0].society_id !==
        adminSocietyCheck.rows[0].society_id
      ) {
        return res
          .status(403)
          .json({ message: "Can only update users from your society" });
      }

      // Admin cannot change roles to super_admin
      if (role && role === "super_admin") {
        return res
          .status(403)
          .json({ message: "Cannot assign super admin role" });
      }
    } else if (currentUser.role !== "super_admin") {
      return res.status(403).json({ message: "Unauthorized to update users" });
    }

    // Prevent updating super_admin users (except by super_admin)
    if (
      targetUser.role === "super_admin" &&
      currentUser.role !== "super_admin"
    ) {
      return res
        .status(403)
        .json({ message: "Cannot update super admin users" });
    }

    // Build update query dynamically
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (firstName !== undefined) {
      fields.push(`first_name = $${paramIndex++}`);
      values.push(firstName.trim());
    }
    if (lastName !== undefined) {
      fields.push(`last_name = $${paramIndex++}`);
      values.push(lastName.trim());
    }
    if (phone !== undefined) {
      fields.push(`phone_number = $${paramIndex++}`);
      values.push(phone);
    }
    if (email !== undefined) {
      if (!isEmailValid(email)) {
        return res.status(400).json({ message: "Invalid email address" });
      }

      // Check email uniqueness (excluding current user)
      const emailCheck = await runQuery(
        `SELECT id FROM users WHERE email = $1 AND id != $2`,
        [email.trim(), userId]
      );

      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ message: "Email already in use" });
      }

      fields.push(`email = $${paramIndex++}`);
      values.push(email.trim());
    }
    if (role !== undefined) {
      // // Only super_admin can change roles
      // if (currentUser.role !== "super_admin") {
      //   return res
      //     .status(403)
      //     .json({ message: "Only super admin can change user roles" });
      // }

      // Prevent changing super_admin role
      if (targetUser.role === "super_admin" && role !== "super_admin") {
        return res
          .status(403)
          .json({ message: "Cannot change super admin role" });
      }

      fields.push(`role = $${paramIndex++}`);
      values.push(role);

      // Auto-enable MFA when role is changed to admin or super_admin
      if (role === "admin" || role === "super_admin") {
        fields.push(`mfa_enabled = TRUE`);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields provided for update" });
    }

    // Add updated_at and user_id
    fields.push(`updated_at = NOW()`);
    values.push(userId);

    const updateQuery = `
      UPDATE users 
      SET ${fields.join(", ")} 
      WHERE id = $${paramIndex}
      RETURNING id, first_name, last_name, email, phone_number, role, is_verified, is_blocked, created_at, updated_at
    `;

    const result = await runQuery(updateQuery, values);


    if (req.user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "UPDATE_USER",
        description: `Sub Admin ${req.user.id} updated data of ${role} with email: ${email} ${Date.now()}`,
      });
    }

    return res.status(200).json({
      message: "User updated successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const blockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isBlocked } = req.body;
    const currentUser = req.user;

    if (typeof isBlocked !== "boolean") {
      return res
        .status(400)
        .json({ message: "isBlocked must be a boolean value" });
    }

    const userCheck = await runQuery(
      `SELECT id, role, society_id FROM users WHERE id = $1`,
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const targetUser = userCheck.rows[0];

    // Authorization checks
    if (currentUser.role === "admin" || currentUser.role === "sub_admin") {
      // Admin can only block users from their own society
      const adminSocietyCheck = await runQuery(
        `SELECT society_id FROM users WHERE id = $1`,
        [currentUser.id]
      );

      if (
        adminSocietyCheck.rows.length === 0 ||
        !adminSocietyCheck.rows[0].society_id
      ) {
        return res
          .status(403)
          .json({ message: "Admin must be associated with a society" });
      }

      if (targetUser.society_id !== adminSocietyCheck.rows[0].society_id) {
        return res
          .status(403)
          .json({ message: "Can only block users from your society" });
      }

      // Admin cannot block super_admin users
      if (targetUser.role === "super_admin") {
        return res
          .status(403)
          .json({ message: "Cannot block super admin users" });
      }
    } else if (currentUser.role !== "super_admin") {
      return res.status(403).json({ message: "Unauthorized to block users" });
    }

    // Prevent blocking super_admin users (except by super_admin)
    if (
      targetUser.role === "super_admin" &&
      currentUser.role !== "super_admin"
    ) {
      return res
        .status(403)
        .json({ message: "Cannot block super admin users" });
    }

    const result = await runQuery(
      `UPDATE users SET is_blocked = $1, updated_at = NOW() WHERE id = $2 RETURNING id, first_name, last_name, email, role, is_blocked`,
      [isBlocked, userId]
    );

    if (req.user.role === "sub_admin") {
      await logSubAdminActivity({
        subAdmin: req.user.id,
        activityType: "BLOCK_USER",
        description: `Sub Admin ${req.user.id} ${isBlocked ? 'blocked' : 'unblocked'} user with email: ${result.rows[0].email} at ${Date.now()}`,
      });
    }

    return res.status(200).json({
      message: `User ${isBlocked ? "blocked" : "unblocked"} successfully`,
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Error blocking user:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = req.user;

    const userCheck = await runQuery(
      `SELECT id, role, society_id FROM users WHERE id = $1`,
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const targetUser = userCheck.rows[0];

    // Authorization checks
    if (currentUser.role === "admin" || currentUser.role === "sub_admin") {
      // Admin can only delete users from their own society
      const adminSocietyCheck = await runQuery(
        `SELECT society_id FROM users WHERE id = $1`,
        [currentUser.id]
      );

      if (
        adminSocietyCheck.rows.length === 0 ||
        !adminSocietyCheck.rows[0].society_id
      ) {
        return res
          .status(403)
          .json({ message: "Admin must be associated with a society" });
      }

      if (targetUser.society_id !== adminSocietyCheck.rows[0].society_id) {
        return res
          .status(403)
          .json({ message: "Can only delete users from your society" });
      }

      // Admin cannot delete super_admin users
      if (targetUser.role === "super_admin") {
        return res
          .status(403)
          .json({ message: "Cannot delete super admin users" });
      }
    } else if (currentUser.role !== "super_admin") {
      return res.status(403).json({ message: "Unauthorized to delete users" });
    }

    // Prevent deleting super_admin users (except by super_admin)
    if (
      targetUser.role === "super_admin" &&
      currentUser.role !== "super_admin"
    ) {
      return res
        .status(403)
        .json({ message: "Cannot delete super admin users" });
    }

    await runQuery(`DELETE FROM users WHERE id = $1`, [userId]);

    return res.status(200).json({
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getSystemStats = async (req, res) => {
  try {
    const userStats = await runQuery(`
      SELECT
        role,
        COUNT(*) as count,
        COUNT(CASE WHEN is_verified = true THEN 1 END) as verified_count,
        COUNT(CASE WHEN is_blocked = true THEN 1 END) as blocked_count
      FROM users
      GROUP BY role
    `);

    const societyCount = await runQuery(
      `SELECT COUNT(*) as count FROM societies`
    );

    const recentActivity = await runQuery(`
      SELECT
        COUNT(*) as new_users,
        COUNT(CASE WHEN role = 'admin' OR role = 'sub_admin' THEN 1 END) as new_admins,
        COUNT(CASE WHEN role = 'customer_support' THEN 1 END) as new_staff
      FROM users
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `);

    const usersBySociety = await runQuery(`
      SELECT
        s.id,
        s.society_name,
        s.city,
        s.state,
        u.role,
        COUNT(*) as count
      FROM societies s
      LEFT JOIN users u ON s.id = u.society_id
      WHERE u.id IS NOT NULL
      GROUP BY s.id, s.society_name, s.city, s.state, u.role
      ORDER BY s.society_name, u.role
    `);

    const usersWithoutSociety = await runQuery(`
      SELECT
        role,
        COUNT(*) as count
      FROM users
      WHERE society_id IS NULL
      GROUP BY role
    `);

    const societiesWithUsers = {};
    usersBySociety.rows.forEach((row) => {
      if (!societiesWithUsers[row.id]) {
        societiesWithUsers[row.id] = {
          society: {
            id: row.id,
            name: row.society_name,
            city: row.city,
            state: row.state,
          },
          userCounts: [],
        };
      }
      societiesWithUsers[row.id].userCounts.push({
        role: row.role,
        count: Number.parseInt(row.count, 10),
      });
    });

    return res.status(200).json({
      userStats: userStats.rows.map((r) => ({
        role: r.role,
        count: Number.parseInt(r.count, 10),
        verified_count: Number.parseInt(r.verified_count, 10),
        blocked_count: Number.parseInt(r.blocked_count, 10),
      })),
      societyCount: Number.parseInt(societyCount.rows[0].count, 10),
      recentActivity: {
        new_users: Number.parseInt(recentActivity.rows[0].new_users, 10),
        new_admins: Number.parseInt(recentActivity.rows[0].new_admins, 10),
        new_staff: Number.parseInt(recentActivity.rows[0].new_staff, 10),
      },
      societiesWithUsers: Object.values(societiesWithUsers),
      usersWithoutSociety: usersWithoutSociety.rows.map((r) => ({
        role: r.role,
        count: Number.parseInt(r.count, 10),
      })),
    });
  } catch (error) {
    console.error("Error fetching system stats:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const generateMFASecret = async (req, res) => {
  try {
    const userId = req.user.id;

    const userQuery = await runQuery(
      `SELECT id, email, username, role, mfa_enabled FROM users WHERE id = $1`,
      [userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];

    const secret = speakeasy.generateSecret({
      name: `Green Guardian (${user.email || user.username})`,
      issuer: "Green Guardian",
      length: 32,
    });

    const cleanSecret = secret.base32.trim().replace(/\s/g, "");
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    await runQuery(
      `UPDATE users SET totp_secret = $1, mfa_verified = FALSE WHERE id = $2`,
      [cleanSecret, userId]
    );

    return res.status(200).json({
      secret: cleanSecret,
      qrCode: qrCodeUrl,
      manualEntryKey: cleanSecret,
      message:
        "MFA secret generated. Please verify with a TOTP code to enable MFA.",
    });
  } catch (error) {
    console.error("Error generating MFA secret:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const enableMFA = async (req, res) => {
  try {
    const { totpCode } = req.body;
    const userId = req.user.id;

    if (!totpCode) {
      return res.status(400).json({ message: "TOTP code is required" });
    }

    const cleanTotpCode = String(totpCode).trim().replace(/\s/g, "");
    if (!/^\d{6}$/.test(cleanTotpCode)) {
      return res.status(400).json({ message: "TOTP code must be 6 digits" });
    }

    const userQuery = await runQuery(
      `SELECT id, totp_secret, role, mfa_enabled FROM users WHERE id = $1`,
      [userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];

    if (!user.totp_secret) {
      return res
        .status(400)
        .json({ message: "Please generate MFA secret first" });
    }

    const cleanSecret = String(user.totp_secret).trim().replace(/\s/g, "");

    const verified = speakeasy.totp.verify({
      secret: cleanSecret,
      encoding: "base32",
      token: cleanTotpCode,
      window: 4,
      step: 30,
    });

    if (!verified) {
      return res.status(400).json({
        message: "Invalid TOTP code. Please try again.",
      });
    }

    await runQuery(
      `UPDATE users SET mfa_enabled = TRUE, mfa_verified = TRUE WHERE id = $1`,
      [userId]
    );

    return res.status(200).json({
      message: "MFA enabled successfully",
      mfaEnabled: true,
    });
  } catch (error) {
    console.error("Error enabling MFA:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const verifyMFA = async (req, res) => {
  try {
    const { email, totpCode } = req.body;

    if (!email || !totpCode) {
      return res
        .status(400)
        .json({ message: "Email and TOTP code are required" });
    }

    const userQuery = await runQuery(
      `SELECT id, totp_secret, mfa_enabled, role FROM users WHERE email = $1`,
      [String(email).trim()]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];

    if (!user.mfa_enabled || !user.totp_secret) {
      return res
        .status(400)
        .json({ message: "MFA is not enabled for this user" });
    }

    const cleanTotpCode = String(totpCode).trim().replace(/\s/g, "");
    if (!/^\d{6}$/.test(cleanTotpCode)) {
      return res.status(400).json({ message: "TOTP code must be 6 digits" });
    }

    const cleanSecret = String(user.totp_secret).trim().replace(/\s/g, "");

    const verified = speakeasy.totp.verify({
      secret: cleanSecret,
      encoding: "base32",
      token: cleanTotpCode,
      window: 4,
      step: 30,
    });

    if (!verified) {
      return res.status(400).json({ message: "Invalid TOTP code" });
    }

    return res.status(200).json({
      message: "MFA verified successfully",
      verified: true,
    });
  } catch (error) {
    console.error("Error verifying MFA:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const disableMFA = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user details
    const userQuery = await runQuery(
      `SELECT id, role, mfa_enabled FROM users WHERE id = $1`,
      [userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];

    // Admin and super_admin cannot disable MFA
    if (user.role === "admin" || user.role === "super_admin") {
      return res.status(403).json({
        message: "MFA cannot be disabled for admin and super_admin users",
      });
    }

    // Disable MFA
    await runQuery(
      `UPDATE users SET mfa_enabled = FALSE, mfa_verified = FALSE, totp_secret = NULL WHERE id = $1`,
      [userId]
    );

    return res.status(200).json({
      message: "MFA disabled successfully",
      mfaEnabled: false,
    });
  } catch (error) {
    console.error("Error disabling MFA:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getMFAStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const userQuery = await runQuery(
      `SELECT id, role, mfa_enabled, mfa_verified, totp_secret FROM users WHERE id = $1`,
      [userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userQuery.rows[0];
    const isAdmin = user.role === "admin" || user.role === "super_admin";

    return res.status(200).json({
      mfaEnabled: user.mfa_enabled || false,
      mfaVerified: user.mfa_verified || false,
      canDisable: !isAdmin, // Only non-admin users can disable MFA
      isRequired: isAdmin, // MFA is required for admin/super_admin
      hasSecret: !!user.totp_secret,
    });
  } catch (error) {
    console.error("Error getting MFA status:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  refreshToken,
  signIn,
  signOut,
  addAdminAndStaff,
  verifyEmailAndSetPassword,
  listAdmins,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyOTPAndResetPassword,
  getAllUsers,
  updateUser,
  blockUser,
  deleteUser,
  getSystemStats,
  getProfileData,
  updateProfile,
  addResident,
  getUsersBySociety,
  generateMFASecret,
  enableMFA,
  verifyMFA,
  disableMFA,
  getMFAStatus,
};
