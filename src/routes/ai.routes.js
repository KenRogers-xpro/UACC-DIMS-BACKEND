import { Router } from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { prisma } from '../lib/prisma.js'
import { success, error, serverError, unauthorized } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  GENERAL_MANAGER: (user, date) => `
You are the DIMS Executive Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the General Manager of UACC.
Today is ${date}. UACC is a government-owned aviation corporation at Entebbe International Airport.
Give executive-level, data-driven, action-oriented responses.
Always highlight items requiring GM decision. Flag anomalies proactively.
Use UGX for currency. Never make up data — always use your tools first.`,

  DEPARTMENT_HEAD: (user, date) => `
You are the DIMS Department Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, Department Head of ${user.department?.replace(/_/g, ' ')}.
Today is ${date}.
Focus on department-specific data, pending approvals, team activity and documents.
Never make up data — always use your tools first.`,

  STAFF: (user, date) => `
You are the DIMS Personal Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, a staff member in ${user.department?.replace(/_/g, ' ')}.
Today is ${date}.
Help with daily tasks: checking request status, finding documents, activity log reminders.
Be friendly and use simple language. Never make up data — always use your tools first.`,

  IT_ADMINISTRATOR: (user, date) => `
You are the DIMS System Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the IT Administrator.
Today is ${date}.
Help with user management, system health, audit monitoring and security.
Be technical and precise. Never make up data — always use your tools first.`,

  AUDITOR: (user, date) => `
You are the DIMS Audit Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the Internal Auditor.
Today is ${date}.
Help with audit trail analysis, compliance reports, anomaly detection and procurement auditing.
Be formal and evidence-based. Never make up data — always use your tools first.`,

  RECORDS_EXECUTIVE: (user, date) => `
You are the DIMS Records Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the Records Executive.
Today is ${date}.
Help with registry management, document tracking and correspondence monitoring.
Reference documents by REG-UACC-YYYY-XXXX. Never make up data — always use your tools first.`,
}

// ── GEMINI TOOLS BY ROLE ──────────────────────────────────────────────────────

