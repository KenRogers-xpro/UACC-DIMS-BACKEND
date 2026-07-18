// Mirrors schema.prisma's Role enum. Role columns are plain String (not the
// Prisma enum type) throughout this codebase, so anything accepting a role
// list from a request body (ccRoles, etc.) must validate against this by
// hand rather than relying on the database to reject bad values.
export const VALID_ROLES = [
  'GENERAL_MANAGER',
  'GM_PERSONAL_ASSISTANT',
  'DEPARTMENT_HEAD',
  'STAFF',
  'IT_ADMINISTRATOR',
  'INTERNAL_AUDITOR',
  'RECORDS_EXECUTIVE',
  'PROCUREMENT_OFFICER',
  'HR_MANAGER',
  'FINANCE_DIRECTOR',
  'MARKETING_OFFICER',
  'CORPORATION_SECRETARY',
]

// Normalizes a request-body ccRoles value into a deduped array of valid role
// strings, or throws with a message naming the first bad entry. Silently
// dropping unrecognized roles would let a typo'd role look like it worked.
export function validateCcRoles(ccRoles) {
  if (ccRoles === undefined || ccRoles === null) return []
  if (!Array.isArray(ccRoles)) throw new Error('ccRoles must be an array of role strings')

  const seen = new Set()
  for (const role of ccRoles) {
    if (!VALID_ROLES.includes(role)) throw new Error(`Invalid ccRoles entry: "${role}"`)
    seen.add(role)
  }
  return [...seen]
}

// GM gatekeeping: any step where the General Manager is either party gets
// intercepted by the GM Personal Assistant — inbound (X -> GM) or outbound
// (GM -> X) — so heldByRole (who must actually act) diverges from toRole
// (who it's declared for). The one exception is the direct GM<->PA channel
// itself: gatekeeping happens THROUGH that channel, so it can't gatekeep
// itself, or nothing would ever reach the PA to release in the first place.
export function resolveHeldByRole(fromRole, toRole) {
  const GM = 'GENERAL_MANAGER'
  const PA = 'GM_PERSONAL_ASSISTANT'
  const involvesGM = fromRole === GM || toRole === GM
  const isDirectGmPaChannel =
    (fromRole === GM && toRole === PA) || (fromRole === PA && toRole === GM)
  if (involvesGM && !isDirectGmPaChannel) return PA
  return toRole
}
