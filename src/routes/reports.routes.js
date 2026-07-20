import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { success, error, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { generateReportPDF } from '../lib/pdf.js'

const router = Router()

// Same role gate as the Reports nav item itself (Sidebar.jsx) — these
// endpoints expose department/organization-wide aggregates, not just the
// caller's own data, so they shouldn't be reachable by every authenticated
// role even though nothing in the UI links to them for anyone else.
const REPORT_ROLES = ['GENERAL_MANAGER', 'DEPARTMENT_HEAD', 'IT_ADMINISTRATOR', 'INTERNAL_AUDITOR']

const DEPARTMENT_COLORS = {
  GENERAL_MANAGER_OFFICE:     '#C9973A',
  FINANCE_AND_ADMINISTRATION: '#4ade80',
  ENGINEERING:                '#a5b4fc',
  PILOTS:                     '#f472b6',
  OPERATIONS:                 '#fbbf24',
  HUMAN_RESOURCES:            '#38bdf8',
  FINANCE_AND_ACCOUNTS:       '#fb923c',
  MARKETING:                  '#c084fc',
}

function formatDept(dept) {
  return String(dept).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

// dateTo is a date-only string ("2026-07-20"); parsed with an explicit Z
// suffix so it always means end-of-day UTC regardless of the server's local
// timezone — matches how dateFrom/logDate are already parsed elsewhere
// (new Date('YYYY-MM-DD') is UTC midnight per the ISO 8601 date-only spec).
function parseDateRange(dateFrom, dateTo) {
  const from = dateFrom ? new Date(dateFrom) : new Date('1970-01-01T00:00:00.000Z')
  const to = dateTo ? new Date(`${dateTo}T23:59:59.999Z`) : new Date()
  return { from, to }
}

function deptFilter(department) {
  return department && department !== 'ALL' ? { department } : {}
}

// Inclusive list of calendar months overlapping [from, to]. Capped at 60
// months (5 years) as a sanity bound against pathological/open-ended input —
// real report windows here are months to a couple of years, never decades.
function monthsInRange(from, to) {
  const months = []
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))
  let guard = 0
  while (cursor <= end && guard < 60) {
    const start = cursor
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    months.push({
      start,
      end: next,
      label: start.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    })
    cursor = next
    guard++
  }
  return months
}

// Number of Mon–Fri calendar days in [from, to], inclusive.
function countWeekdays(from, to) {
  let count = 0
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()))
  while (cursor <= end) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) count++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

// ─── SHARED AGGREGATIONS (used by both the JSON endpoints and /export) ──────

async function getProcurementSummary({ from, to, dept }) {
  const months = monthsInRange(from, to)
  return Promise.all(months.map(async ({ start, end, label }) => {
    const [submitted, approved, rejected, costAgg] = await Promise.all([
      prisma.procurementRequest.count({ where: { ...dept, createdAt: { gte: start, lt: end } } }),
      prisma.procurementRequest.count({ where: { ...dept, status: 'APPROVED', updatedAt: { gte: start, lt: end } } }),
      prisma.procurementRequest.count({ where: { ...dept, status: 'REJECTED', updatedAt: { gte: start, lt: end } } }),
      prisma.procurementRequest.aggregate({
        where: { ...dept, createdAt: { gte: start, lt: end } },
        _sum: { estimatedCost: true },
      }),
    ])
    return { month: label, submitted, approved, rejected, totalCost: Number(costAgg._sum.estimatedCost || 0) }
  }))
}

async function getDocumentsByDepartment({ from, to }) {
  const groups = await prisma.document.groupBy({
    by: ['department'],
    where: { createdAt: { gte: from, lte: to } },
    _count: { id: true },
  })

  return groups.map((g) => ({
    name: formatDept(g.department),
    value: g._count.id,
    color: DEPARTMENT_COLORS[g.department] || '#94a3b8',
  }))
}

