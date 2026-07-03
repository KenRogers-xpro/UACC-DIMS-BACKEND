export const success = (res, data, message = 'Success', status = 200) =>
  res.status(status).json({ success: true, message, data })

export const error = (res, message, status = 400, errors = null) =>
  res.status(status).json({ success: false, message, errors })

export const unauthorized = (res, message = 'Unauthorized') =>
  res.status(401).json({ success: false, message })

export const notFound = (res, message = 'Not found') =>
  res.status(404).json({ success: false, message })

export const serverError = (res, err) => {
  console.error('Server error:', err)
  return res.status(500).json({ success: false, message: 'Internal server error' })
}