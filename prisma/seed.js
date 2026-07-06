import pkg from '@prisma/client'
const { PrismaClient } = pkg
import bcryptPkg from 'bcryptjs'
const bcrypt = bcryptPkg.default || bcryptPkg

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding UACC DIMS PostgreSQL database...\n')

  const password = await bcrypt.hash('dims2026', 12)

  const users = [
    { name: 'Lt. Gen. Nakibus Lakara', email: 'gm@uacc.go.ug',              role: 'GENERAL_MANAGER',   department: 'GENERAL_MANAGER_OFFICE'    },
    { name: 'Patrick Katusabe',        email: 'it@uacc.go.ug',              role: 'IT_ADMINISTRATOR',  department: 'FINANCE_AND_ADMINISTRATION' },
    { name: 'Head Engineering',        email: 'engineering.head@uacc.go.ug', role: 'DEPARTMENT_HEAD',  department: 'ENGINEERING'                },
    { name: 'Staff Operations',        email: 'staff@uacc.go.ug',           role: 'STAFF',             department: 'OPERATIONS'                 },
    { name: 'Internal Auditor',        email: 'auditor@uacc.go.ug',         role: 'AUDITOR',           department: 'FINANCE_AND_ADMINISTRATION' },
    { name: 'Records Executive',       email: 'records@uacc.go.ug',         role: 'RECORDS_EXECUTIVE', department: 'FINANCE_AND_ADMINISTRATION' },
    { name: 'Procurement Officer',     email: 'procurement.officer@uacc.go.ug', role: 'PROCUREMENT_OFFICER', department: 'FINANCE_AND_ADMINISTRATION' },
  ]

  for (const u of users) {
    const user = await prisma.user.upsert({
      where:  { email: u.email },
      update: {},
      create: { ...u, password },
    })
    console.log(`✓ ${user.role}: ${user.name}`)
  }

  console.log('\n✅ Database seeded successfully!')
  console.log('🔑 All accounts: password = dims2026\n')
}

main()
  .catch(e => { console.error('❌ Seed failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
