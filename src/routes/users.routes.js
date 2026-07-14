import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

// GET /api/users
router.get('/', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { search = '', role = '', status = '' } = req.query

    const where = {
      AND: [
        search ? {
          OR: [
            { name:  { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        } : {},
        role   ? { role }                      : {},
        status === 'ACTIVE'   ? { isActive: true }  : {},
        status === 'INACTIVE' ? { isActive: false } : {},
      ],
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, role: true,
        department: true, isActive: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    return success(res, users)
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/users
router.post('/', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body

    if (!name || !email || !password || !role || !department) {
      return error(res, 'All fields are required')
    }

    if (password.length < 6) {
      return error(res, 'Password must be at least 6 characters')
    }

    const existing = await prisma.user.findUnique({
      where: { email: String(email).toLowerCase().trim() }
    })
    if (existing) return error(res, 'User with this email already exists')

    const hashedPassword = await bcrypt.hash(password, 12)

    const user = await prisma.user.create({
      data: {
        name:      String(name).trim(),
        email:     String(email).toLowerCase().trim(),
        password:  hashedPassword,
        role,
        department,
        isActive:  true,
      },
      select: {
        id: true, name: true, email: true,
        role: true, department: true, isActive: true,
      },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'USER_CREATED',
      module:      'User Management',
      description: `Created user: ${name} (${email}) — ${role}`,
      ipAddress:   req.ip,
    })

    return success(res, user, 'User created successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// PATCH /api/users/:id
router.patch('/:id', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const { action, name, role, department, password, isActive } = req.body
    const targetId = parseInt(req.params.id)

    const user = await prisma.user.findUnique({ where: { id: targetId } })
    if (!user) return notFound(res, 'User not found')

    if (targetId === req.user.id && isActive === false) {
      return error(res, 'You cannot deactivate your own account')
    }

    let updateData = {}
    let auditDesc  = ''

    if (action === 'TOGGLE_STATUS') {
      updateData = { isActive: !user.isActive }
      auditDesc  = `${!user.isActive ? 'Activated' : 'Deactivated'} user: ${user.name}`
    } else if (action === 'UPDATE_PROFILE') {
      updateData = {
        name:       name       || user.name,
        role:       role       || user.role,
        department: department || user.department,
      }
      if (password && password.length >= 6) {
        updateData.password = await bcrypt.hash(password, 12)
      }
      auditDesc = `Updated user: ${user.name}`
    }

    const updated = await prisma.user.update({
      where: { id: targetId },
      data:  updateData,
      select: {
        id: true, name: true, email: true,
        role: true, department: true, isActive: true,
      },
    })

    await logAudit({
      userId:      req.user.id,
      action:      action === 'TOGGLE_STATUS' && !user.isActive
        ? 'USER_DEACTIVATED' : 'USER_UPDATED',
      module:      'User Management',
      description: auditDesc,
      ipAddress:   req.ip,
    })

    return success(res, updated, 'User updated successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/users/me/signing-pin-status — does the logged-in user have a
// signing PIN set yet? (Needed before they can sign anything.)
router.get('/me/signing-pin-status', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { signingPinHash: true, signingPinSetAt: true },
    })
    return success(res, {
      hasPinSet: Boolean(user?.signingPinHash),
      setAt: user?.signingPinSetAt || null,
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/users/me/signing-pin — set or change your own signing PIN.
// Requires the account login password to confirm identity (this is the
// "high-stakes action" case the DigitalSignature.verifiedWithPassword field
// anticipates) since the PIN itself is what will later authorize signatures.
router.post('/me/signing-pin', authenticate, async (req, res) => {
  try {
    const { newPin, password } = req.body
    if (!/^\d{4,6}$/.test(String(newPin || ''))) {
      return error(res, 'PIN must be 4 to 6 digits')
    }
    if (!password) {
      return error(res, 'Your account password is required to set a signing PIN')
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    const passwordMatch = await bcrypt.compare(String(password), user.password)
    if (!passwordMatch) return error(res, 'Incorrect password', 401)

    const signingPinHash = await bcrypt.hash(String(newPin), 12)
    await prisma.user.update({
      where: { id: req.user.id },
      data: { signingPinHash, signingPinSetAt: new Date() },
    })

    await logAudit({
      userId:      req.user.id,
      action:      user.signingPinHash ? 'SIGNING_PIN_CHANGED' : 'SIGNING_PIN_SET',
      module:      'Account Security',
      description: `${req.user.name} ${user.signingPinHash ? 'changed' : 'set'} their signing PIN`,
      ipAddress:   req.ip,
    })

    return success(res, { hasPinSet: true }, 'Signing PIN saved')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
