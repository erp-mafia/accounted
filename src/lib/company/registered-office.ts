import type { SupabaseClient } from '@supabase/supabase-js'
import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { isLegalPersonOrgNumber } from '@/lib/invariants/org-number'
import type { ScbFact } from '@/lib/parties/scb/map'
import { createLogger } from '@/lib/logger'

const log = createLogger('company.registered-office')

/**
 * A company's säte (registered office) from the register: SCB's
 * Säteskommun, the municipality the company is registered in. This is the
 * only source `company_settings.registered_office` is filled from without a
 * person typing it: at company creation, and by
 * fillRegisteredOfficeFromRegistry for a company that has none. The postal
 * town of the registered address (TIC mostRecentRegisteredAddress, SCB
 * PostOrt) is `city` and is never used as säte: the two differ whenever the
 * post goes to another town than the municipality of the seat.
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

/** What asking the register for a company's missing säte came to. */
export type RegisteredOfficeFill =
  /** The company already has a säte: nothing was asked and nothing written. */
  | { status: 'present'; registered_office: string }
  /** The register had one, and it is stored now. */
  | { status: 'filled'; registered_office: string }
  /** No säte to store: the company has no settings row, or the register gave none (registeredOfficeFromRegistry). */
  | { status: 'not_found' }
  /** The register had one, but no row changed: a säte arrived meanwhile, or the row is closed to this writer. */
  | { status: 'not_saved' }

/**
 * Fills an empty `company_settings.registered_office` from the register. A
 * company created before company creation asked the register has none, and
 * its annual report cannot be finalised without it.
 *
 * A stored säte is never replaced: the write is guarded on the empty value
 * that was read, so one typed in meanwhile stays, and a write that changed
 * no row answers `not_saved` instead of a fill that never happened. The
 * caller decides who may ask: company_settings is an owner's or admin's
 * table, and the route requires that role.
 */
export async function fillRegisteredOfficeFromRegistry(
  supabase: SupabaseClient,
  companyId: string,
  opts: { deadlineMs?: number } = {},
): Promise<RegisteredOfficeFill> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('registered_office, org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read the company's registered office: ${error.message}`)
  const settings = data as { registered_office: string | null; org_number: string | null } | null
  if (!settings) return { status: 'not_found' }

  const stored = settings.registered_office
  const present = typeof stored === 'string' ? stored.trim() : ''
  if (present) return { status: 'present', registered_office: present }

  const registeredOffice = await registeredOfficeFromRegistry(settings.org_number, opts)
  if (!registeredOffice) return { status: 'not_found' }

  const write = supabase
    .from('company_settings')
    .update({ registered_office: registeredOffice })
    .eq('company_id', companyId)
  // Blank is NULL or an empty or whitespace-only string: guard on the one that was read.
  const guarded = typeof stored === 'string' ? write.eq('registered_office', stored) : write.is('registered_office', null)
  const { data: written, error: writeError } = await guarded.select('registered_office')
  if (writeError) throw new Error(`Failed to store the registered office: ${writeError.message}`)
  if (!written || written.length === 0) return { status: 'not_saved' }
  return { status: 'filled', registered_office: registeredOffice }
}
