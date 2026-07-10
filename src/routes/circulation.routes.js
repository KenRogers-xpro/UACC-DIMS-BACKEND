import express from 'express'
import { authenticate } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'

const router = express.Router()

router.use(authenticate)

// POST /api/circulation - Initialize a new document circulation
router.post('/', async (req, res) => {
  try {
    const { title, sourceType, sourceId, toRole, instruction } = req.body
    const originatorId = req.user.id

    const circulation = await prisma.$transaction(async (tx) => {
      return await tx.documentCirculation.create({
        data: {
          title,
          sourceType,
          sourceId,
          originatorId,
          currentHolderRole: toRole,
          status: 'IN_CIRCULATION',
          steps: {
            create: {
              stepNumber: 1,
              fromUserId: originatorId,
              fromRole: req.user.role,
              toRole,
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
    const { toRole, instruction, stepType, decision, amount } = req.body

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

    const step = await prisma.$transaction(async (tx) => {
      // 1. Update Circulation
      await tx.documentCirculation.update({
        where: { id },
        data: {
          currentHolderRole: toRole,
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