// "Compliance %" is not a metric defined anywhere in the schema — this is a
// judgment call, not a derived fact. Definition used here (pending Ken's
// confirmation before this goes in front of the GM or EDRM material):
//   distinct user-days with >=1 activity log ÷ (active dept staff × weekdays in range) × 100
// i.e. the share of possible working-days actually covered by a log, per
// department. A different definition (e.g. one log per staff member per
// week, or vs. a target hours figure) would produce different numbers.
async function getDepartmentPerformance({ from, to, dept }) {
  const [grouped, activeStaff, logRows] = await Promise.all([
    prisma.activityLog.groupBy({
      by: ['department'],
      where: { ...dept, logDate: { gte: from, lte: to } },
      _count: { id: true },
      _avg: { hoursSpent: true },
    }),
    prisma.user.groupBy({
      by: ['department'],
      where: { ...dept, isActive: true },
      _count: { id: true },
    }),
    prisma.activityLog.findMany({
      where: { ...dept, logDate: { gte: from, lte: to } },
      select: { department: true, userId: true, logDate: true },
    }),
  ])

  const staffByDept = Object.fromEntries(activeStaff.map((s) => [s.department, s._count.id]))
  const weekdayCount = countWeekdays(from, to)

  // logDate is always normalized to midnight UTC for a given calendar day
  // (see activityLogs.routes.js POST / — one log per user per exact logDate
  // value), so deduping on the raw (department, userId, logDate) triple
  // already gives distinct user-days without needing separate date-bucketing.
  const userDaysByDept = {}
  const seen = new Set()
  for (const row of logRows) {
    const key = `${row.department}|${row.userId}|${row.logDate.toISOString()}`
    if (seen.has(key)) continue
    seen.add(key)
    userDaysByDept[row.department] = (userDaysByDept[row.department] || 0) + 1
  }

  return grouped.map((g) => {
    const activeStaffCount = staffByDept[g.department] || 0
    const userDays = userDaysByDept[g.department] || 0
    const denominator = activeStaffCount * weekdayCount
    const compliance = denominator > 0 ? Math.min(100, (userDays / denominator) * 100) : 0

    return {
      department: g.department,
      logsSubmitted: g._count.id,
      avgHours: g._avg.hoursSpent || 0,
      compliance: Math.round(compliance * 10) / 10,
    }
  })
}

