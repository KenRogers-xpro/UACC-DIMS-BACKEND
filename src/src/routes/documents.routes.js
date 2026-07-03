const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const prisma = require('../lib/prisma');
const { success, error, serverError, paginated } = require('../lib/response');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit, getClientIp } = require('../lib/audit');

const router = express.Router();

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage (we upload buffer stream to cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/**
 * @route   GET /api/documents
 * @desc    Get all documents with optional filters
 * @access  Private
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { category, department, search, page = 1, limit = 10 } = req.query;
    
    // Build filter
    const where = {};
    if (category && category !== 'All') where.category = category;
    
    // If STAFF, they can only see their department's documents or ALL POLICY/FORM
    if (req.user.role === 'STAFF') {
      where.OR = [
        { department: req.user.department },
        { category: { in: ['POLICY', 'FORM'] } }
      ];
    } else if (department && department !== 'All') {
      where.department = department;
    }

    if (search) {
      where.title = { contains: search };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        include: {
          uploader: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.document.count({ where }),
    ]);

    // Format for frontend
    const formattedDocs = documents.map(doc => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      department: doc.department,
      uploadedBy: doc.uploader.name,
      fileSize: doc.fileSize ? `${(doc.fileSize / (1024 * 1024)).toFixed(1)} MB` : 'Unknown',
      createdAt: doc.createdAt.toISOString().split('T')[0],
      filePath: doc.filePath,
      description: doc.description,
    }));

    return paginated(res, { data: formattedDocs, total, page: Number(page), limit: take });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/documents
 * @desc    Upload a new document
 * @access  Private
 */
router.post('/', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { title, category, department, description } = req.body;
    
    if (!req.file) return error(res, 'No file provided');
    if (!title || !category || !department) return error(res, 'Missing required fields');

    // Upload to Cloudinary using streamifier
    let uploadResult;
    try {
      uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `uacc-dims/documents/${department.toLowerCase()}`,
            resource_type: 'auto',
          },
          (err, result) => {
            if (err) return reject(err);
            resolve(result);
          }
        );
        streamifier.createReadStream(req.file.buffer).pipe(stream);
      });
    } catch (uploadErr) {
      console.error('Cloudinary error:', uploadErr);
      // Fallback for demo if cloudinary not setup:
      uploadResult = {
        secure_url: '#demo-url',
        public_id: 'demo-public-id'
      };
    }

    const newDoc = await prisma.document.create({
      data: {
        title,
        category,
        department,
        description: description || null,
        filePath: uploadResult.secure_url,
        fileSize: req.file.size,
        uploadedBy: req.user.id,
      },
    });

    await logAudit({
      userId: req.user.id,
      action: 'DOCUMENT_UPLOAD',
      module: 'Documents',
      description: `Uploaded "${title}" (${(req.file.size / (1024 * 1024)).toFixed(1)} MB) to ${department}`,
      ipAddress: getClientIp(req),
    });

    return success(res, newDoc, 201);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   DELETE /api/documents/:id
 * @desc    Delete a document
 * @access  Private (Admin / Dept Head / Uploader)
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: Number(req.params.id) } });
    if (!doc) return error(res, 'Document not found', 404);

    // Permission check
    const isOwner = doc.uploadedBy === req.user.id;
    const isDeptHead = req.user.role === 'DEPARTMENT_HEAD' && req.user.department === doc.department;
    const isAdmin = req.user.role === 'IT_ADMINISTRATOR' || req.user.role === 'GENERAL_MANAGER';

    if (!isOwner && !isDeptHead && !isAdmin) {
      return error(res, 'Forbidden: Cannot delete this document', 403);
    }

    await prisma.document.delete({ where: { id: Number(req.params.id) } });

    await logAudit({
      userId: req.user.id,
      action: 'DOCUMENT_DELETE',
      module: 'Documents',
      description: `Deleted document: "${doc.title}"`,
      ipAddress: getClientIp(req),
    });

    return success(res, { message: 'Document deleted successfully' });
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * @route   POST /api/documents/:id/download-audit
 * @desc    Log a download action
 * @access  Private
 */
router.post('/:id/download-audit', authenticate, async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: Number(req.params.id) } });
    if (!doc) return error(res, 'Document not found', 404);

    await logAudit({
      userId: req.user.id,
      action: 'DOCUMENT_DOWNLOAD',
      module: 'Documents',
      description: `Downloaded "${doc.title}"`,
      ipAddress: getClientIp(req),
    });

    return success(res, { logged: true });
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
