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
import circulationRoutes from './routes/circulation.routes.js'
import messageRoutes from './routes/messages.routes.js'
import announcementRoutes from './routes/announcements.routes.js'
import notificationRoutes from './routes/notifications.routes.js'
import insightRoutes from './routes/insights.routes.js'

const app = express()
const PORT = process.env.PORT || 5000

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

// Rate limiting
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100,
	message: { success: false, message: 'Too many requests. Please try again later.' },
	skip: (req) => {
		const path = req.originalUrl || req.url;
		return path.startsWith('/api/messages') ||
		       path.startsWith('/api/announcements') ||
		       path.startsWith('/api/notifications') ||
		       path.startsWith('/api/insights') ||
		       path.startsWith('/api/users/online-status') ||
		       path.startsWith('/api/ai'); // AI has its own limiter
	}
})
app.use('/api/', limiter)

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
