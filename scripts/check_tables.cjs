const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    await prisma.recordsFile.findFirst();
    console.log('RecordsFile exists');
  } catch (e) {
    console.error('RecordsFile error:', e.message);
  }
  
  try {
    await prisma.digitalSignature.findFirst();
    console.log('DigitalSignature exists');
  } catch (e) {
    console.error('DigitalSignature error:', e.message);
  }
}

main().finally(() => prisma.$disconnect());
