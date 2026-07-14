#!/usr/bin/env node
/**
 * build.js - Render build script
 * 1. Marks the consolidated schema migration as rolled-back if it failed
 * 2. Runs prisma migrate deploy to apply all pending migrations
 */
import { execSync } from 'child_process'

const FAILED_MIGRATION = '20260711092026_consolidated_schema_update'

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`)
  try {
    execSync(cmd, { stdio: 'inherit', ...opts })
  } catch (err) {
    if (opts.allowFailure) {
      console.log(`(non-fatal error, continuing...)`)
    } else {
      process.exit(1)
    }
  }
}

console.log('=== Resolving any failed migrations ===')
run(
  `npx prisma migrate resolve --rolled-back ${FAILED_MIGRATION}`,
  { allowFailure: true }
)

console.log('\n=== Running prisma migrate deploy ===')
run('npx prisma migrate deploy')

console.log('\n=== Build complete ===')
