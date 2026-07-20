import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import compression from 'compression'
import rateLimit from 'express-rate-limit'

import './lib/env.js'

import authRoutes from './routes/auth.routes.js'
import documentRoutes from './routes/documents.routes.js'
import procurementRoutes from './routes/procurement.routes.js'
import recordsRoutes from './routes/records.routes.js'
import draftRoutes from './routes/drafts.routes.js'
import scheduleRoutes from './routes/schedule.routes.js'
import activityLogRoutes from './routes/activityLogs.routes.js'
import userRoutes from './routes/users.routes.js'
import auditTrailRoutes from './routes/auditTrail.routes.js'
import paRoutes from './routes/pa.routes.js'
import aiRoutes from './routes/ai.routes.js'
import dashboardRoutes from './routes/dashboard.routes.js'
import reportsRoutes from './routes/reports.routes.js'
import circulationRoutes from './routes/circulation.routes.js'
import messageRoutes from './routes/messages.routes.js'
import announcementRoutes from './routes/announcements.routes.js'
import notificationRoutes from './routes/notifications.routes.js'
import insightRoutes from './routes/insights.routes.js'

const app = express()
const PORT = process.env.PORT || 5000

// Render (and most PaaS hosts) sit the app behind a reverse proxy — without
// this, req.ip resolves to the proxy's own address for every request, which
// means express-rate-limit's default IP-based key buckets every distinct
// user together under one counter. Must be set before any rate limiter is
// constructed.
app.set('trust proxy', 1)

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.use(helmet())
app.use(compression())
app.use(morgan('dev'))

app.use(cors({
	origin: [process.env.FRONTEND_URL, /\.vercel\.app$/],
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// Rate limiting — split rather than one shared bucket, because brute-force
// protection (auth) and normal dashboard polling load (everything else) have
// completely different legitimate request volumes. A single limiter sized
// for one starves the other: sized for polling, login brute-forcing goes
// unchecked; sized for login, four concurrent 5-30s pollers plus normal
// navigation lock real users out within minutes.
const generalLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 500,
	message: { success: false, message: 'Too many requests. Please try again later.' },
	skip: (req) => {
		const path = req.originalUrl || req.url;
		return path.startsWith('/api/auth') || // has its own, stricter limiter
		       path.startsWith('/api/messages') ||
		       path.startsWith('/api/announcements') ||
		       path.startsWith('/api/notifications') ||
		       path.startsWith('/api/insights') ||
		       path.startsWith('/api/users/online-status') ||
		       path.startsWith('/api/ai'); // AI has its own limiter
	}
})
app.use('/api/', generalLimiter)

// Auth — this is where brute-force protection actually belongs, scoped
// tightly to the login endpoint itself (see auth.routes.js) rather than the
// whole /api/auth prefix, which also handles /logout and /me.
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 10,
	message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
})

// AI rate limit — stricter
const aiLimiter = rateLimit({
	windowMs: 60 * 1000, // 1 minute
	max: 10,
	message: { success: false, message: 'AI rate limit reached. Please wait a moment.' },
})

// Messages/announcements poll every 5-30s from the frontend, which would
// blow through the global 100-per-15-min limit on its own — give them their
// own more generous window instead of fighting it.
const pollingLimiter = rateLimit({
	windowMs: 60 * 1000,
	max: 60,
	message: { success: false, message: 'Too many requests. Please wait a moment.' },
})

// ── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
	res.json({
		status: 'OK',
		system: 'UACC DIMS API',
		version: '1.0.0',
		timestamp: new Date().toISOString(),
	})
})

// Scoped to /login specifically (not the whole /api/auth prefix, which also
// covers /logout and /me — neither is a brute-force target) — registered
// ahead of the router mount below since Express applies middleware in
// registration order, and authRoutes would otherwise handle + end the
// request before this ever ran.
app.use('/api/auth/login', authLimiter)
app.use('/api/auth', authRoutes)
app.use('/api/documents', documentRoutes)
app.use('/api/procurement', procurementRoutes)
app.use('/api/records', recordsRoutes)
app.use('/api/drafts', draftRoutes)
app.use('/api/schedule', scheduleRoutes)
app.use('/api/activity-logs', activityLogRoutes)
app.use('/api/users', userRoutes)
app.use('/api/audit-trail', auditTrailRoutes)
app.use('/api/pa', paRoutes)
app.use('/api/ai', aiLimiter, aiRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/reports', reportsRoutes)
app.use('/api/circulation', circulationRoutes)
app.use('/api/messages', pollingLimiter, messageRoutes)
app.use('/api/announcements', pollingLimiter, announcementRoutes)
app.use('/api/notifications', pollingLimiter, notificationRoutes)
app.use('/api/insights', pollingLimiter, insightRoutes)

// 404 handler removed (avoids path-to-regexp '*' parsing issue in this environment)

// Global error handler
app.use((err, req, res, next) => {
	console.error('Unhandled error:', err)
	res.status(500).json({
		success: false,
		message: 'Internal server error',
	})
})

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, (err) => {
	if (err) {
		console.error('\n❌ Failed to start server:', err)
		process.exit(1)
	}
	console.log(`\n🚀 UACC DIMS API running on port ${PORT}`)
	console.log(`📡 Environment: ${process.env.NODE_ENV}`)
	console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`)
	console.log(`🤖 AI Provider: Gemini 2.0 Flash\n`)
})

export default app
