#!/usr/bin/env node
/**
 * build.js - Render build script
 * Runs prisma migrate deploy to apply all pending migrations.
 *
 * This used to unconditionally force-mark 20260711092026_consolidated_
 * schema_update as rolled-back before every single deploy — a one-time
 * recovery step from when that migration originally failed, left in as a
 * permanent build step instead of being run once and removed. Since that
 * migration's SQL is fully idempotent (every statement uses IF NOT EXISTS),
 * this "worked" for months by silently re-toggling its ledger status on
 * every build. But it meant the ledger was never actually stable, and it's
 * the direct cause of the 2026-07-22 deploy failure: a later migration
 * (20260722120000_add_body_extraction_to_embeddings) got caught in the same
 * forced-replay cycle without being written idempotently itself, and broke
 * the moment its ADD COLUMN ran against a column that already existed.
 * Removed now that 20260711092026 has had a full, clean, final replay (this
 * script's last run before this edit) — plain `migrate deploy` records it as
 * applied and leaves it alone from here on, like every other migration.
 */
import { execSync } from 'child_process'

function run(cmd) {
  console.log(`\n> ${cmd}`)
  try {
    execSync(cmd, { stdio: 'inherit' })
  } catch (err) {
    process.exit(1)
  }
}

console.log('=== Running prisma migrate deploy ===')
run('npx prisma migrate deploy')

console.log('\n=== Build complete ===')
