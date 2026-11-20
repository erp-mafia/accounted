/**
 * What a signing request is about, beyond its PDF. A plain request signs the
 * document and nothing else. A request over a locked årsredovisning version
 * (annual_report_version_id) also binds the version's content hash, says in
 * the BankID app what the board member signs (the fiscal year and their
 * role), requires the signer's BankID name to match the slot, and needs the
 * version to still wait for signatures: record_signing_signature re-checks
 * that under lock, this is the early answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SigningRequestRow, SigningSignerRow } from './types'

export interface SigningSubject {
  /** The årsredovisning version's content hash, carried in userNonVisibleData. */
  contentHash?: string
  /** The fiscal year an årsredovisning covers, for the BankID statement. */
  periodStart?: string
  periodEnd?: string
}

export type SubjectResult = { ok: true; subject: SigningSubject } | { ok: false; code: 'SIGNING_SUBJECT_CHANGED' }

export async function subjectForSigning(service: SupabaseClient, request: SigningRequestRow): Promise<SubjectResult> {
  if (!request.annual_report_version_id) return { ok: true, subject: {} }
  const { data, error } = await service
    .from('annual_report_versions')
    .select('status, content_hash, fiscal_period_id')
    .eq('company_id', request.company_id)
    .eq('id', request.annual_report_version_id)
    .maybeSingle()
  if (error) throw error
  const version = data as { status: string; content_hash: string; fiscal_period_id: string } | null
  if (!version || version.status !== 'ready_for_signature') return { ok: false, code: 'SIGNING_SUBJECT_CHANGED' }
  const { data: period } = await service
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('company_id', request.company_id)
    .eq('id', version.fiscal_period_id)
    .maybeSingle()
  const p = period as { period_start: string; period_end: string } | null
  return {
    ok: true,
    subject: { contentHash: version.content_hash, ...(p ? { periodStart: p.period_start, periodEnd: p.period_end } : {}) },
  }
}

/** The BankID statement of a board member signing the årsredovisning, or undefined for a plain request. */
export function subjectStatement(subject: SigningSubject, signer: Pick<SigningSignerRow, 'role_label'>, companyName: string): string | undefined {
  if (!subject.contentHash) return undefined
  const year = subject.periodStart && subject.periodEnd ? ` för räkenskapsåret ${subject.periodStart} till ${subject.periodEnd}` : ''
  const role = signer.role_label ? ` som ${signer.role_label.toLocaleLowerCase('sv-SE')}` : ''
  return `Jag skriver under årsredovisningen för ${companyName}${year}${role}.`
}

function tokens(value: string): string[] {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('sv-SE')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Whether the BankID name is the slot's name, the way the iXBRL splits it
 * (version-ixbrl.ts: the last word is the efternamn, the first the
 * tilltalsnamn): the slot's surname is one of the BankID surnames and its
 * first name one of the BankID given names, case-insensitive. Bolagsverket
 * checks the names against the register (kontrollkod 1171), so a slot that
 * does not match the signer's BankID would fail at filing.
 */
export function bankIdNameMatchesSlot(slotName: string, givenName: string, surname: string): boolean {
  const slot = tokens(slotName)
  if (slot.length < 2) return false
  const given = new Set(tokens(givenName))
  const sur = new Set(tokens(surname))
  return sur.has(slot[slot.length - 1]!) && given.has(slot[0]!)
}
