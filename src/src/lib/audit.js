const prisma = require('./prisma');

/**
 * Log an action to the audit_logs table.
 * Call this after every significant operation (login, upload, approve, etc.).
 */
async function logAudit({ userId, action, module, description, ipAddress }) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        module,
        description,
        ipAddress: ipAddress || null,
      },
    });
  } catch (err) {
    // Audit logging should never crash the main operation
    console.error('Audit log failed:', err.message);
  }
}

/**
 * Extract the client IP address from an Express request.
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

module.exports = { logAudit, getClientIp };
