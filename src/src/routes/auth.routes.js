const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { generateToken } = require('../lib/jwt');
const { logAudit, getClientIp } = require('../lib/audit');
const { success, error, serverError } = require('../lib/response');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user & get token
 * @access  Public
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return error(res, 'Please provide an email and password');
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.isActive) {
      // Log failed attempt silently if user exists but inactive, etc.
      // Or just generic "Invalid credentials"
      return error(res, 'Invalid credentials or inactive account', 401);
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return error(res, 'Invalid credentials', 401);
    }

    // Generate JWT
    const token = generateToken(user);

    // Audit Log
    await logAudit({
      userId: user.id,
      action: 'LOGIN',
      module: 'Auth',
      description: `Successful login from ${getClientIp(req)}`,
      ipAddress: getClientIp(req),
    });

    // Return token and basic user info
    return success(res, {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user (Audit logging mostly, client handles token deletion)
 * @access  Private
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    await logAudit({
      userId: req.user.id,
      action: 'LOGOUT',
      module: 'Auth',
      description: `User logged out from ${getClientIp(req)}`,
      ipAddress: getClientIp(req),
    });

    return success(res, { message: 'Logged out successfully' });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile (using JWT)
 * @access  Private
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    // We can fetch fresh data from DB just to be sure,
    // or just return req.user since it has the basics.
    // Fetching fresh handles if role/status changed while logged in.
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return error(res, 'Account inactive or not found', 401);
    }

    return success(res, { user });
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
