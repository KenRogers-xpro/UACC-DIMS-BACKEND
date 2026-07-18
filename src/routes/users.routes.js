import { Router } from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { sendWelcomeEmail, sendPasswordResetEmail } from '../lib/email.js'
import { isPinRequired } from '../lib/signatures.js'

const router = Router()

const ONLINE_WINDOW_MS = 5 * 60 * 1000

// isOnline requires BOTH conditions, not just lastSeenAt recency:
//  - isLoggedIn: explicit session state, set true on login / false on
//    logout — without this, logging out couldn't turn isOnline off any
//    faster than lastSeenAt happened to go stale (up to ONLINE_WINDOW_MS
//    later), since JWT auth has no server-side session to actually end.
//  - lastSeenAt within the window: catches the opposite gap — a user who
//    closes the tab/loses connectivity without ever calling /logout stays
//    isLoggedIn: true indefinitely, so recency is still what correctly
//    flips them to offline.
// isLoggedIn alone is NOT "currently online" — it only means "hasn't
// explicitly logged out," which is a different, weaker claim.
function computeIsOnline(user) {
  return user.isLoggedIn && Boolean(user.lastSeenAt) && (Date.now() - new Date(user.lastSeenAt).getTime()) < ONLINE_WINDOW_MS
}

function generateTempPassword() {
  // 12 random hex chars — not shown in any API response, only emailed
  // (via the stubbed sender, see lib/email.js) and logged server-side.
  return crypto.randomBytes(9).toString('hex')
}

// GET /api/users/online-status — who's currently active, company-wide.
// Low-sensitivity data (just "is this person online right now"), so open
// to any authenticated role rather than IT Admin/GM only.
router.get('/online-status', authenticate, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, role: true, isLoggedIn: true, lastSeenAt: true },
    })
    const withStatus = users.map((u) => ({
      ...u,
      isOnline: computeIsOnline(u),
    }))
    return success(res, {
      users: withStatus,
      onlineCount: withStatus.filter((u) => u.isOnline).length,
    })
  } catch (err) {
    return serverError(res, err)
  }
})

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
        isLoggedIn: true, lastSeenAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    const withStatus = users.map((u) => ({
      ...u,
      isOnline: computeIsOnline(u),
    }))

    return success(res, withStatus)
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/users — create user
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

    sendWelcomeEmail(user, password).catch((err) => console.error('sendWelcomeEmail failed:', err.message))

    return success(res, user, 'User created successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/users/:id — edit name/role/department. Not password — that's
// PUT /:id/reset-password below.
router.put('/:id', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id)
    const { name, role, department } = req.body

    const user = await prisma.user.findUnique({ where: { id: targetId } })
    if (!user) return notFound(res, 'User not found')

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: {
        name:       name       || user.name,
        role:       role       || user.role,
        department: department || user.department,
      },
      select: {
        id: true, name: true, email: true,
        role: true, department: true, isActive: true,
      },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'USER_UPDATED',
      module:      'User Management',
      description: `Updated user: ${user.name}`,
      ipAddress:   req.ip,
    })

    return success(res, updated, 'User updated successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/users/:id/deactivate — isActive: false only. Never deletes —
// historical circulation steps, signatures, and audit logs stay intact and
// keep referencing this user.
router.put('/:id/deactivate', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id)
    if (targetId === req.user.id) {
      return error(res, 'You cannot deactivate your own account')
    }

    const user = await prisma.user.findUnique({ where: { id: targetId } })
    if (!user) return notFound(res, 'User not found')

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { isActive: false },
      select: { id: true, name: true, email: true, role: true, department: true, isActive: true },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'USER_DEACTIVATED',
      module:      'User Management',
      description: `Deactivated user: ${user.name}`,
      ipAddress:   req.ip,
    })

    return success(res, updated, 'User deactivated')
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/users/:id/reactivate
router.put('/:id/reactivate', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id)
    const user = await prisma.user.findUnique({ where: { id: targetId } })
    if (!user) return notFound(res, 'User not found')

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { isActive: true },
      select: { id: true, name: true, email: true, role: true, department: true, isActive: true },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'USER_UPDATED',
      module:      'User Management',
      description: `Reactivated user: ${user.name}`,
      ipAddress:   req.ip,
    })

    return success(res, updated, 'User reactivated')
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/users/:id/reset-password — IT Admin triggers a reset. The new
// temp password is never returned in this response; it's only sent via
// sendPasswordResetEmail (see lib/email.js for what that actually does
// right now — no real provider wired up yet).
router.put('/:id/reset-password', authenticate, authorize('IT_ADMINISTRATOR'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id)
    const user = await prisma.user.findUnique({ where: { id: targetId } })
    if (!user) return notFound(res, 'User not found')

    const tempPassword = generateTempPassword()
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    await prisma.user.update({
      where: { id: targetId },
      data: { password: hashedPassword },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'USER_UPDATED',
      module:      'User Management',
      description: `Reset password for user: ${user.name}`,
      ipAddress:   req.ip,
    })

    sendPasswordResetEmail(user, tempPassword).catch((err) => console.error('sendPasswordResetEmail failed:', err.message))

    return success(res, null, 'Password reset — new credentials sent to the user')
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
      pinRequired: isPinRequired(),
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
