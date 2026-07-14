import { prisma } from './prisma.js'

export async function generateRegistryNo() {
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
