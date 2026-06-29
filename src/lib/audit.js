import { prisma } from './prisma.js'

export async function logAudit({ userId, action, module, description, ipAddress = null }) {
  try {
    await prisma.auditLog.create({
      data: { userId, action, module, description, ipAddress },
    })
  } catch (error) {
    console.error('Audit log failed:', error)
  }
}
