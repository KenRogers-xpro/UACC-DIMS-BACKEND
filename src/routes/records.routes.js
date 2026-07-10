import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { success, error, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'

const router = Router()

async function createPendingRouting({ sourceType, sourceId, addressedTo = 'GENERAL_MANAGER' }) {
  return prisma.documentRouting.create({
    data: {
      sourceType,
      sourceId: String(sourceId),
      addressedTo,
      status: 'PENDING_TRIAGE',
    },
  })
}

async function generateRegistryNo() {
  const year = new Date().getFullYear()
  const prefix = `UACC-REG-${year}-`

  const latest = await prisma.registryEntry.findFirst({
    where: { registryNo: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
  })

  if (!latest) return `${prefix}0001`

  const lastNum = parseInt(latest.registryNo.split('-').pop(), 10)
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

// GET /api/records
router.get('/', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const { search = '', status = '', page = 1, limit = 10 } = req.query

    const where = {
      AND: [
        search ? {
          OR: [
            { registryNo: { contains: search, mode: 'insensitive' } },
            { subject: { contains: search, mode: 'insensitive' } },
            { source: { contains: search, mode: 'insensitive' } },
            { destination: { contains: search, mode: 'insensitive' } },
          ],
        } : {},
        status ? { status } : {},
      ],
    }

    const [records, total] = await Promise.all([
      prisma.registryEntry.findMany({
        where,
        include: {
          handledBy: { select: { id: true, name: true, role: true } },
          annotations: {
            include: {
              author: { select: { id: true, name: true, role: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page, 10) - 1) * parseInt(limit, 10),
        take: parseInt(limit, 10),
      }),
      prisma.registryEntry.count({ where }),
    ])

    return success(res, {
      records,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/records
router.post('/', authenticate, authorize(['RECORDS_EXECUTIVE', 'GENERAL_MANAGER', 'IT_ADMINISTRATOR']), async (req, res) => {
  try {
    const {
      subject,
      docType,
      direction,
      source,
      destination,
      receivedFrom,
      handledById,
      priority = 'NORMAL',
      medium,
      fileRef,
      physicalLocation,
      dateRegistered,
      addressedTo,
    } = req.body

    if (!subject || !docType || !direction || !source || !destination || !medium || !dateRegistered) {
      return error(res, 'Subject, type, direction, source, destination, medium and date registered are required')
    }

    const registryNo = await generateRegistryNo()
    const destinationValue = String(destination).trim()
    const addressedValue = String(addressedTo || destinationValue).trim().toUpperCase()

    const record = await prisma.registryEntry.create({
      data: {
        registryNo,
        subject: String(subject).trim(),
        docType,
        direction,
        source: String(source).trim(),
        destination: destinationValue,
        receivedFrom: receivedFrom ? String(receivedFrom).trim() : null,
        handledById: handledById ? parseInt(handledById, 10) : req.user.id,
        priority,
        medium,
        fileRef: fileRef ? String(fileRef).trim() : null,
        physicalLocation: physicalLocation ? String(physicalLocation).trim() : null,
        dateRegistered: new Date(dateRegistered),
      },
      include: {
        handledBy: { select: { id: true, name: true, role: true } },
      },
    })

    if (addressedValue === 'GENERAL_MANAGER') {
      await createPendingRouting({
        sourceType: 'REGISTRY_ENTRY',
        sourceId: record.id,
        addressedTo: 'GENERAL_MANAGER',
      })
    }

    await logAudit({
      userId: req.user.id,
      action: 'LOG_ENTRY',
      module: 'Records',
      description: `Created registry entry ${registryNo}${addressedValue === 'GENERAL_MANAGER' ? ' for GM review' : ''}`,
      ipAddress: req.ip,
    })

    return success(res, record, 'Registry entry created successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// GET /api/records/circulation-copies
router.get('/circulation-copies', authenticate, authorize(['RECORDS_EXECUTIVE']), async (req, res) => {
  try {
    const { status = 'PENDING_FILING' } = req.query
    const copies = await prisma.circulationRecordsCopy.findMany({
      where: { status },
      include: {
        step: {
          include: {
            circulation: true,
            fromUser: { select: { id: true, name: true, role: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    return success(res, copies)
  } catch (err) {
    return serverError(res, err)
  }
})

// PUT /api/records/circulation-copies/:id/file
router.put('/circulation-copies/:id/file', authenticate, authorize(['RECORDS_EXECUTIVE']), async (req, res) => {
  try {
    const { id } = req.params
    const copy = await prisma.circulationRecordsCopy.update({
      where: { id },
      data: {
        status: 'FILED',
        filedById: req.user.id,
        filedAt: new Date()
      }
    })
    return success(res, copy, 'Circulation copy filed successfully')
  } catch (err) {
    return serverError(res, err)
  }
})

export default router