const TOOLS_BY_ROLE = {
  GENERAL_MANAGER: {
    functionDeclarations: [
      { name: 'get_system_overview',     description: 'Complete DIMS system metrics',    parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_pending_decisions',   description: 'Items awaiting GM decision',      parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_procurement_summary', description: 'Procurement stats and requests',  parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' }, department: { type: 'STRING' }, limit: { type: 'NUMBER' } } } },
      { name: 'get_document_summary',    description: 'Document repository stats',       parameters: { type: 'OBJECT', properties: { category: { type: 'STRING' }, department: { type: 'STRING' } } } },
      { name: 'get_activity_log_summary',description: 'Staff activity log stats',        parameters: { type: 'OBJECT', properties: { department: { type: 'STRING' }, dateFrom: { type: 'STRING' }, dateTo: { type: 'STRING' } } } },
      { name: 'get_department_performance', description: 'Performance metrics by dept', parameters: { type: 'OBJECT', properties: { department: { type: 'STRING' } } } },
      { name: 'get_audit_summary',       description: 'Audit trail summary',            parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' }, action: { type: 'STRING' } } } },
    ],
  },
  DEPARTMENT_HEAD: {
    functionDeclarations: [
      { name: 'get_dept_overview',      description: 'Department overview',              parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_pending_approvals',  description: 'Requests awaiting dept approval',  parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_dept_procurement',   description: 'Department procurement requests',  parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' }, limit: { type: 'NUMBER' } } } },
      { name: 'get_dept_activity_logs', description: 'Department activity logs',         parameters: { type: 'OBJECT', properties: { dateFrom: { type: 'STRING' }, dateTo: { type: 'STRING' } } } },
      { name: 'get_dept_documents',     description: 'Department documents',             parameters: { type: 'OBJECT', properties: { category: { type: 'STRING' } } } },
    ],
  },
  STAFF: {
    functionDeclarations: [
      { name: 'get_my_overview',                description: 'Personal DIMS overview',          parameters: { type: 'OBJECT', properties: {} } },
      { name: 'check_todays_log',               description: 'Check if log submitted today',    parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_my_procurement_requests',    description: 'My procurement requests',         parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' } } } },
      { name: 'get_my_activity_logs',           description: 'My activity log history',         parameters: { type: 'OBJECT', properties: { limit: { type: 'NUMBER' } } } },
      { name: 'search_documents',               description: 'Search document repository',      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, category: { type: 'STRING' } } } },
    ],
  },
  IT_ADMINISTRATOR: {
    functionDeclarations: [
      { name: 'get_system_overview',  description: 'Complete system overview',    parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_system_health',    description: 'System health and DB stats',  parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_user_list',        description: 'All DIMS users',              parameters: { type: 'OBJECT', properties: { role: { type: 'STRING' }, isActive: { type: 'BOOLEAN' } } } },
      { name: 'get_security_report',  description: 'Security events report',      parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
      { name: 'get_audit_summary',    description: 'Audit trail summary',         parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
    ],
  },
  AUDITOR: {
    functionDeclarations: [
      { name: 'get_audit_summary',        description: 'Audit trail summary',          parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' }, action: { type: 'STRING' } } } },
      { name: 'get_audit_anomalies',      description: 'Detect audit anomalies',       parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
      { name: 'get_procurement_audit',    description: 'Procurement audit analysis',   parameters: { type: 'OBJECT', properties: { department: { type: 'STRING' } } } },
      { name: 'get_compliance_report',    description: 'Activity log compliance',      parameters: { type: 'OBJECT', properties: { dateFrom: { type: 'STRING' }, dateTo: { type: 'STRING' } } } },
      { name: 'get_document_access_log',  description: 'Document access audit',        parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
    ],
  },
  RECORDS_EXECUTIVE: {
    functionDeclarations: [
      { name: 'get_registry_summary',   description: 'Registry statistics',          parameters: { type: 'OBJECT', properties: { direction: { type: 'STRING' }, status: { type: 'STRING' } } } },
      { name: 'get_pending_registry',   description: 'Pending registry entries',     parameters: { type: 'OBJECT', properties: {} } },
      { name: 'search_registry',        description: 'Search the registry',          parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, direction: { type: 'STRING' } } } },
      { name: 'get_registry_analytics', description: 'Registry analytics overview',  parameters: { type: 'OBJECT', properties: {} } },
    ],
  },
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────

async function executeTool(toolName, args, user) {
  const userId   = user.id
  const userRole = user.role
  const userDept = user.department

  try {
    switch (toolName) {
      case 'get_system_overview': {
        const today = new Date(); today.setHours(0,0,0,0)
        const [totalDocs, totalProc, pendingProc, totalLogs, logsToday, totalUsers, activeUsers, totalRegistry] =
          await Promise.all([
            prisma.document.count(),
            prisma.procurementRequest.count(),
            prisma.procurementRequest.count({ where: { status: { in: ['PENDING','DEPT_HEAD_APPROVED'] } } }),
            prisma.activityLog.count(),
            prisma.activityLog.count({ where: { createdAt: { gte: today } } }),
            prisma.user.count(),
            prisma.user.count({ where: { isActive: true } }),
            prisma.registryEntry.count(),
          ])
        return { documents: { total: totalDocs }, procurement: { total: totalProc, pending: pendingProc }, activityLogs: { total: totalLogs, today: logsToday }, users: { total: totalUsers, active: activeUsers }, registry: { total: totalRegistry }, asOf: new Date().toISOString() }
      }

      case 'get_pending_decisions': {
        const [pendingProc, pendingReg] = await Promise.all([
          prisma.procurementRequest.findMany({ where: { status: { in: ['PENDING','DEPT_HEAD_APPROVED'] } }, include: { requestedBy: { select: { name: true, department: true } } }, orderBy: { createdAt: 'asc' } }),
          prisma.registryEntry.findMany({ where: { status: { in: ['PENDING','DISPATCHED'] } }, orderBy: { dateRegistered: 'asc' } }),
        ])
        return {
          awaitingGM:        pendingProc.filter(r => r.status === 'DEPT_HEAD_APPROVED').map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, by: r.requestedBy.name })),
          awaitingDeptHead:  pendingProc.filter(r => r.status === 'PENDING').map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, by: r.requestedBy.name })),
          registryPending:   pendingReg.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, priority: e.priority })),
        }
      }

      case 'get_procurement_summary': {
        const where = {}
        if (args.status && args.status !== 'ALL') where.status = args.status
        if (args.department) where.department = { contains: args.department, mode: 'insensitive' }
        const [requests, total, byStatus, totalCost] = await Promise.all([
          prisma.procurementRequest.findMany({ where, take: args.limit || 5, orderBy: { createdAt: 'desc' }, include: { requestedBy: { select: { name: true } } } }),
          prisma.procurementRequest.count({ where }),
          prisma.procurementRequest.groupBy({ by: ['status'], _count: { status: true } }),
          prisma.procurementRequest.aggregate({ where, _sum: { estimatedCost: true } }),
        ])
        return { total, totalCost: totalCost._sum.estimatedCost, byStatus, recent: requests.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, status: r.status, by: r.requestedBy.name })) }
      }

      case 'get_document_summary': {
        const where = {}
        if (args.category)   where.category   = args.category
        if (args.department) where.department = args.department
        const [docs, total, byCategory] = await Promise.all([
          prisma.document.findMany({ where, take: 5, orderBy: { createdAt: 'desc' }, include: { uploader: { select: { name: true } } } }),
          prisma.document.count({ where }),
          prisma.document.groupBy({ by: ['category'], _count: { category: true } }),
        ])
        return { total, byCategory, recent: docs.map(d => ({ title: d.title, category: d.category, dept: d.department, by: d.uploader.name })) }
      }

      case 'get_activity_log_summary': {
        const where = {}
        if (args.department) where.department = args.department
        if (args.dateFrom)   where.logDate    = { gte: new Date(args.dateFrom) }
        if (args.dateTo)     where.logDate    = { ...where.logDate, lte: new Date(args.dateTo) }
        const [logs, total, agg] = await Promise.all([
          prisma.activityLog.findMany({ where, take: 5, orderBy: { logDate: 'desc' }, include: { user: { select: { name: true } } } }),
          prisma.activityLog.count({ where }),
          prisma.activityLog.aggregate({ where, _sum: { hoursSpent: true }, _avg: { hoursSpent: true } }),
        ])
        return { total, totalHours: agg._sum.hoursSpent, avgHours: agg._avg.hoursSpent, recent: logs.map(l => ({ staff: l.user.name, dept: l.department, date: l.logDate, hours: l.hoursSpent })) }
      }

      case 'get_department_performance': {
        const depts = ['GENERAL_MANAGER_OFFICE','FINANCE_AND_ADMINISTRATION','ENGINEERING','PILOTS','OPERATIONS']
        const targets = args.department ? [args.department] : depts
        const perf = await Promise.all(targets.map(async dept => {
          const [proc, logs, docs, hrs] = await Promise.all([
            prisma.procurementRequest.count({ where: { department: dept } }),
            prisma.activityLog.count({ where: { department: dept } }),
            prisma.document.count({ where: { department: dept } }),
            prisma.activityLog.aggregate({ where: { department: dept }, _sum: { hoursSpent: true } }),
          ])
          return { department: dept.replace(/_/g,' '), procurement: proc, activityLogs: logs, documents: docs, totalHours: hrs._sum.hoursSpent || 0 }
        }))
        return { departments: perf }
      }

      case 'get_audit_summary': {
        const days  = args.days || 7
        const since = new Date(); since.setDate(since.getDate() - days)
        const [logs, total, byAction] = await Promise.all([
          prisma.auditLog.findMany({ where: { createdAt: { gte: since }, ...(args.action ? { action: args.action } : {}) }, take: 10, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true, role: true } } } }),
          prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
          prisma.auditLog.groupBy({ by: ['action'], _count: { action: true }, where: { createdAt: { gte: since } }, orderBy: { _count: { action: 'desc' } } }),
        ])
        return { period: `Last ${days} days`, total, byAction, recent: logs.map(l => ({ user: l.user.name, action: l.action, desc: l.description, time: l.createdAt })) }
      }

      case 'get_dept_overview': {
        const [proc, pending, logs, docs, hrs] = await Promise.all([
          prisma.procurementRequest.count({ where: { department: userDept } }),
          prisma.procurementRequest.count({ where: { department: userDept, status: 'PENDING' } }),
          prisma.activityLog.count({ where: { department: userDept } }),
          prisma.document.count({ where: { department: userDept } }),
          prisma.activityLog.aggregate({ where: { department: userDept }, _sum: { hoursSpent: true } }),
        ])
        return { department: userDept, procurement: { total: proc, pending }, activityLogs: { total: logs }, documents: { total: docs }, totalHours: hrs._sum.hoursSpent }
      }

      case 'get_pending_approvals': {
        const reqs = await prisma.procurementRequest.findMany({ where: { department: userDept, status: 'PENDING' }, include: { requestedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' } })
        return { count: reqs.length, requests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, by: r.requestedBy.name, date: r.createdAt })) }
      }

      case 'get_dept_procurement': {
        const where = { department: userDept }
        if (args.status) where.status = args.status
        const reqs = await prisma.procurementRequest.findMany({ where, take: args.limit || 10, orderBy: { createdAt: 'desc' }, include: { requestedBy: { select: { name: true } } } })
        return { department: userDept, total: reqs.length, requests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, status: r.status, by: r.requestedBy.name })) }
      }

      case 'get_dept_activity_logs': {
        const where = { department: userDept }
        if (args.dateFrom) where.logDate = { gte: new Date(args.dateFrom) }
        if (args.dateTo)   where.logDate = { ...where.logDate, lte: new Date(args.dateTo) }
        const logs = await prisma.activityLog.findMany({ where, take: 10, orderBy: { logDate: 'desc' }, include: { user: { select: { name: true } } } })
        return { department: userDept, total: logs.length, logs: logs.map(l => ({ staff: l.user.name, date: l.logDate, hours: l.hoursSpent })) }
      }

      case 'get_dept_documents': {
        const where = { department: userDept }
        if (args.category) where.category = args.category
        const docs = await prisma.document.findMany({ where, take: 10, orderBy: { createdAt: 'desc' }, include: { uploader: { select: { name: true } } } })
        return { department: userDept, total: docs.length, documents: docs.map(d => ({ title: d.title, category: d.category, by: d.uploader.name })) }
      }

      case 'get_my_overview': {
        const today = new Date(); today.setHours(0,0,0,0)
        const [reqs, logs, todayLog] = await Promise.all([
          prisma.procurementRequest.findMany({ where: { requestedById: userId }, orderBy: { createdAt: 'desc' }, take: 3 }),
          prisma.activityLog.count({ where: { userId } }),
          prisma.activityLog.findFirst({ where: { userId, logDate: { gte: today } } }),
        ])
        return { todayLogSubmitted: !!todayLog, totalLogs: logs, recentRequests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, status: r.status })) }
      }

      case 'check_todays_log': {
        const today = new Date(); today.setHours(0,0,0,0)
        const log = await prisma.activityLog.findFirst({ where: { userId, logDate: { gte: today } } })
        return { submitted: !!log, message: log ? 'You have submitted your log for today.' : 'You have NOT submitted your activity log today. Please do so before 5PM.' }
      }

      case 'get_my_procurement_requests': {
        const where = { requestedById: userId }
        if (args.status) where.status = args.status
        const reqs = await prisma.procurementRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 })
        return { total: reqs.length, requests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, status: r.status, comment: r.gmComment || r.deptHeadComment })) }
      }

      case 'get_my_activity_logs': {
        const logs = await prisma.activityLog.findMany({ where: { userId }, take: args.limit || 10, orderBy: { logDate: 'desc' } })
        const hrs  = await prisma.activityLog.aggregate({ where: { userId }, _sum: { hoursSpent: true } })
        return { total: logs.length, totalHours: hrs._sum.hoursSpent, logs: logs.map(l => ({ date: l.logDate, hours: l.hoursSpent, desc: l.activityDescription.substring(0,80) })) }
      }

      case 'search_documents': {
        const docs = await prisma.document.findMany({
          where: { AND: [{ title: { contains: args.query, mode: 'insensitive' } }, args.category ? { category: args.category } : {}] },
          take:  5,
          include: { uploader: { select: { name: true } } },
        })
        return { query: args.query, results: docs.length, documents: docs.map(d => ({ title: d.title, category: d.category, dept: d.department, by: d.uploader.name })) }
      }

      case 'get_user_list': {
        const where = {}
        if (args.role)     where.role     = args.role
        if (args.isActive !== undefined) where.isActive = args.isActive
        const users = await prisma.user.findMany({ where, select: { id: true, name: true, email: true, role: true, department: true, isActive: true } })
        return { total: users.length, users }
      }

      case 'get_system_health': {
        const [docs, proc, logs, reg, users, audit] = await Promise.all([
          prisma.document.count(), prisma.procurementRequest.count(),
          prisma.activityLog.count(), prisma.registryEntry.count(),
          prisma.user.count(), prisma.auditLog.count(),
        ])
        return { databaseRecords: { documents: docs, procurement: proc, activityLogs: logs, registry: reg, users, auditLogs: audit }, status: 'HEALTHY' }
      }

      case 'get_security_report': {
        const days  = args.days || 7
        const since = new Date(); since.setDate(since.getDate() - days)
        const [deletes, logins, changes] = await Promise.all([
          prisma.auditLog.findMany({ where: { action: 'DOCUMENT_DELETE', createdAt: { gte: since } }, include: { user: { select: { name: true, role: true } } } }),
          prisma.auditLog.count({ where: { action: 'LOGIN', createdAt: { gte: since } } }),
          prisma.auditLog.findMany({ where: { action: { in: ['USER_CREATED','USER_UPDATED','USER_DEACTIVATED'] }, createdAt: { gte: since } }, include: { user: { select: { name: true } } } }),
        ])
        return { period: `Last ${days} days`, logins, deletions: deletes.length, deleteEvents: deletes.map(d => ({ by: d.user.name, desc: d.description, time: d.createdAt })), userChanges: changes.map(c => ({ action: c.action, by: c.user.name, time: c.createdAt })) }
      }

      case 'get_audit_anomalies': {
        const days  = args.days || 30
        const since = new Date(); since.setDate(since.getDate() - days)
        const deletes = await prisma.auditLog.findMany({ where: { action: 'DOCUMENT_DELETE', createdAt: { gte: since } }, include: { user: { select: { name: true, role: true } } } })
        return { period: `Last ${days} days`, anomalies: deletes.length, deletions: deletes.map(d => ({ by: d.user.name, role: d.user.role, desc: d.description, time: d.createdAt })), summary: deletes.length === 0 ? 'No anomalies detected.' : `${deletes.length} deletion(s) detected.` }
      }

      case 'get_procurement_audit': {
        const where = args.department ? { department: { contains: args.department, mode: 'insensitive' } } : {}
        const [all, rejected, highCost] = await Promise.all([
          prisma.procurementRequest.count({ where }),
          prisma.procurementRequest.findMany({ where: { ...where, status: 'REJECTED' }, include: { requestedBy: { select: { name: true } } } }),
          prisma.procurementRequest.findMany({ where: { ...where, estimatedCost: { gt: 2000000 } }, orderBy: { estimatedCost: 'desc' }, take: 5 }),
        ])
        return { total: all, rejected: rejected.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, reason: r.gmComment || r.deptHeadComment })), highValue: highCost.map(r => ({ ref: r.referenceNo, cost: r.estimatedCost, status: r.status })) }
      }

      case 'get_compliance_report': {
        const from = args.dateFrom ? new Date(args.dateFrom) : new Date(new Date().setDate(new Date().getDate() - 30))
        const to   = args.dateTo   ? new Date(args.dateTo)   : new Date()
        const byDept = await prisma.activityLog.groupBy({ by: ['department'], _count: { department: true }, _sum: { hoursSpent: true }, where: { logDate: { gte: from, lte: to } } })
        return { period: { from, to }, byDepartment: byDept }
      }

      case 'get_document_access_log': {
        const days  = args.days || 7
        const since = new Date(); since.setDate(since.getDate() - days)
        const logs  = await prisma.auditLog.findMany({ where: { action: { in: ['DOCUMENT_UPLOAD','DOCUMENT_DOWNLOAD','DOCUMENT_DELETE'] }, createdAt: { gte: since } }, include: { user: { select: { name: true, role: true } } }, orderBy: { createdAt: 'desc' } })
        return { period: `Last ${days} days`, total: logs.length, events: logs.map(l => ({ action: l.action, by: l.user.name, desc: l.description, time: l.createdAt })) }
      }

      case 'get_registry_summary': {
        const where = {}
        if (args.direction) where.direction = args.direction
        if (args.status)    where.status    = args.status
        const [entries, total, byDir, byStatus] = await Promise.all([
          prisma.registryEntry.findMany({ where, take: args.limit || 5, orderBy: { dateRegistered: 'desc' }, include: { handledBy: { select: { name: true } } } }),
          prisma.registryEntry.count({ where }),
          prisma.registryEntry.groupBy({ by: ['direction'], _count: { direction: true } }),
          prisma.registryEntry.groupBy({ by: ['status'],    _count: { status: true } }),
        ])
        return { total, byDirection: byDir, byStatus, recent: entries.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, status: e.status, priority: e.priority })) }
      }

      case 'get_pending_registry': {
        const entries = await prisma.registryEntry.findMany({ where: { status: { in: ['PENDING','DISPATCHED'] } }, include: { handledBy: { select: { name: true } } }, orderBy: { dateRegistered: 'asc' } })
        return { count: entries.length, entries: entries.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, status: e.status, priority: e.priority, since: e.dateRegistered })) }
      }

      case 'search_registry': {
        const entries = await prisma.registryEntry.findMany({
          where: { OR: [{ subject: { contains: args.query, mode: 'insensitive' } }, { registryNo: { contains: args.query, mode: 'insensitive' } }, { source: { contains: args.query, mode: 'insensitive' } }], ...(args.direction ? { direction: args.direction } : {}) },
          take: 5,
        })
        return { query: args.query, results: entries.length, entries: entries.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, status: e.status })) }
      }

      case 'get_registry_analytics': {
        const [byDir, byType, byStatus, total] = await Promise.all([
          prisma.registryEntry.groupBy({ by: ['direction'], _count: { direction: true } }),
          prisma.registryEntry.groupBy({ by: ['docType'],   _count: { docType: true } }),
          prisma.registryEntry.groupBy({ by: ['status'],    _count: { status: true } }),
          prisma.registryEntry.count(),
        ])
        return { total, byDirection: byDir, byDocType: byType, byStatus }
      }

      default:
        return { error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    console.error(`Tool ${toolName} failed:`, err)
    return { error: err.message }
  }
}

