const { verifyToken } = require('./jwt');
const { error, unauthorized } = require('./response');

/**
 * Middleware to protect routes.
 * Checks for a valid JWT in the Authorization header.
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Authentication required', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    // Attach user info to the request object
    req.user = decoded;
    next();
  } catch (err) {
    return error(res, 'Invalid or expired token', 401);
  }
};

/**
 * Middleware for role-based access control (RBAC).
 * Use AFTER authenticate middleware.
 * @param {...string} roles - Allowed roles (e.g., 'GENERAL_MANAGER', 'IT_ADMINISTRATOR')
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return error(res, 'Forbidden: You do not have the required permissions', 403);
    }
    next();
  };
};

module.exports = { authenticate, authorize };
