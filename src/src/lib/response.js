/**
 * Standardized JSON response helpers for the UACC DIMS API.
 * Every response has `{ success: boolean, ... }`.
 */

function success(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    ...data,
  });
}

function error(res, message = 'An error occurred', statusCode = 400) {
  return res.status(statusCode).json({
    success: false,
    error: message,
  });
}

function paginated(res, { data, total, page, limit }) {
  return res.status(200).json({
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
}

function serverError(res, err) {
  console.error('Server Error:', err);
  return res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error',
  });
}

module.exports = { success, error, paginated, serverError };