// ── MAIN ROUTE ────────────────────────────────────────────────────────────────

router.post('/', authenticate, async (req, res) => {
  try {
    const { messages } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return error(res, 'Messages array is required')
    }

    const userRole = req.user.role
    const date     = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    })

    const systemPrompt = SYSTEM_PROMPTS[userRole]
      ? SYSTEM_PROMPTS[userRole](req.user, date)
      : SYSTEM_PROMPTS.STAFF(req.user, date)

    const tools = TOOLS_BY_ROLE[userRole] || TOOLS_BY_ROLE.STAFF

    const model = genAI.getGenerativeModel({
      model:             'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      tools:             [tools],
      generationConfig:  { maxOutputTokens: 1500, temperature: 0.3 },
    })

    // Build chat history
    const history = messages
      .filter(m => m.id !== 0)
      .slice(0, -1)
      .map(m => ({
        role:  m.role === 'ai' ? 'model' : 'user',
        parts: [{ text: String(m.text) }],
      }))

    const chat       = model.startChat({ history })
    const lastMsg    = messages[messages.length - 1]
    let   response   = await chat.sendMessage(String(lastMsg.text))
    let   iterations = 0

    while (iterations < 8) {
      iterations++
      const candidate    = response.response.candidates?.[0]
      const functionCalls = candidate?.content?.parts?.filter(p => p.functionCall)?.map(p => p.functionCall) || []

      if (functionCalls.length === 0) break

      const results = await Promise.all(
        functionCalls.map(async fc => ({
          functionResponse: {
            name:     fc.name,
            response: await executeTool(fc.name, fc.args || {}, req.user),
          },
        }))
      )

      response = await chat.sendMessage(results)
    }

    return success(res, { message: response.response.text() })
  } catch (err) {
    console.error('AI route error:', err)
    return serverError(res, err)
  }
})

