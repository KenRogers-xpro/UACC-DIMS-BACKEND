const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { success, error, serverError } = require('../lib/response');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit, getClientIp } = require('../lib/audit');

const router = express.Router();

/**
 * @route   GET /api/users
 * @desc    Get all users (IT Admin only)
 * @access  Private / Admin
 */
router.get('/', authenticate, authorize('IT_ADMINISTRATOR', 'GENERAL_MANAGER'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        isActive: true,
        createdAt: true,
        _count: {
          select: { activityLogs: true }, // Simple usage stat
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Mock lastLogin since we only track it in Audit logs in this design
    const enhancedUsers = users.map(u => ({
      ...u,
      lastLogin: u.createdAt, // Or query audit logs if needed
    }));

    return success(res, enhancedUsers);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/users
 * @desc    Create a new user
 * @access  Private / Admin
 */
router.post('/', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body;

    if (!name || !email || !password || !role || !department) {
      return error(res, 'All fields are required');
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return error(res, 'Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
        department,
      },
      select: { id: true, name: true, email: true, role: true, department: true },
    });

    await logAudit({
      userId: req.user.id,
      action: 'USER_CREATED',
      module: 'Users',
      description: `Created new user account: ${name} (${email}) — Role: ${role}`,
      ipAddress: getClientIp(req),
    });

    return success(res, newUser, 201);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   PUT /api/users/:id
 * @desc    Update a user
 * @access  Private / Admin
 */
router.put('/:id', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, department } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: Number(id) },
      data: { name, email, role, department },
      select: { id: true, name: true, email: true, role: true, department: true },
    });

    await logAudit({
      userId: req.user.id,
      action: 'USER_UPDATED',
      module: 'Users',
      description: `Updated user profile: ${name} (${email})`,
      ipAddress: getClientIp(req),
    });

    return success(res, updatedUser);
  } catch (err) {
    if (err.code === 'P2025') return error(res, 'User not found', 404);
    return serverError(res, err);
  }
});

/**
 * @route   PATCH /api/users/:id/toggle
 * @desc    Toggle user active status
 * @access  Private / Admin
 */
router.patch('/:id/toggle', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Cannot deactivate yourself
    if (Number(id) === req.user.id) {
      return error(res, 'You cannot deactivate your own account');
    }

    const user = await prisma.user.findUnique({ where: { id: Number(id) } });
    if (!user) return error(res, 'User not found', 404);

    const updatedUser = await prisma.user.update({
      where: { id: Number(id) },
      data: { isActive: !user.isActive },
      select: { id: true, name: true, isActive: true },
    });

    const actionText = updatedUser.isActive ? 'Reactivated' : 'Deactivated';
    await logAudit({
      userId: req.user.id,
      action: updatedUser.isActive ? 'USER_UPDATED' : 'USER_DEACTIVATED',
      module: 'Users',
      description: `Updated user profile: ${updatedUser.name} — Status changed to ${updatedUser.isActive ? 'Active' : 'Inactive'}`,
      ipAddress: getClientIp(req),
    });

    return success(res, updatedUser);
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
