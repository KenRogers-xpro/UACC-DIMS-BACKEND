import { defineConfig } from '@prisma/config'
import * as dotenv from 'dotenv'

dotenv.config()

export default defineConfig({
  earlyAccess: true,
  experimental: {
    studio: true,
  },
  migrate: {
    url: process.env.DATABASE_URL,
  },
  studio: {
    url: process.env.DATABASE_URL,
  }
})
