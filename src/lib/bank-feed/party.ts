/**
 * Whose accounts, at which bank, and who is present: the AisParty every
 * Connect AIS call carries (forwarded to the provider as PSU headers, never
 * stored by the service).
 *
 *   - orgNumber: the company's organisationsnummer, 10 digits
 *     (lib/company/org-number.ts): an enskild firma's is the owner's
 *     personnummer without its century.
 *   - accountContext: 'corporate' for every company but an enskild firma,
 *     whose bank agreement is the owner's private one ('private'). The
 *     context chosen at connect time is kept on bank_connections.psu_type
 *     ('business' | 'personal') so every later read uses the same one.
 *   - personalNumber: the PSU-ID the provider wants on every request
 *     ("Always include PSU-ID in all requests to ensure proper consent
 *     tracking per user"). A call
 *     to a connection's existing consent sends the number the consent was
 *     created with (bank_connection_psus, lib/auth/resource-psu.ts): several
 *     banks require that same PSU-ID on every later call to it. Otherwise,
 *     and when none is stored or it cannot be read, the number the person
 *     typed, else for an enskild firma's private account its owner's
 *     personnummer (the organisationsnummer), else the one on file for the
 *     user the call acts for (their
 *     BankID login or the remembered number, lib/auth/bankid-signer.ts); the
 *     connection's owner on an unattended read. A co-signer's own
 *     authorisation on a partly signed consent carries the co-signer's
 *     number, never the stored one. Null only when nothing is known.
 *   - psuIpAddress / psuUserAgent: set when a person asked (the bank does not
 *     count the read against the consent's unattended budget); null on the
 *     cron.
 *   - affiliatedAspspId: the sparbank behind a shared BIC, when the
 *     connection has one.
 *   - psuAuthoriserId: the logon id the person typed for Nordea Corporate
 *     Netbank (./psu-authoriser.ts), for a Nordea consent only; Connect puts
 *     it on the authorisation calls alone. Never stored.
 */

import type { AisParty } from '@accounted/connect-contract'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSignerPersonalNumber, signerPersonalNumberOnFile } from '@/lib/auth/bankid-signer'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { companyOrgNumber } from '@/lib/company/org-number'
import { storedConnectionPsu, type ConnectionPsuSource } from '@/lib/auth/resource-psu'
import type { OperationOutcome } from '@/lib/operations/types'
import { psuAuthoriserIdFor } from './psu-authoriser'

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
  /** Typed in the dialog for Nordea Corporate Netbank; sent with a Nordea consent's signing only, never stored. */
  psuAuthoriserId?: string | null
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

/**
 * The holder of a private-account consent when the company's
 * organisationsnummer is its owner's personnummer (an enskild firma): that
 * personnummer, 12 digits. The bank waits for the holder's BankID, and the
 * person starting the connection may be someone else (a consultant at a
 * byrå), whose own number would name the wrong BankID (crm#1298). Null for a
 * corporate agreement and every other form.
 */
async function privateAccountHolder(supabase: SupabaseClient, companyId: string, orgNumber: string, accountContext: AisParty['accountContext']): Promise<string | null> {
  if (accountContext !== 'private') return null
  const { data } = await supabase.from('companies').select('entity_type').eq('id', companyId).maybeSingle()
  const entityType = (data as { entity_type?: unknown } | null)?.entity_type
  if (!isEntityType(entityType) || !usesPersonnummerAsOrgNumber(entityType)) return null
  return normalizeSignerPersonalNumber(orgNumber)
}

export async function buildBankFeedParty(supabase: SupabaseClient, input: PartyInput): Promise<PartyResult> {
  const orgNumber = await companyOrgNumber(supabase, input.companyId)
  if (!orgNumber) return { ok: false, outcome: { ok: false, code: 'BANK_CONSENT_ORG_NUMBER_MISSING', details: { field: 'org_number', reason: 'missing' } } }
  const typed = normalizeSignerPersonalNumber(input.signer.personalNumber)
  if (input.signer.personalNumber && !typed) {
    return { ok: false, outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED', details: { reason: 'invalid' } } }
  }
  const accountContext = accountContextOf(input.psuType)
  const stored = input.connectionId && !input.coSigner ? await storedConnectionPsu(input.connectionId) : null
  const holder = !stored && !typed && !input.coSigner ? await privateAccountHolder(supabase, input.companyId, orgNumber, accountContext) : null
  const onFile = !stored && !typed && !holder && input.userId && input.signer.lookupOnFile !== false ? await signerPersonalNumberOnFile(input.userId) : null
  const personalNumber = stored?.personalNumber ?? typed ?? holder ?? onFile
  if (input.requireSigner && !personalNumber) return { ok: false, outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED' } }
  const source: ConnectionPsuSource | null = stored
    ? stored.source
    : typed
      ? input.signer.lookupOnFile === false ? 'signatory_link' : 'typed'
      : holder || onFile ? 'on_file' : null
  const authoriser = psuAuthoriserIdFor(input.bic, input.signer.psuAuthoriserId)
  if (!authoriser.ok) return { ok: false, outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'psu_authoriser_id', reason: 'invalid' } } }
  return {
    ok: true,
    source,
    party: {
      orgNumber,
      accountContext,
      bic: input.bic,
      personalNumber,
      psuIpAddress: input.signer.ipAddress,
      psuUserAgent: input.signer.userAgent ? input.signer.userAgent.slice(0, 300) : null,
      affiliatedAspspId: input.affiliatedAspspId ?? null,
      ...(authoriser.value ? { psuAuthoriserId: authoriser.value } : {}),
    },
  }
}