export default router
import { Router } from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { prisma } from '../lib/prisma.js'
import { success, error, serverError, unauthorized } from '../lib/response.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  GENERAL_MANAGER: (user, date) => `
You are the DIMS Executive Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the General Manager of UACC.
Today is ${date}. UACC is a government-owned aviation corporation at Entebbe International Airport.
Give executive-level, data-driven, action-oriented responses.
Always highlight items requiring GM decision. Flag anomalies proactively.
Use UGX for currency. Never make up data — always use your tools first.`,

  DEPARTMENT_HEAD: (user, date) => `
You are the DIMS Department Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, Department Head of ${user.department?.replace(/_/g, ' ')}.
Today is ${date}.
Focus on department-specific data, pending approvals, team activity and documents.
Never make up data — always use your tools first.`,

  STAFF: (user, date) => `
You are the DIMS Personal Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, a staff member in ${user.department?.replace(/_/g, ' ')}.
Today is ${date}.
Help with daily tasks: checking request status, finding documents, activity log reminders.
Be friendly and use simple language. Never make up data — always use your tools first.`,

  IT_ADMINISTRATOR: (user, date) => `
You are the DIMS System Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the IT Administrator.
Today is ${date}.
Help with user management, system health, audit monitoring and security.
Be technical and precise. Never make up data — always use your tools first.`,

  AUDITOR: (user, date) => `
