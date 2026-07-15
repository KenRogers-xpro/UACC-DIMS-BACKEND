import bcrypt from 'bcryptjs'
import { prisma } from './prisma.js'

// SIGNING_PIN_REQUIRED defaults to true (the safe default) — only an
// explicit "false" turns off PIN verification, for demo/staging use where
// setting up a PIN for every test account is friction, not security.
export function isPinRequired() {
  return process.env.SIGNING_PIN_REQUIRED !== 'false'
}

// Verifies a signing PIN against the given user's stored hash. Returns a
// result object rather than throwing, since callers need to distinguish
// "no PIN set yet" from "wrong PIN" for different UI treatment (redirect to
// PIN setup vs. shake-and-retry).
export async function verifySigningPin(userId, pin) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { signingPinHash: true } })
  if (!user?.signingPinHash) {
    return { ok: false, code: 'NO_PIN_SET', message: 'You need to set a signing PIN before you can sign.' }
  }
  const matches = await bcrypt.compare(String(pin || ''), user.signingPinHash)
  if (!matches) {
    return { ok: false, code: 'INCORRECT_PIN', message: 'Incorrect PIN' }
  }
  return { ok: true }
}
