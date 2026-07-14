import { verifyToken } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'

export async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' })
    }

    const token   = authHeader.substring(7)
    const decoded = verifyToken(token)

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true, name: true, email: true,
        role: true, department: true, isActive: true,
      },
    })

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account not found or deactivated',
      })
    }

    req.user = user

    // Fire-and-forget "last seen" tracking — piggybacks on requests that are
    // already happening, no extra round trip. Never blocks the response,
    // and a failure here shouldn't fail the request it's riding on.
    prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    }).catch((err) => console.error('Failed to update lastSeenAt:', err.message))

    next()
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    })
  }
}

export function authorize(...roles) {
  return (req, res, next) => {
    const allowedRoles = roles.length === 1 && Array.isArray(roles[0]) ? roles[0] : roles

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`,
      })
    }
    next()
  }
}