You are the DIMS Audit Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the Internal Auditor.
Today is ${date}.
Help with audit trail analysis, compliance reports, anomaly detection and procurement auditing.
Be formal and evidence-based. Never make up data — always use your tools first.`,

  RECORDS_EXECUTIVE: (user, date) => `
You are the DIMS Records Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${user.name}, the Records Executive.
Today is ${date}.
Help with registry management, document tracking and correspondence monitoring.
Reference documents by REG-UACC-YYYY-XXXX. Never make up data — always use your tools first.`,
}

// ── GEMINI TOOLS BY ROLE ──────────────────────────────────────────────────────

const TOOLS_BY_ROLE = {
  GENERAL_MANAGER: {
    functionDeclarations: [
      { name: 'get_system_overview',     description: 'Complete DIMS system metrics',    parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_pending_decisions',   description: 'Items awaiting GM decision',      parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_procurement_summary', description: 'Procurement stats and requests',  parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' }, department: { type: 'STRING' }, limit: { type: 'NUMBER' } } } },
      { name: 'get_document_summary',    description: 'Document repository stats',       parameters: { type: 'OBJECT', properties: { category: { type: 'STRING' }, department: { type: 'STRING' } } } },
      { name: 'get_activity_log_summary',description: 'Staff activity log stats',        parameters: { type: 'OBJECT', properties: { department: { type: 'STRING' }, dateFrom: { type: 'STRING' }, dateTo: { type: 'STRING' } } } },
      { name: 'get_department_performance', description: 'Performance metrics by dept', parameters: { type: 'OBJECT', properties: { department: { type: 'STRING' } } } },
      { name: 'get_audit_summary',       description: 'Audit trail summary',            parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' }, action: { type: 'STRING' } } } },
    ],
  },
  DEPARTMENT_HEAD: {
    functionDeclarations: [
      { name: 'get_dept_overview',      description: 'Department overview',              parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_pending_approvals',  description: 'Requests awaiting dept approval',  parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_dept_procurement',   description: 'Department procurement requests',  parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' }, limit: { type: 'NUMBER' } } } },
      { name: 'get_dept_activity_logs', description: 'Department activity logs',         parameters: { type: 'OBJECT', properties: { dateFrom: { type: 'STRING' }, dateTo: { type: 'STRING' } } } },
      { name: 'get_dept_documents',     description: 'Department documents',             parameters: { type: 'OBJECT', properties: { category: { type: 'STRING' } } } },
    ],
  },
  STAFF: {
    functionDeclarations: [
      { name: 'get_my_overview',                description: 'Personal DIMS overview',          parameters: { type: 'OBJECT', properties: {} } },
      { name: 'check_todays_log',               description: 'Check if log submitted today',    parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_my_procurement_requests',    description: 'My procurement requests',         parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' } } } },
      { name: 'get_my_activity_logs',           description: 'My activity log history',         parameters: { type: 'OBJECT', properties: { limit: { type: 'NUMBER' } } } },
      { name: 'search_documents',               description: 'Search document repository',      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, category: { type: 'STRING' } } } },
    ],
  },
  IT_ADMINISTRATOR: {
    functionDeclarations: [
      { name: 'get_system_overview',  description: 'Complete system overview',    parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_system_health',    description: 'System health and DB stats',  parameters: { type: 'OBJECT', properties: {} } },
      { name: 'get_user_list',        description: 'All DIMS users',              parameters: { type: 'OBJECT', properties: { role: { type: 'STRING' }, isActive: { type: 'BOOLEAN' } } } },
      { name: 'get_security_report',  description: 'Security events report',      parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
      { name: 'get_audit_summary',    description: 'Audit trail summary',         parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
    ],
  },
  AUDITOR: {
    functionDeclarations: [
      { name: 'get_audit_summary',        description: 'Audit trail summary',          parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' }, action: { type: 'STRING' } } } },
      { name: 'get_audit_anomalies',      description: 'Detect audit anomalies',       parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
      { name: 'get_procurement_audit',    description: 'Procurement audit analysis',   parameters: { type: 'OBJECT', properties: { department: { type: 'STRING' } } } },
      { name: 'get_compliance_report',    description: 'Activity log compliance',      parameters: { type: 'OBJECT', properties: { dateFrom: { type: 'STRING' }, dateTo: { type: 'STRING' } } } },
      { name: 'get_document_access_log',  description: 'Document access audit',        parameters: { type: 'OBJECT', properties: { days: { type: 'NUMBER' } } } },
    ],
  },
  RECORDS_EXECUTIVE: {
    functionDeclarations: [
      { name: 'get_registry_summary',   description: 'Registry statistics',          parameters: { type: 'OBJECT', properties: { direction: { type: 'STRING' }, status: { type: 'STRING' } } } },
      { name: 'get_pending_registry',   description: 'Pending registry entries',     parameters: { type: 'OBJECT', properties: {} } },
      { name: 'search_registry',        description: 'Search the registry',          parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, direction: { type: 'STRING' } } } },
      { name: 'get_registry_analytics', description: 'Registry analytics overview',  parameters: { type: 'OBJECT', properties: {} } },
    ],
  },
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────

async function executeTool(toolName, args, user) {
  const userId   = user.id
  const userRole = user.role
  const userDept = user.department

  try {
    switch (toolName) {
      case 'get_system_overview': {
        const today = new Date(); today.setHours(0,0,0,0)
        const [totalDocs, totalProc, pendingProc, totalLogs, logsToday, totalUsers, activeUsers, totalRegistry] =
          await Promise.all([
            prisma.document.count(),
            prisma.procurementRequest.count(),
            prisma.procurementRequest.count({ where: { status: { in: ['PENDING','DEPT_HEAD_APPROVED'] } } }),
            prisma.activityLog.count(),
            prisma.activityLog.count({ where: { createdAt: { gte: today } } }),
            prisma.user.count(),
            prisma.user.count({ where: { isActive: true } }),
            prisma.registryEntry.count(),
          ])
        return { documents: { total: totalDocs }, procurement: { total: totalProc, pending: pendingProc }, activityLogs: { total: totalLogs, today: logsToday }, users: { total: totalUsers, active: activeUsers }, registry: { total: totalRegistry }, asOf: new Date().toISOString() }
      }

      case 'get_pending_decisions': {
        const [pendingProc, pendingReg] = await Promise.all([
          prisma.procurementRequest.findMany({ where: { status: { in: ['PENDING','DEPT_HEAD_APPROVED'] } }, include: { requestedBy: { select: { name: true, department: true } } }, orderBy: { createdAt: 'asc' } }),
          prisma.registryEntry.findMany({ where: { status: { in: ['PENDING','DISPATCHED'] } }, orderBy: { dateRegistered: 'asc' } }),
        ])
        return {
          awaitingGM:        pendingProc.filter(r => r.status === 'DEPT_HEAD_APPROVED').map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, by: r.requestedBy.name })),
          awaitingDeptHead:  pendingProc.filter(r => r.status === 'PENDING').map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, by: r.requestedBy.name })),
          registryPending:   pendingReg.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, priority: e.priority })),
        }
      }

      case 'get_procurement_summary': {
        const where = {}
        if (args.status && args.status !== 'ALL') where.status = args.status
        if (args.department) where.department = { contains: args.department, mode: 'insensitive' }
        const [requests, total, byStatus, totalCost] = await Promise.all([
          prisma.procurementRequest.findMany({ where, take: args.limit || 5, orderBy: { createdAt: 'desc' }, include: { requestedBy: { select: { name: true } } } }),
          prisma.procurementRequest.count({ where }),
          prisma.procurementRequest.groupBy({ by: ['status'], _count: { status: true } }),
          prisma.procurementRequest.aggregate({ where, _sum: { estimatedCost: true } }),
        ])
        return { total, totalCost: totalCost._sum.estimatedCost, byStatus, recent: requests.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, status: r.status, by: r.requestedBy.name })) }
      }

      case 'get_document_summary': {
        const where = {}
        if (args.category)   where.category   = args.category
        if (args.department) where.department = args.department
        const [docs, total, byCategory] = await Promise.all([
          prisma.document.findMany({ where, take: 5, orderBy: { createdAt: 'desc' }, include: { uploader: { select: { name: true } } } }),
          prisma.document.count({ where }),
          prisma.document.groupBy({ by: ['category'], _count: { category: true } }),
        ])
        return { total, byCategory, recent: docs.map(d => ({ title: d.title, category: d.category, dept: d.department, by: d.uploader.name })) }
      }

      case 'get_activity_log_summary': {
        const where = {}
        if (args.department) where.department = args.department
        if (args.dateFrom)   where.logDate    = { gte: new Date(args.dateFrom) }
        if (args.dateTo)     where.logDate    = { ...where.logDate, lte: new Date(args.dateTo) }
        const [logs, total, agg] = await Promise.all([
          prisma.activityLog.findMany({ where, take: 5, orderBy: { logDate: 'desc' }, include: { user: { select: { name: true } } } }),
          prisma.activityLog.count({ where }),
          prisma.activityLog.aggregate({ where, _sum: { hoursSpent: true }, _avg: { hoursSpent: true } }),
        ])
        return { total, totalHours: agg._sum.hoursSpent, avgHours: agg._avg.hoursSpent, recent: logs.map(l => ({ staff: l.user.name, dept: l.department, date: l.logDate, hours: l.hoursSpent })) }
      }

      case 'get_department_performance': {
        const depts = ['GENERAL_MANAGER_OFFICE','FINANCE_AND_ADMINISTRATION','ENGINEERING','PILOTS','OPERATIONS']
        const targets = args.department ? [args.department] : depts
        const perf = await Promise.all(targets.map(async dept => {
          const [proc, logs, docs, hrs] = await Promise.all([
            prisma.procurementRequest.count({ where: { department: dept } }),
            prisma.activityLog.count({ where: { department: dept } }),
            prisma.document.count({ where: { department: dept } }),
            prisma.activityLog.aggregate({ where: { department: dept }, _sum: { hoursSpent: true } }),
          ])
          return { department: dept.replace(/_/g,' '), procurement: proc, activityLogs: logs, documents: docs, totalHours: hrs._sum.hoursSpent || 0 }
        }))
        return { departments: perf }
      }

      case 'get_audit_summary': {
        const days  = args.days || 7
        const since = new Date(); since.setDate(since.getDate() - days)
        const [logs, total, byAction] = await Promise.all([
          prisma.auditLog.findMany({ where: { createdAt: { gte: since }, ...(args.action ? { action: args.action } : {}) }, take: 10, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true, role: true } } } }),
          prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
          prisma.auditLog.groupBy({ by: ['action'], _count: { action: true }, where: { createdAt: { gte: since } }, orderBy: { _count: { action: 'desc' } } }),
        ])
        return { period: `Last ${days} days`, total, byAction, recent: logs.map(l => ({ user: l.user.name, action: l.action, desc: l.description, time: l.createdAt })) }
      }

      case 'get_dept_overview': {
        const [proc, pending, logs, docs, hrs] = await Promise.all([
          prisma.procurementRequest.count({ where: { department: userDept } }),
          prisma.procurementRequest.count({ where: { department: userDept, status: 'PENDING' } }),
          prisma.activityLog.count({ where: { department: userDept } }),
          prisma.document.count({ where: { department: userDept } }),
          prisma.activityLog.aggregate({ where: { department: userDept }, _sum: { hoursSpent: true } }),
        ])
        return { department: userDept, procurement: { total: proc, pending }, activityLogs: { total: logs }, documents: { total: docs }, totalHours: hrs._sum.hoursSpent }
      }

      case 'get_pending_approvals': {
        const reqs = await prisma.procurementRequest.findMany({ where: { department: userDept, status: 'PENDING' }, include: { requestedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' } })
        return { count: reqs.length, requests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, by: r.requestedBy.name, date: r.createdAt })) }
      }

      case 'get_dept_procurement': {
        const where = { department: userDept }
        if (args.status) where.status = args.status
        const reqs = await prisma.procurementRequest.findMany({ where, take: args.limit || 10, orderBy: { createdAt: 'desc' }, include: { requestedBy: { select: { name: true } } } })
        return { department: userDept, total: reqs.length, requests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, status: r.status, by: r.requestedBy.name })) }
      }

      case 'get_dept_activity_logs': {
        const where = { department: userDept }
        if (args.dateFrom) where.logDate = { gte: new Date(args.dateFrom) }
        if (args.dateTo)   where.logDate = { ...where.logDate, lte: new Date(args.dateTo) }
        const logs = await prisma.activityLog.findMany({ where, take: 10, orderBy: { logDate: 'desc' }, include: { user: { select: { name: true } } } })
        return { department: userDept, total: logs.length, logs: logs.map(l => ({ staff: l.user.name, date: l.logDate, hours: l.hoursSpent })) }
      }

      case 'get_dept_documents': {
        const where = { department: userDept }
        if (args.category) where.category = args.category
        const docs = await prisma.document.findMany({ where, take: 10, orderBy: { createdAt: 'desc' }, include: { uploader: { select: { name: true } } } })
        return { department: userDept, total: docs.length, documents: docs.map(d => ({ title: d.title, category: d.category, by: d.uploader.name })) }
      }

      case 'get_my_overview': {
        const today = new Date(); today.setHours(0,0,0,0)
        const [reqs, logs, todayLog] = await Promise.all([
          prisma.procurementRequest.findMany({ where: { requestedById: userId }, orderBy: { createdAt: 'desc' }, take: 3 }),
          prisma.activityLog.count({ where: { userId } }),
          prisma.activityLog.findFirst({ where: { userId, logDate: { gte: today } } }),
        ])
        return { todayLogSubmitted: !!todayLog, totalLogs: logs, recentRequests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, status: r.status })) }
      }

      case 'check_todays_log': {
        const today = new Date(); today.setHours(0,0,0,0)
        const log = await prisma.activityLog.findFirst({ where: { userId, logDate: { gte: today } } })
        return { submitted: !!log, message: log ? 'You have submitted your log for today.' : 'You have NOT submitted your activity log today. Please do so before 5PM.' }
      }

      case 'get_my_procurement_requests': {
        const where = { requestedById: userId }
        if (args.status) where.status = args.status
        const reqs = await prisma.procurementRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 })
        return { total: reqs.length, requests: reqs.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, status: r.status, comment: r.gmComment || r.deptHeadComment })) }
      }

      case 'get_my_activity_logs': {
        const logs = await prisma.activityLog.findMany({ where: { userId }, take: args.limit || 10, orderBy: { logDate: 'desc' } })
        const hrs  = await prisma.activityLog.aggregate({ where: { userId }, _sum: { hoursSpent: true } })
        return { total: logs.length, totalHours: hrs._sum.hoursSpent, logs: logs.map(l => ({ date: l.logDate, hours: l.hoursSpent, desc: l.activityDescription.substring(0,80) })) }
      }

      case 'search_documents': {
        const docs = await prisma.document.findMany({
          where: { AND: [{ title: { contains: args.query, mode: 'insensitive' } }, args.category ? { category: args.category } : {}] },
          take:  5,
          include: { uploader: { select: { name: true } } },
        })
        return { query: args.query, results: docs.length, documents: docs.map(d => ({ title: d.title, category: d.category, dept: d.department, by: d.uploader.name })) }
      }

      case 'get_user_list': {
        const where = {}
        if (args.role)     where.role     = args.role
        if (args.isActive !== undefined) where.isActive = args.isActive
        const users = await prisma.user.findMany({ where, select: { id: true, name: true, email: true, role: true, department: true, isActive: true } })
        return { total: users.length, users }
      }

      case 'get_system_health': {
        const [docs, proc, logs, reg, users, audit] = await Promise.all([
          prisma.document.count(), prisma.procurementRequest.count(),
          prisma.activityLog.count(), prisma.registryEntry.count(),
          prisma.user.count(), prisma.auditLog.count(),
        ])
        return { databaseRecords: { documents: docs, procurement: proc, activityLogs: logs, registry: reg, users, auditLogs: audit }, status: 'HEALTHY' }
      }

      case 'get_security_report': {
        const days  = args.days || 7
        const since = new Date(); since.setDate(since.getDate() - days)
        const [deletes, logins, changes] = await Promise.all([
          prisma.auditLog.findMany({ where: { action: 'DOCUMENT_DELETE', createdAt: { gte: since } }, include: { user: { select: { name: true, role: true } } } }),
          prisma.auditLog.count({ where: { action: 'LOGIN', createdAt: { gte: since } } }),
          prisma.auditLog.findMany({ where: { action: { in: ['USER_CREATED','USER_UPDATED','USER_DEACTIVATED'] }, createdAt: { gte: since } }, include: { user: { select: { name: true } } } }),
        ])
        return { period: `Last ${days} days`, logins, deletions: deletes.length, deleteEvents: deletes.map(d => ({ by: d.user.name, desc: d.description, time: d.createdAt })), userChanges: changes.map(c => ({ action: c.action, by: c.user.name, time: c.createdAt })) }
      }

      case 'get_audit_anomalies': {
        const days  = args.days || 30
        const since = new Date(); since.setDate(since.getDate() - days)
        const deletes = await prisma.auditLog.findMany({ where: { action: 'DOCUMENT_DELETE', createdAt: { gte: since } }, include: { user: { select: { name: true, role: true } } } })
        return { period: `Last ${days} days`, anomalies: deletes.length, deletions: deletes.map(d => ({ by: d.user.name, role: d.user.role, desc: d.description, time: d.createdAt })), summary: deletes.length === 0 ? 'No anomalies detected.' : `${deletes.length} deletion(s) detected.` }
      }

      case 'get_procurement_audit': {
        const where = args.department ? { department: { contains: args.department, mode: 'insensitive' } } : {}
        const [all, rejected, highCost] = await Promise.all([
          prisma.procurementRequest.count({ where }),
          prisma.procurementRequest.findMany({ where: { ...where, status: 'REJECTED' }, include: { requestedBy: { select: { name: true } } } }),
          prisma.procurementRequest.findMany({ where: { ...where, estimatedCost: { gt: 2000000 } }, orderBy: { estimatedCost: 'desc' }, take: 5 }),
        ])
        return { total: all, rejected: rejected.map(r => ({ ref: r.referenceNo, item: r.itemDescription, cost: r.estimatedCost, reason: r.gmComment || r.deptHeadComment })), highValue: highCost.map(r => ({ ref: r.referenceNo, cost: r.estimatedCost, status: r.status })) }
      }

      case 'get_compliance_report': {
        const from = args.dateFrom ? new Date(args.dateFrom) : new Date(new Date().setDate(new Date().getDate() - 30))
        const to   = args.dateTo   ? new Date(args.dateTo)   : new Date()
        const byDept = await prisma.activityLog.groupBy({ by: ['department'], _count: { department: true }, _sum: { hoursSpent: true }, where: { logDate: { gte: from, lte: to } } })
        return { period: { from, to }, byDepartment: byDept }
      }

      case 'get_document_access_log': {
        const days  = args.days || 7
        const since = new Date(); since.setDate(since.getDate() - days)
        const logs  = await prisma.auditLog.findMany({ where: { action: { in: ['DOCUMENT_UPLOAD','DOCUMENT_DOWNLOAD','DOCUMENT_DELETE'] }, createdAt: { gte: since } }, include: { user: { select: { name: true, role: true } } }, orderBy: { createdAt: 'desc' } })
        return { period: `Last ${days} days`, total: logs.length, events: logs.map(l => ({ action: l.action, by: l.user.name, desc: l.description, time: l.createdAt })) }
      }

      case 'get_registry_summary': {
        const where = {}
        if (args.direction) where.direction = args.direction
        if (args.status)    where.status    = args.status
        const [entries, total, byDir, byStatus] = await Promise.all([
          prisma.registryEntry.findMany({ where, take: args.limit || 5, orderBy: { dateRegistered: 'desc' }, include: { handledBy: { select: { name: true } } } }),
          prisma.registryEntry.count({ where }),
          prisma.registryEntry.groupBy({ by: ['direction'], _count: { direction: true } }),
          prisma.registryEntry.groupBy({ by: ['status'],    _count: { status: true } }),
        ])
        return { total, byDirection: byDir, byStatus, recent: entries.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, status: e.status, priority: e.priority })) }
      }

      case 'get_pending_registry': {
        const entries = await prisma.registryEntry.findMany({ where: { status: { in: ['PENDING','DISPATCHED'] } }, include: { handledBy: { select: { name: true } } }, orderBy: { dateRegistered: 'asc' } })
        return { count: entries.length, entries: entries.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, status: e.status, priority: e.priority, since: e.dateRegistered })) }
      }

      case 'search_registry': {
        const entries = await prisma.registryEntry.findMany({
          where: { OR: [{ subject: { contains: args.query, mode: 'insensitive' } }, { registryNo: { contains: args.query, mode: 'insensitive' } }, { source: { contains: args.query, mode: 'insensitive' } }], ...(args.direction ? { direction: args.direction } : {}) },
          take: 5,
        })
        return { query: args.query, results: entries.length, entries: entries.map(e => ({ ref: e.registryNo, subject: e.subject, direction: e.direction, status: e.status })) }
      }

      case 'get_registry_analytics': {
        const [byDir, byType, byStatus, total] = await Promise.all([
          prisma.registryEntry.groupBy({ by: ['direction'], _count: { direction: true } }),
          prisma.registryEntry.groupBy({ by: ['docType'],   _count: { docType: true } }),
          prisma.registryEntry.groupBy({ by: ['status'],    _count: { status: true } }),
          prisma.registryEntry.count(),
        ])
        return { total, byDirection: byDir, byDocType: byType, byStatus }
      }

      default:
        return { error: `Unknown tool: ${toolName}` }
    }
  } catch (err) {
    console.error(`Tool ${toolName} failed:`, err)
    return { error: err.message }
  }
}

// ── MAIN ROUTE ────────────────────────────────────────────────────────────────

router.post('/', authenticate, async (req, res) => {
  try {
    const { messages } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return error(res, 'Messages array is required')
    }

    const userRole = req.user.role
    const date     = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    })

    const systemPrompt = SYSTEM_PROMPTS[userRole]
      ? SYSTEM_PROMPTS[userRole](req.user, date)
      : SYSTEM_PROMPTS.STAFF(req.user, date)

    const tools = TOOLS_BY_ROLE[userRole] || TOOLS_BY_ROLE.STAFF

    const model = genAI.getGenerativeModel({
      model:             'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      tools:             [tools],
      generationConfig:  { maxOutputTokens: 1500, temperature: 0.3 },
    })

    // Build chat history
    const history = messages
      .filter(m => m.id !== 0)
      .slice(0, -1)
      .map(m => ({
        role:  m.role === 'ai' ? 'model' : 'user',
        parts: [{ text: String(m.text) }],
      }))

    const chat       = model.startChat({ history })
    const lastMsg    = messages[messages.length - 1]
    let   response   = await chat.sendMessage(String(lastMsg.text))
    let   iterations = 0

    while (iterations < 8) {
      iterations++
      const candidate    = response.response.candidates?.[0]
      const functionCalls = candidate?.content?.parts?.filter(p => p.functionCall)?.map(p => p.functionCall) || []

      if (functionCalls.length === 0) break

      const results = await Promise.all(
        functionCalls.map(async fc => ({
          functionResponse: {
            name:     fc.name,
            response: await executeTool(fc.name, fc.args || {}, req.user),
          },
        }))
      )

      response = await chat.sendMessage(results)
    }

    return success(res, { message: response.response.text() })
  } catch (err) {
    console.error('AI route error:', err)
    return serverError(res, err)
  }
})

export default router
