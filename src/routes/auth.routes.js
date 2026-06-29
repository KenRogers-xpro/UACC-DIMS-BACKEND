import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { generateToken } from '../lib/jwt.js'
import { logAudit } from '../lib/audit.js'
import { success, error, serverError } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return error(res, 'Email and password are required')
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).toLowerCase().trim() },
    })

    if (!user) return error(res, 'Invalid email or password', 401)
    if (!user.isActive) {
      return error(res, 'Your account has been deactivated. Contact IT Administrator.', 401)
    }

    const passwordMatch = await bcrypt.compare(String(password), user.password)
    if (!passwordMatch) return error(res, 'Invalid email or password', 401)

    const token = generateToken({
      id:         user.id,
      email:      user.email,
      role:       user.role,
      department: user.department,
      name:       user.name,
    })

    await logAudit({
      userId:      user.id,
      action:      'LOGIN',
      module:      'Authentication',
      description: `${user.name} (${user.role}) logged in`,
      ipAddress:   req.ip,
    })

    return success(res, {
      token,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        department: user.department,
      },
    }, 'Login successful')
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    await logAudit({
      userId:      req.user.id,
      action:      'LOGOUT',
      module:      'Authentication',
      description: `${req.user.name} logged out`,
      ipAddress:   req.ip,
    })
    return success(res, null, 'Logged out successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  return success(res, req.user)
})

export default router
