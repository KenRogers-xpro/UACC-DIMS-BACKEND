import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { logAudit } from '../lib/audit.js'
import { uploadToCloudinary, deleteFromCloudinary } from '../lib/cloudinary.js'
import { success, error, notFound, serverError } from '../lib/response.js'
import { authenticate, authorize } from '../middleware/auth.js'
import multer from 'multer'

const router  = Router()
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10485760 } })

// GET /api/documents
router.get('/', authenticate, async (req, res) => {
  try {
    const { search = '', category = '', department = '', page = 1, limit = 8 } = req.query

    const where = {
      AND: [
        search     ? { title:      { contains: search,     mode: 'insensitive' } } : {},
        category   ? { category }   : {},
        department ? { department } : {},
      ],
    }

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: { uploader: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip:    (parseInt(page) - 1) * parseInt(limit),
        take:    parseInt(limit),
      }),
      prisma.document.count({ where }),
    ])

    return success(res, {
      documents,
      pagination: {
        total,
        page:       parseInt(page),
        limit:      parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (err) {
    return serverError(res, err)
  }
})

// POST /api/documents
router.post('/', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { title, category, department, description } = req.body
    const file = req.file

    if (!title || !category || !department || !file) {
      return error(res, 'Title, category, department and file are required')
    }

    // Upload to Cloudinary
    const result = await uploadToCloudinary(
      file.buffer,
      file.originalname,
      file.mimetype,
      'uacc-dims/documents'
    )

    const document = await prisma.document.create({
      data: {
        title:       String(title).trim(),
        category,
        department,
        description: description ? String(description).trim() : null,
        filePath:    result.secure_url,
        publicId:    result.public_id,
        fileSize:    file.size,
        uploadedBy:  req.user.id,
      },
      include: {
        uploader: { select: { id: true, name: true, role: true } }
      },
    })

    await logAudit({
      userId:      req.user.id,
      action:      'DOCUMENT_UPLOAD',
      module:      'Documents',
      description: `Uploaded "${title}" to ${department}`,
      ipAddress:   req.ip,
    })

    return success(res, document, 'Document uploaded successfully', 201)
  } catch (err) {
    return serverError(res, err)
  }
})

// DELETE /api/documents/:id
router.delete(
  '/:id',
  authenticate,
  authorize('IT_ADMINISTRATOR', 'GENERAL_MANAGER'),
  async (req, res) => {
    try {
      const document = await prisma.document.findUnique({
        where: { id: parseInt(req.params.id) }
      })
      if (!document) return notFound(res, 'Document not found')

      // Delete from Cloudinary
      if (document.publicId) {
        await deleteFromCloudinary(document.publicId)
      }

      await prisma.document.delete({ where: { id: parseInt(req.params.id) } })

      await logAudit({
        userId:      req.user.id,
        action:      'DOCUMENT_DELETE',
        module:      'Documents',
        description: `Deleted document: "${document.title}"`,
        ipAddress:   req.ip,
      })

      return success(res, null, 'Document deleted successfully')
    } catch (err) {
      return serverError(res, err)
    }
  }
)

export default router
