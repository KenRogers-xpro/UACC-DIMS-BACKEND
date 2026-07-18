import express from 'express'
import crypto from 'crypto'
import multer from 'multer'
import { authenticate, authorize } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { isPinRequired, verifySigningPin } from '../lib/signatures.js'
import { logAudit } from '../lib/audit.js'
import { generateRegistryNo } from '../lib/registry.js'
import { validateCcRoles, resolveHeldByRole } from '../lib/roles.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10485760 } })

router.use(authenticate)

// POST /api/circulation - Initialize a new document circulation
router.post('/', async (req, res) => {
  try {
    const { title, sourceType, sourceId, toRole, instruction, ccRoles } = req.body
    const originatorId = req.user.id

    let validatedCcRoles
    try {
      validatedCcRoles = validateCcRoles(ccRoles)
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message })
    }

    if (sourceType === 'DRAFT_DOCUMENT') {
      const draft = await prisma.draftDocument.findUnique({ where: { id: sourceId } })
      if (!draft) {
        return res.status(404).json({ success: false, message: 'Draft not found' })
      }
      if (draft.origin === 'AI_GENERATED' && !draft.reviewedAt) {
        return res.status(403).json({ success: false, message: 'This AI-drafted document must be reviewed before it can be submitted. Open it, review the content, and click Confirm Review.' })
      }
    }

    const heldByRole = resolveHeldByRole(req.user.role, toRole)

    const circulation = await prisma.$transaction(async (tx) => {
      return await tx.documentCirculation.create({
        data: {
          title,
          sourceType,
          sourceId,
          originatorId,
          currentHolderRole: heldByRole,
          status: 'IN_CIRCULATION',
          steps: {
            create: {
              stepNumber: 1,
              fromUserId: originatorId,
              fromRole: req.user.role,
              toRole,
              heldByRole,
              ccRoles: validatedCcRoles,
              instruction,
              stepType: 'FORWARD',
              recordsCopies: {
                create: {
                  status: 'PENDING_FILING'
                }
              }
            }
          }
        },
        include: {
          steps: {
            include: {
              recordsCopies: true
            }
          }
        }
      })
    })

    return res.status(201).json({ success: true, circulation })
  } catch (error) {
    console.error('Error creating circulation:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// POST /api/circulation/:id/step - Add a step to an existing circulation
router.post('/:id/step', async (req, res) => {
  try {
    const { id } = req.params
    const { toRole, instruction, stepType, decision, amount, ccRoles } = req.body

    let validatedCcRoles
    try {
      validatedCcRoles = validateCcRoles(ccRoles)
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message })
    }

    const existingCirculation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepNumber: 'desc' },
          take: 1
        }
      }
    })

    if (!existingCirculation) {
      return res.status(404).json({ success: false, message: 'Circulation not found' })
    }

    if (req.user.role !== existingCirculation.currentHolderRole) {
      return res.status(403).json({ success: false, message: 'You are not the current holder of this document' })
    }

    const nextStepNumber = existingCirculation.steps.length > 0
      ? existingCirculation.steps[0].stepNumber + 1
      : 1
    const newStatus = stepType === 'FINAL_DECISION' ? 'CLOSED' : 'IN_CIRCULATION'
    const heldByRole = resolveHeldByRole(req.user.role, toRole)

    const step = await prisma.$transaction(async (tx) => {
      // 1. Update Circulation
      await tx.documentCirculation.update({
        where: { id },
        data: {
          currentHolderRole: heldByRole,
          status: newStatus
        }
      })

      // 2. Create the step and the nested records copy
      return await tx.circulationStep.create({
        data: {
          circulationId: id,
          stepNumber: nextStepNumber,
          fromUserId: req.user.id,
          fromRole: req.user.role,
          toRole,
          heldByRole,
          ccRoles: validatedCcRoles,
          instruction,
          stepType,
          decision,
          amount: amount ? Number(amount) : null,
          recordsCopies: {
            create: {
              status: 'PENDING_FILING'
            }
          }
        },
        include: {
          recordsCopies: true
        }
      })
    })

    return res.status(201).json({ success: true, step })
  } catch (error) {
    console.error('Error adding circulation step:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// POST /api/circulation/:id/sign - Add a step AND a real DigitalSignature in
// one action (the "Sign This Step" flow from SigningModal). PIN verification
// is required unless SIGNING_PIN_REQUIRED=false (demo mode) — either way,
// verifiedWithPin on the resulting record honestly reflects whether a PIN
// was actually checked, never true when it was bypassed.
router.post('/:id/sign', async (req, res) => {
  try {
    const { id } = req.params
    const { pin, toRole, instruction, stepType, decision, amount } = req.body

    const pinRequired = isPinRequired()
    let verifiedWithPin = false

    if (pinRequired) {
      const result = await verifySigningPin(req.user.id, pin)
      if (!result.ok) {
        const status = result.code === 'INCORRECT_PIN' ? 401 : 400
        return res.status(status).json({ success: false, message: result.message, code: result.code })
      }
      verifiedWithPin = true
    }

    const existingCirculation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepNumber: 'desc' },
          take: 1,
          include: { signature: true },
        },
      },
    })
    if (!existingCirculation) {
      return res.status(404).json({ success: false, message: 'Circulation not found' })
    }
    if (req.user.role !== existingCirculation.currentHolderRole) {
      return res.status(403).json({ success: false, message: 'You are not the current holder of this document' })
    }

    const previousHash = existingCirculation.steps[0]?.signature?.signatureHash || null
    const nextStepNumber = existingCirculation.steps.length > 0
      ? existingCirculation.steps[0].stepNumber + 1
      : 1
    const newStatus = stepType === 'FINAL_DECISION' ? 'CLOSED' : 'IN_CIRCULATION'
    const signedAt = new Date()
    // resolvedDecision must be the exact value stored on the signature row
    // below (decision || stepType) — hashing the raw `decision` instead
    // would make GET /:id/verify-integrity's recomputation mismatch for
    // every step with no explicit decision (plain forwards), since it can
    // only recompute from what's actually in the DB.
    const resolvedDecision = decision || stepType
    const signatureHash = crypto
      .createHash('sha256')
      .update(`${req.user.id}:${resolvedDecision}:${signedAt.toISOString()}:${previousHash || ''}`)
      .digest('hex')
    // Same gatekeeping rule as POST /:id/step — signing is just another way
    // a step gets created, and leaving it out would be a straightforward
    // bypass of gatekeeping via the "sign" flow instead of the generic one.
    const heldByRole = resolveHeldByRole(req.user.role, toRole)

    const step = await prisma.$transaction(async (tx) => {
      await tx.documentCirculation.update({
        where: { id },
        data: { currentHolderRole: heldByRole, status: newStatus },
      })

      return tx.circulationStep.create({
        data: {
          circulationId: id,
          stepNumber: nextStepNumber,
          fromUserId: req.user.id,
          fromRole: req.user.role,
          toRole,
          heldByRole,
          instruction,
          stepType,
          decision,
          amount: amount ? Number(amount) : null,
          signedAt,
          recordsCopies: { create: { status: 'PENDING_FILING' } },
          signature: {
            create: {
              signerId: req.user.id,
              signerRole: req.user.role,
              decision: resolvedDecision,
              verifiedWithPin,
              previousHash,
              signatureHash,
              ipAddress: req.ip,
              signedAt,
            },
          },
        },
        include: { recordsCopies: true, signature: true },
      })
    })

    return res.status(201).json({ success: true, step })
  } catch (error) {
    console.error('Error signing circulation step:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// PUT /api/circulation/:id/release — PA-only. Lifts gatekeeping on an item
// currently sitting in the GM<->PA gateway, sending it on to the role it was
// actually declared for all along (the previous step's toRole, untouched
// throughout gatekeeping). Works both directions: an inbound item finally
// reaching the GM, or the GM's own outgoing item finally leaving PA's hands.
// heldByRole is set directly to that declared role here (not run back through
// resolveHeldByRole) — this step IS the deliberate hand-off, so it must not
// immediately re-gatekeep itself.
router.put('/:id/release', authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const { id } = req.params
    const { note } = req.body

    const existingCirculation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepNumber: 'desc' }, take: 1 } },
    })
    if (!existingCirculation) {
      return res.status(404).json({ success: false, message: 'Circulation not found' })
    }
    if (existingCirculation.currentHolderRole !== 'GM_PERSONAL_ASSISTANT') {
      return res.status(403).json({ success: false, message: 'This item is not currently gatekept by the PA' })
    }

    const previousStep = existingCirculation.steps[0]
    const declaredRole = previousStep?.toRole
    if (!declaredRole) {
      return res.status(500).json({ success: false, message: 'Circulation has no prior step to release toward' })
    }

    const nextStepNumber = previousStep ? previousStep.stepNumber + 1 : 1
    const trimmedNote = note && String(note).trim() ? String(note).trim() : null

    const step = await prisma.$transaction(async (tx) => {
      await tx.documentCirculation.update({
        where: { id },
        data: { currentHolderRole: declaredRole },
      })

      return tx.circulationStep.create({
        data: {
          circulationId: id,
          stepNumber: nextStepNumber,
          fromUserId: req.user.id,
          fromRole: req.user.role,
          toRole: declaredRole,
          heldByRole: declaredRole,
          instruction: trimmedNote || 'Reviewed by PA, released to recipient.',
          stepType: 'PA_RELEASE',
          recordsCopies: { create: { status: 'PENDING_FILING' } },
        },
        include: { recordsCopies: true },
      })
    })

    await logAudit({
      userId: req.user.id,
      action: 'PA_TRIAGED_DOCUMENT',
      module: 'Circulation',
      description: `Released "${existingCirculation.title}" to ${declaredRole}${trimmedNote ? ` — Note: ${trimmedNote}` : ''}`,
      ipAddress: req.ip,
    })

    return res.status(201).json({ success: true, step })
  } catch (error) {
    console.error('Error releasing circulation:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// GET /api/circulation/:id/verify-integrity — recompute each signature's hash
// from its own stored fields and check the previousHash chain links up
// correctly, step by step. This is a read-only integrity check (nothing is
// written) — it's what the Signatures tab's "Verify Integrity" button calls.
router.get('/:id/verify-integrity', async (req, res) => {
  try {
    const { id } = req.params
    const circulation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: { signature: true },
        },
      },
    })
    if (!circulation) {
      return res.status(404).json({ success: false, message: 'Circulation not found' })
    }

    const results = []
    let expectedPreviousHash = null
    let chainValid = true

    for (const step of circulation.steps) {
      const sig = step.signature
      if (!sig) continue // unsigned steps (plain routing, no signature) aren't part of the hash chain

      const recomputedHash = crypto
        .createHash('sha256')
        .update(`${sig.signerId}:${sig.decision}:${new Date(sig.signedAt).toISOString()}:${sig.previousHash || ''}`)
        .digest('hex')

      const hashMatches = recomputedHash === sig.signatureHash
      const chainLinkValid = (sig.previousHash || null) === expectedPreviousHash
      const valid = hashMatches && chainLinkValid
      if (!valid) chainValid = false

      results.push({
        stepId: step.id,
        stepNumber: step.stepNumber,
        signatureId: sig.id,
        hashMatches,
        chainLinkValid,
        valid,
      })

      expectedPreviousHash = sig.signatureHash
    }

    return res.json({
      success: true,
      chainValid,
      signatureCount: results.length,
      signatures: results,
    })
  } catch (error) {
    console.error('Error verifying circulation integrity:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// POST /api/circulation/:id/attachments — attach a supporting document to an
// in-progress circulation. Current holder only, same check as adding a step
// — it's still "their turn" with the file. The upload becomes a real
// Document (status SUBMITTED, not PRIVATE — it's entering a formal chain,
// not someone's personal staging area) and is bridged into the Records
// registry the same way documents.routes.js POST /:id/submit bridges a
// document at submit time, since creating it here skips that endpoint
// entirely.
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params
    const { note } = req.body
    const file = req.file
    if (!file) return res.status(400).json({ success: false, message: 'File is required' })

    const circulation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepNumber: 'desc' }, take: 1 } },
    })
    if (!circulation) return res.status(404).json({ success: false, message: 'Circulation not found' })
    if (req.user.role !== circulation.currentHolderRole) {
      return res.status(403).json({ success: false, message: 'You are not the current holder of this document' })
    }

    const latestStepId = circulation.steps[0]?.id || null

    const attachment = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          title: file.originalname,
          category: 'OTHER',
          department: req.user.department,
          filePath: file.originalname,
          mimeType: file.mimetype,
          fileData: file.buffer,
          fileSize: file.size,
          uploadedBy: req.user.id,
          status: 'SUBMITTED',
          isEditable: false,
        },
        select: { id: true, title: true, mimeType: true, fileSize: true, createdAt: true },
      })

      const registryNo = await generateRegistryNo()
      await tx.registryEntry.create({
        data: {
          registryNo,
          subject: `Attachment: ${file.originalname}`,
          docType: 'OTHER',
          direction: 'INTERNAL',
          source: req.user.name,
          destination: String(circulation.currentHolderRole).replace(/_/g, ' '),
          handledById: req.user.id,
          medium: 'EMAIL',
          status: 'PENDING',
          confidentiality: 'INTERNAL',
          dateRegistered: new Date(),
          sourceDocumentId: document.id,
        },
      })

      return tx.circulationAttachment.create({
        data: {
          circulationId: id,
          circulationStepId: latestStepId,
          documentId: document.id,
          attachedById: req.user.id,
          note: note ? String(note).trim() : null,
        },
        include: {
          document: { select: { id: true, title: true, mimeType: true, fileSize: true, createdAt: true } },
          attachedBy: { select: { id: true, name: true, role: true } },
        },
      })
    })

    await logAudit({
      userId: req.user.id,
      action: 'DOCUMENT_UPLOAD',
      module: 'Circulation',
      description: `Attached "${file.originalname}" to circulation "${circulation.title}"`,
      ipAddress: req.ip,
    })

    return res.status(201).json({ success: true, attachment })
  } catch (error) {
    console.error('Error attaching document to circulation:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// GET /api/circulation/:id/attachments
router.get('/:id/attachments', async (req, res) => {
  try {
    const { id } = req.params
    const attachments = await prisma.circulationAttachment.findMany({
      where: { circulationId: id },
      include: {
        document: { select: { id: true, title: true, mimeType: true, fileSize: true, createdAt: true } },
        attachedBy: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return res.json({ success: true, attachments })
  } catch (error) {
    console.error('Error fetching circulation attachments:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// GET /api/circulation/pa-gateway — PA's actual job description: everything
// currently gatekept through them, split by direction. "toGM" is things
// waiting to reach the GM; "fromGM" is things the GM sent that haven't
// actually left PA's hands yet. Deliberately excludes items genuinely
// addressed TO the PA herself (toRole === GM_PERSONAL_ASSISTANT) — those are
// PA's own direct correspondence, not something she's gatekeeping, even
// though they also carry currentHolderRole === GM_PERSONAL_ASSISTANT.
router.get('/pa-gateway', authorize(['GM_PERSONAL_ASSISTANT']), async (req, res) => {
  try {
    const gatekept = await prisma.documentCirculation.findMany({
      where: { currentHolderRole: 'GM_PERSONAL_ASSISTANT', status: 'IN_CIRCULATION' },
      include: {
        originator: { select: { id: true, name: true, email: true } },
        // Full trail, ascending — steps[0] is the true originating step
        // (needed for "Return for Correction" to route back to whoever
        // actually started this, not to the GM/PA the gate sits between),
        // the last entry is the latest/declared-destination step.
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: { fromUser: { select: { id: true, name: true } } },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    const toGM = []
    const fromGM = []
    for (const c of gatekept) {
      const latest = c.steps[c.steps.length - 1]
      if (!latest || latest.toRole === 'GM_PERSONAL_ASSISTANT') continue
      if (latest.toRole === 'GENERAL_MANAGER') toGM.push(c)
      else if (latest.fromRole === 'GENERAL_MANAGER') fromGM.push(c)
    }

    return res.json({ success: true, toGM, fromGM })
  } catch (error) {
    console.error('Error fetching PA gateway:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// GET /api/circulation/inbox - Get documents currently with the user's role
router.get('/inbox', async (req, res) => {
  try {
    const circulations = await prisma.documentCirculation.findMany({
      where: {
        currentHolderRole: req.user.role,
        status: 'IN_CIRCULATION'
      },
      include: {
        originator: { select: { id: true, name: true, email: true } }
      },
      orderBy: { updatedAt: 'desc' }
    })
    return res.json({ success: true, circulations })
  } catch (error) {
    console.error('Error fetching circulation inbox:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

// GET /api/circulation/:id - Get full timeline of a circulation
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const circulation = await prisma.documentCirculation.findUnique({
      where: { id },
      include: {
        originator: { select: { id: true, name: true, email: true } },
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            fromUser: { select: { id: true, name: true, email: true } },
            recordsCopies: true
          }
        }
      }
    })

    if (!circulation) {
      return res.status(404).json({ success: false, message: 'Circulation not found' })
    }

    return res.json({ success: true, circulation })
  } catch (error) {
    console.error('Error fetching circulation timeline:', error)
    return res.status(500).json({ success: false, message: 'Internal server error' })
  }
})

export default router