// AuditLog has no direct department column — filtered via the related user
// instead. No pagination: this is a report export, not the paginated Audit
// Trail page (auditTrail.routes.js), so the full matching set is returned.
async function getAuditSummary({ from, to, department }) {
  return prisma.auditLog.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      ...(department && department !== 'ALL' ? { user: { department } } : {}),
    },
    include: { user: { select: { id: true, name: true, role: true, department: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

// ─── JSON ENDPOINTS ──────────────────────────────────────────────────────────

router.get('/procurement-summary', authenticate, authorize(REPORT_ROLES), async (req, res) => {
  try {
    const { dateFrom = '', dateTo = '', department = 'ALL' } = req.query
    const { from, to } = parseDateRange(dateFrom, dateTo)
    const data = await getProcurementSummary({ from, to, dept: deptFilter(department) })
    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

router.get('/documents-by-department', authenticate, authorize(REPORT_ROLES), async (req, res) => {
  try {
    const { dateFrom = '', dateTo = '' } = req.query
    const { from, to } = parseDateRange(dateFrom, dateTo)
    const data = await getDocumentsByDepartment({ from, to })
    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

router.get('/department-performance', authenticate, authorize(REPORT_ROLES), async (req, res) => {
  try {
    const { dateFrom = '', dateTo = '', department = 'ALL' } = req.query
    const { from, to } = parseDateRange(dateFrom, dateTo)
    const data = await getDepartmentPerformance({ from, to, dept: deptFilter(department) })
    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

router.get('/audit-summary', authenticate, authorize(REPORT_ROLES), async (req, res) => {
  try {
    const { dateFrom = '', dateTo = '', department = 'ALL' } = req.query
    const { from, to } = parseDateRange(dateFrom, dateTo)
    const data = await getAuditSummary({ from, to, department })
    return success(res, data)
  } catch (err) {
    return serverError(res, err)
  }
})

// ─── PDF EXPORT ──────────────────────────────────────────────────────────────
// ACTIVITY_LOG_REPORT is deliberately not handled here — it has no backend
// aggregation yet and still runs on sample data on the frontend; exporting a
// PDF from it would produce a document that looks authoritative but isn't.

router.get('/export', authenticate, authorize(REPORT_ROLES), async (req, res) => {
  try {
    const { reportType = '', dateFrom = '', dateTo = '', department = 'ALL', format = 'pdf' } = req.query

    if (format !== 'pdf') {
      return error(res, 'Only PDF export is supported')
    }

    const { from, to } = parseDateRange(dateFrom, dateTo)
    const dept = deptFilter(department)
    const rangeLabel = `${dateFrom || 'All time'} – ${dateTo || 'Present'}`
    const deptLabel = department && department !== 'ALL' ? formatDept(department) : 'All Departments'

    let title, columns, rows

    switch (reportType) {
      case 'PROCUREMENT_SUMMARY': {
        title = 'Procurement Summary Report'
        columns = [
          { key: 'month', label: 'Month' },
          { key: 'submitted', label: 'Submitted', align: 'center' },
          { key: 'approved', label: 'Approved', align: 'center' },
          { key: 'rejected', label: 'Rejected', align: 'center' },
          { key: 'totalCost', label: 'Est. Cost (UGX)', align: 'right' },
        ]
        const data = await getProcurementSummary({ from, to, dept })
        rows = data.map((r) => ({ ...r, totalCost: r.totalCost.toLocaleString('en-US') }))
        break
      }
      case 'DOCUMENT_INVENTORY': {
        title = 'Document Inventory Report'
        columns = [
          { key: 'name', label: 'Department' },
          { key: 'value', label: 'Total Documents', align: 'center' },
        ]
        rows = await getDocumentsByDepartment({ from, to })
        break
      }
      case 'DEPT_PERFORMANCE': {
        title = 'Department Performance Report'
        columns = [
          { key: 'department', label: 'Department' },
          { key: 'logsSubmitted', label: 'Logs Submitted', align: 'center' },
          { key: 'avgHours', label: 'Avg Hours/Log', align: 'center' },
          { key: 'compliance', label: 'Compliance %', align: 'center' },
        ]
        const data = await getDepartmentPerformance({ from, to, dept })
        rows = data.map((r) => ({
          ...r,
          department: formatDept(r.department),
          avgHours: `${r.avgHours.toFixed(1)} hrs`,
          compliance: `${r.compliance}%`,
        }))
        break
      }
      case 'AUDIT_SUMMARY': {
        title = 'Audit Trail Summary'
        columns = [
          { key: 'createdAt', label: 'Timestamp' },
          { key: 'user', label: 'User' },
          { key: 'action', label: 'Action' },
          { key: 'ipAddress', label: 'IP Address', align: 'right' },
        ]
        const data = await getAuditSummary({ from, to, department })
        rows = data.map((log) => ({
          createdAt: new Date(log.createdAt).toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' }),
          user: log.user.name,
          action: log.description,
          ipAddress: log.ipAddress || '—',
        }))
        break
      }
      default:
        return error(res, 'Unknown or unsupported report type for export')
    }

    const pdfBuffer = await generateReportPDF({
      title,
      subtitle: `${rangeLabel}  ·  ${deptLabel}`,
      columns,
      rows,
      generatedAt: new Date(),
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="UACC_${reportType}_${Date.now()}.pdf"`)
    return res.send(pdfBuffer)
  } catch (err) {
    return serverError(res, err)
  }
})

export default router
