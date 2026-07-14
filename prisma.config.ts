import { defineConfig } from 'prisma/config'
import * as dotenv from 'dotenv'

// Load .env if present (local dev); in production DATABASE_URL is injected by Render
dotenv.config({ override: false })

const databaseUrl = process.env.DATABASE_URL

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // Only set migrate.url if DATABASE_URL is available (not required for `prisma generate`)
  ...(databaseUrl ? { migrate: { url: databaseUrl } } : {}),
})
