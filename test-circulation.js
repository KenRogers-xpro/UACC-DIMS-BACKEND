import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('--- Simulating Document Circulation ---\n')

  // 1. Get some users from the DB to act as the different roles
  const gm = await prisma.user.findFirst({ where: { role: 'GENERAL_MANAGER' } })
  const pa = await prisma.user.findFirst({ where: { role: 'GM_PERSONAL_ASSISTANT' } })
  const hr = await prisma.user.findFirst({ where: { role: 'HR_MANAGER' } })

  if (!gm || !pa || !hr) {
    console.error('Could not find required users (GM, PA, HR). Please ensure the DB is seeded.')
    return
  }

  // 2. Initiate Circulation (e.g., HR Manager initiates a memo)
  console.log('1. HR Manager initiates circulation...')
  const circulation = await prisma.$transaction(async (tx) => {
    const circ = await tx.documentCirculation.create({
      data: {
        title: 'New Employee Onboarding Policy',
        sourceType: 'STANDALONE_MEMO',
        sourceId: null,
        originatorId: hr.id,
        currentHolderRole: 'GM_PERSONAL_ASSISTANT', // Routing to PA first
        steps: {
          create: {
            stepNumber: 1,
            fromUserId: hr.id,
            fromRole: 'HR_MANAGER',
            toRole: 'GM_PERSONAL_ASSISTANT',
            instruction: 'Please review and forward to GM for approval.',
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
          include: { recordsCopies: true }
        }
      }
    })
    return circ
  })
  console.log('   Created Circulation ID:', circulation.id)

  // 3. PA forwards to GM
  console.log('\n2. PA reviews and forwards to GM...')
  const paStep = await prisma.$transaction(async (tx) => {
    await tx.documentCirculation.update({
      where: { id: circulation.id },
      data: { currentHolderRole: 'GENERAL_MANAGER' }
    })
    const step = await tx.circulationStep.create({
      data: {
        circulationId: circulation.id,
        stepNumber: 2,
        fromUserId: pa.id,
        fromRole: 'GM_PERSONAL_ASSISTANT',
        toRole: 'GENERAL_MANAGER',
        instruction: 'Checked formatting. Ready for your review.',
        stepType: 'FORWARD',
        recordsCopies: {
          create: { status: 'PENDING_FILING' }
        }
      },
      include: { recordsCopies: true }
    })
    return step
  })

  // 4. GM makes a final decision
  console.log('\n3. GM makes a final decision...')
  const gmStep = await prisma.$transaction(async (tx) => {
    await tx.documentCirculation.update({
      where: { id: circulation.id },
      data: { currentHolderRole: 'GENERAL_MANAGER', status: 'CLOSED' } 
    })
    const step = await tx.circulationStep.create({
      data: {
        circulationId: circulation.id,
        stepNumber: 3,
        fromUserId: gm.id,
        fromRole: 'GENERAL_MANAGER',
        toRole: 'HR_MANAGER', // Routing back
        instruction: 'Approved. Proceed with implementation.',
        stepType: 'FINAL_DECISION',
        decision: 'APPROVED',
        recordsCopies: {
          create: { status: 'PENDING_FILING' }
        }
      },
      include: { recordsCopies: true }
    })
    return step
  })

  // 5. Fetch and display the full timeline from DB
  console.log('\n--- Final Database State ---')
  const finalCirculation = await prisma.documentCirculation.findUnique({
    where: { id: circulation.id },
    include: {
      originator: { select: { name: true, role: true } },
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: {
          fromUser: { select: { name: true } },
          recordsCopies: true
        }
      }
    }
  })

  console.dir(finalCirculation, { depth: null, colors: true })
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect()
  })
