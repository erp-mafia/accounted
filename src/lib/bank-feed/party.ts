/**
 * Whose accounts, at which bank, and who is present: the AisParty every
 * Connect AIS call carries (forwarded to the provider as PSU headers, never
 * stored by the service).
 *
 *   - orgNumber: the company's organisationsnummer, digits only.
 *   - accountContext: 'corporate' for every company but an enskild firma,
 *     whose bank agreement is the owner's private one ('private'). The
 *     context chosen at connect time is kept on bank_connections.psu_type
 *     ('business' | 'personal') so every later read uses the same one.
 *   - personalNumber: the PSU-ID the provider wants on every request
 *     ("Always include PSU-ID in all requests to ensure proper consent
 *     tracking per user", dev_docs/open-payments/consent_and_ais.md). A call
 *     to a connection's existing consent sends the number the consent was
 *     created with (bank_connection_psus, lib/auth/resource-psu.ts): several
 *     banks require that same PSU-ID on every later call to it. Otherwise,
 *     and when none is stored or it cannot be read, the number the person
 *     typed, else the one on file for the user the call acts for (their
 *     BankID login or the remembered number, lib/auth/bankid-signer.ts); the
 *     connection's owner on an unattended read. A co-signer's own
 *     authorisation on a partly signed consent carries the co-signer's
 *     number, never the stored one. Null only when nothing is known.
 *   - psuIpAddress / psuUserAgent: set when a person asked (the bank does not
 *     count the read against the consent's unattended budget); null on the
 *     cron.
 *   - affiliatedAspspId: the sparbank behind a shared BIC, when the
 *     connection has one.
 */

import type { AisParty } from '@accounted/connect-contract'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSignerPersonalNumber, signerPersonalNumberOnFile } from '@/lib/auth/bankid-signer'
import { storedConnectionPsu, type ConnectionPsuSource } from '@/lib/auth/resource-psu'
import type { OperationOutcome } from '@/lib/operations/types'

export interface BankFeedSignerInput {
  /** Typed in the dialog; used when the person has no personnummer on file. */
  personalNumber: string | null
  ipAddress: string | null
  userAgent: string | null
  /**
   * Whether the number on file for the context's user may stand in when none
   * was typed. True (the default) for a session: the person acts for
   * themselves. False on the signatory link (lib/bank-feed/invite-route.ts):
   * the context's user is the sender, and their number must never name the
   * firmatecknare's BankID; without a typed number the party carries none.
   */
  lookupOnFile?: boolean
}

/** No person present: the cron and the balance refresh after an unattended read. */
export const UNATTENDED_SIGNER: BankFeedSignerInput = { personalNumber: null, ipAddress: null, userAgent: null }

export type PsuType = 'business' | 'personal'

export function accountContextOf(psuType: string | null | undefined): AisParty['accountContext'] {
  return psuType === 'personal' ? 'private' : 'corporate'
}

export function psuTypeOf(accountContext: AisParty['accountContext']): PsuType {
  return accountContext === 'private' ? 'personal' : 'business'
}

/** The company's organisationsnummer as the contract wants it (10 digits), or null when the company has none. */
export async function companyOrgNumber(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { data: settings } = await supabase.from('company_settings').select('org_number').eq('company_id', companyId).maybeSingle()
  let raw = (settings as { org_number?: string | null } | null)?.org_number ?? null
  if (!raw) {
    const { data: company } = await supabase.from('companies').select('org_number').eq('id', companyId).maybeSingle()
    raw = (company as { org_number?: string | null } | null)?.org_number ?? null
  }
  if (!raw) return null
  // A 12-digit form (16XXXXXXXXXX) drops the century prefix.
  const digits = raw.replace(/\D/g, '')
  const ten = digits.length === 12 && digits.startsWith('16') ? digits.slice(2) : digits
  return /^\d{10}$/.test(ten) ? ten : null
}

export interface PartyInput {
  companyId: string
  bic: string
  affiliatedAspspId: string | null
  psuType: string | null
  signer: BankFeedSignerInput
  /** Whose personnummer on file stands in when none was typed: the signed-in person, or the connection's owner on an unattended read. */
  userId?: string
  /** A BankID start cannot do without one: refuse instead of sending nothing. */
  requireSigner?: boolean
  /** The connection whose existing consent the call reaches: the PSU-ID the consent was created with leads. */
  connectionId?: string | null
  /**
   * A co-signer's own authorisation on a partly signed consent (the second
   * firmatecknare): the bank waits for the present person's BankID, so their
   * number goes, never the one the consent was created with.
   */
  coSigner?: boolean
}

export type PartyResult =
  | {
      ok: true
      party: AisParty
      /** Where party.personalNumber came from; what a new consent created with it stores. Null when the party carries none. */
      source: ConnectionPsuSource | null
    }
  | { ok: false; outcome: Extract<OperationOutcome<never>, { ok: false }> }

export async function buildBankFeedParty(supabase: SupabaseClient, input: PartyInput): Promise<PartyResult> {
  const orgNumber = await companyOrgNumber(supabase, input.companyId)
  if (!orgNumber) return { ok: false, outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'org_number', reason: 'missing' } } }
  const typed = normalizeSignerPersonalNumber(input.signer.personalNumber)
  if (input.signer.personalNumber && !typed) {
    return { ok: false, outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED', details: { reason: 'invalid' } } }
  }
  const stored = input.connectionId && !input.coSigner ? await storedConnectionPsu(input.connectionId) : null
  const onFile = !stored && !typed && input.userId && input.signer.lookupOnFile !== false ? await signerPersonalNumberOnFile(input.userId) : null
  const personalNumber = stored?.personalNumber ?? typed ?? onFile
  if (input.requireSigner && !personalNumber) return { ok: false, outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED' } }
  const source: ConnectionPsuSource | null = stored
    ? stored.source
    : typed
      ? input.signer.lookupOnFile === false ? 'signatory_link' : 'typed'
      : onFile ? 'on_file' : null
  return {
    ok: true,
    source,
    party: {
      orgNumber,
      accountContext: accountContextOf(input.psuType),
      bic: input.bic,
      personalNumber,
      psuIpAddress: input.signer.ipAddress,
      psuUserAgent: input.signer.userAgent ? input.signer.userAgent.slice(0, 300) : null,
      affiliatedAspspId: input.affiliatedAspspId ?? null,
    },
  }
}
