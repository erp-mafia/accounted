import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import type { ScbFact } from '@/lib/parties/scb/map'
import { createLogger } from '@/lib/logger'

const log = createLogger('company.registered-office')

/**
 * A company's säte (registered office) from the register: SCB's
 * Säteskommun, the municipality the company is registered in. This is the
 * only source company creation fills `company_settings.registered_office`
 * from. The postal town of the registered address (TIC
 * mostRecentRegisteredAddress, SCB PostOrt) is `city` and is never used as
 * säte: the two differ whenever the post goes to another town than the
 * municipality of the seat.
 */

/** SCB answers a lookup in well under a second; company creation never waits longer than this for it. */
export const REGISTERED_OFFICE_LOOKUP_DEADLINE_MS = 5_000

/** The säte municipality in SCB's facts, or null when SCB gave none. */
export function registeredOfficeFromScbFacts(facts: readonly ScbFact[]): string | null {
  const seat = facts.find((f) => f.field === 'seat')?.value as { municipality?: unknown } | undefined
  const municipality = typeof seat?.municipality === 'string' ? seat.municipality.trim() : ''
  return municipality || null
}

/**
 * Best effort: null when SCB is not configured here, the number is a
 * personnummer (an enskild firma has no säte, and SCB lists only juridiska
 * personer), SCB has no row or no seat for it, or the call failed or ran
 * past the deadline. A company is created without a säte rather than
 * delayed or refused; the annual report then asks for it.
 */
export async function registeredOfficeFromRegistry(
  orgNumber: string | null | undefined,
  opts: { deadlineMs?: number } = {},
): Promise<string | null> {
  if (!orgNumber || !isLegalPersonOrgNumber(orgNumber) || !isScbConfigured()) return null
  const deadlineMs = opts.deadlineMs ?? REGISTERED_OFFICE_LOOKUP_DEADLINE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  const lookup = (async () => {
    // Dynamic: the SCB transport reaches node:https, and this module sits in
    // the import closure of a server action file that client components
    // import (client-node-builtin guard).
    const { createScbClient } = await import('@/lib/parties/scb/client')
    const result = await createScbClient({ ...scbConfigFromEnv(), timeoutMs: deadlineMs }).lookupByOrgNumber(orgNumber)
    return result.found ? registeredOfficeFromScbFacts(result.facts) : null
  })().catch((err: unknown) => {
    log.warn('scb lookup failed', { message: err instanceof Error ? err.message : String(err) })
    return null
  })
  try {
    return await Promise.race([lookup, deadline])
  } finally {
    clearTimeout(timer)
  }
}
