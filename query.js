import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const msgs = await prisma.directMessage.findMany({ where: { OR: [{ senderId: 7 }, { recipientId: 7 }] } });
  console.log(JSON.stringify(msgs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
