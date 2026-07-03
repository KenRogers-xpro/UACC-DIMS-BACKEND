const express = require('express');
const prisma = require('../lib/prisma');
const { success, error, serverError, paginated } = require('../lib/response');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit, getClientIp } = require('../lib/audit');

const router = express.Router();

/**
 * @route   GET /api/registry
 * @desc    Get registry entries
 * @access  Private
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, direction, search, page = 1, limit = 10 } = req.query;

    const where = {};
    if (status && status !== 'All') where.status = status;
    if (direction && direction !== 'All') where.direction = direction;

    if (search) {
      where.OR = [
        { registryNo: { contains: search } },
        { subject: { contains: search } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [entries, total] = await Promise.all([
      prisma.registryEntry.findMany({
        where,
        include: {
          handledBy: { select: { name: true } },
          annotations: {
            include: { author: { select: { name: true, role: true } } },
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.registryEntry.count({ where }),
    ]);

    // Format for frontend
    const formattedEntries = entries.map(entry => ({
      ...entry,
      handledBy: entry.handledBy.name,
      latestAnnotation: entry.annotations[0] ? {
        text: entry.annotations[0].text,
        author: entry.annotations[0].author.name,
        role: entry.annotations[0].author.role,
        timestamp: entry.annotations[0].createdAt
      } : null
    }));

    return paginated(res, { data: formattedEntries, total, page: Number(page), limit: take });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   GET /api/registry/:id
 * @desc    Get single registry entry with all annotations
 * @access  Private
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const entry = await prisma.registryEntry.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        handledBy: { select: { name: true } },
        annotations: {
          include: { author: { select: { name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        }
      }
    });

    if (!entry) return error(res, 'Registry entry not found', 404);

    const formattedEntry = {
      ...entry,
      handledBy: entry.handledBy.name,
      annotations: entry.annotations.map(a => ({
        id: a.id,
        text: a.text,
        author: a.author.name,
        role: a.author.role,
        timestamp: a.createdAt
      }))
    };

    return success(res, formattedEntry);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/registry
 * @desc    Create new registry entry
 * @access  Private (RECORDS_EXECUTIVE, ADMIN, GM)
 */
router.post('/', authenticate, authorize('RECORDS_EXECUTIVE', 'IT_ADMINISTRATOR', 'GENERAL_MANAGER'), async (req, res) => {
  try {
    const data = req.body;
    
    // Generate Registry No: REG-UACC-YYYY-XXXX
    const year = new Date().getFullYear();
    const count = await prisma.registryEntry.count();
    const registryNo = `REG-UACC-${year}-${String(count + 1).padStart(4, '0')}`;

    const newEntry = await prisma.registryEntry.create({
      data: {
        registryNo,
        subject: data.subject,
        docType: data.docType,
        direction: data.direction,
        source: data.source,
        destination: data.destination,
        receivedFrom: data.receivedFrom,
        handledById: req.user.id,
        priority: data.priority,
        medium: data.medium,
        fileRef: data.fileRef,
        physicalLocation: data.physicalLocation,
        dateRegistered: new Date(),
        dateReceived: data.dateReceived ? new Date(data.dateReceived) : new Date(),
        status: 'PENDING'
      },
    });

    // Automatically create initial annotation
    if (data.initialNote) {
      await prisma.annotation.create({
        data: {
          registryEntryId: newEntry.id,
          authorId: req.user.id,
          text: data.initialNote
        }
      });
    }

    await logAudit({
      userId: req.user.id,
      action: 'LOG_ENTRY', // Repurposing LOG_ENTRY or could make a new action
      module: 'Records Registry',
      description: `Created new registry entry: ${registryNo}`,
      ipAddress: getClientIp(req),
    });

    return success(res, newEntry, 201);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   PATCH /api/registry/:id
 * @desc    Update registry entry status/details
 * @access  Private
 */
router.patch('/:id', authenticate, authorize('RECORDS_EXECUTIVE', 'IT_ADMINISTRATOR', 'GENERAL_MANAGER'), async (req, res) => {
  try {
    const { status, physicalLocation, dateDispatched, dateClosed } = req.body;
    
    const updateData = {};
    if (status) updateData.status = status;
    if (physicalLocation !== undefined) updateData.physicalLocation = physicalLocation;
    if (dateDispatched) updateData.dateDispatched = new Date(dateDispatched);
    if (dateClosed || status === 'CLOSED') updateData.dateClosed = new Date();

    const updated = await prisma.registryEntry.update({
      where: { id: Number(req.params.id) },
      data: updateData
    });

    return success(res, updated);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/registry/:id/annotations
 * @desc    Add an annotation to a registry entry
 * @access  Private
 */
router.post('/:id/annotations', authenticate, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return error(res, 'Annotation text is required');

    const entry = await prisma.registryEntry.findUnique({ where: { id: Number(req.params.id) } });
    if (!entry) return error(res, 'Registry entry not found', 404);

    const annotation = await prisma.annotation.create({
      data: {
        registryEntryId: entry.id,
        authorId: req.user.id,
        text
      },
      include: {
        author: { select: { name: true, role: true } }
      }
    });

    const formatted = {
      id: annotation.id,
      text: annotation.text,
      author: annotation.author.name,
      role: annotation.author.role,
      timestamp: annotation.createdAt
    };

    return success(res, formatted, 201);
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
