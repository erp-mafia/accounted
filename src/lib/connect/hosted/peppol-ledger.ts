import type { SupabaseClient } from '@supabase/supabase-js'
import { isPeppolTransportError, type PeppolParticipant } from '@/lib/invoices/peppol-transport'
import { hashHandle } from './ledger'

/**
 * Peppol-specific reads over the connector ledger (hosted side).
 *
 * A Peppol "connection" is a receiving registration: one participant id
 * (scheme:identifier) published under Arcim's access point on behalf of one
 * company on one instance. The ledger row stores the participant id in
 * `account_uids` (it is public directory data, not a secret) so inbound
 * documents can be routed to the key that owns the recipient, and its sha256
 * in `handle_hash` so the partial unique index makes a participant claimable
 * by exactly one key at a time.
 *
 * Outbound submissions are tracked in `connector_peppol_submissions`: the
 * hosted Qvalia account is shared, so status polls and evidence reads must
 * prove the caller submitted the document.
 */

export function peppolHandle(participant: PeppolParticipant): string {
  return `${participant.scheme}:${participant.identifier.replace(/\s/g, '')}`
}

export function parsePeppolHandle(handle: string): PeppolParticipant | null {
  const colon = handle.indexOf(':')
  if (colon === -1) return null
  const scheme = handle.slice(0, colon)
  const identifier = handle.slice(colon + 1)
  // ISO 6523 ICD scheme: four digits (not a BAS account, hence no shared schema).
  if (scheme.length !== 4 || !/^\d+$/.test(scheme) || !identifier) return null
  return { scheme, identifier }
}

/**
 * Every participant this key currently holds an active registration for,
 * optionally narrowed to one company on the instance. Inbound routing is
 * key-wide (the instance's inbound sync lists for all its companies and
 * routes by its own registrations); everything else is company-bound.
 */
export async function listActivePeppolParticipants(
  supabase: SupabaseClient,
  keyId: string,
  companyRef?: string,
): Promise<PeppolParticipant[]> {
  let query = supabase
    .from('connector_connections')
    .select('account_uids')
    .eq('connector_key_id', keyId)
    .eq('service', 'peppol')
    .eq('status', 'active')
  if (companyRef) query = query.eq('company_ref', companyRef)
  const { data, error } = await query
  if (error) throw new Error(`ledger read failed: ${error.message}`)
  const participants: PeppolParticipant[] = []
  for (const row of (data ?? []) as Array<{ account_uids: string[] | null }>) {
    for (const uid of row.account_uids ?? []) {
      const parsed = parsePeppolHandle(uid)
      if (parsed) participants.push(parsed)
    }
  }
  return participants
}

/** Whether ANY key holds an active registration for this participant. */
export async function isPeppolParticipantHeld(supabase: SupabaseClient, handle: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('connector_connections')
    .select('id')
    .eq('service', 'peppol')
    .eq('status', 'active')
    .eq('handle_hash', hashHandle(handle))
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`ledger read failed: ${error.message}`)
  return !!data
}

/** Whether a HOSTED company holds a live registration for this participant at the provider. */
export async function isHostedPeppolParticipantLive(
  supabase: SupabaseClient,
  params: { provider: string; participant: PeppolParticipant },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('peppol_registrations')
    .select('id')
    .eq('provider', params.provider)
    .eq('participant_scheme', params.participant.scheme)
    .eq('participant_identifier', params.participant.identifier.replace(/\s/g, ''))
    .in('status', ['pending', 'registered'])
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`peppol registration read failed: ${error.message}`)
  return !!data
}

/** Same reservation window as countHeldConnections in ./ledger.ts. */
const PENDING_CAP_WINDOW_MS = 15 * 60 * 1000

/**
 * Connector-held registrations across every key, for the provider-account
 * cap: active rows plus fresh pending reservations, so two concurrent
 * registrations cannot both pass the cap check and both land.
 */
export async function countConnectorPeppolRegistrations(supabase: SupabaseClient, now: Date = new Date()): Promise<number> {
  const freshPendingSince = new Date(now.getTime() - PENDING_CAP_WINDOW_MS).toISOString()
  const [active, pending] = await Promise.all([
    supabase
      .from('connector_connections')
      .select('id', { count: 'exact', head: true })
      .eq('service', 'peppol')
      .eq('status', 'active'),
    supabase
      .from('connector_connections')
      .select('id', { count: 'exact', head: true })
      .eq('service', 'peppol')
      .eq('status', 'pending')
      .gte('created_at', freshPendingSince),
  ])
  if (active.error) throw new Error(`ledger count failed: ${active.error.message}`)
  if (pending.error) throw new Error(`ledger count failed: ${pending.error.message}`)
  return (active.count ?? 0) + (pending.count ?? 0)
}

/**
 * Participant identifiers a key may publish under Arcim's access point: the
 * allowlist Arcim recorded at issuance plus the licensee's own org number.
 * Whitespace is stripped the same way peppolHandle() does.
 */
export async function getPeppolAllowedIdentifiers(supabase: SupabaseClient, keyId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('connector_keys')
    .select('org_number, peppol_participants')
    .eq('id', keyId)
    .maybeSingle()
  if (error) throw new Error(`connector key read failed: ${error.message}`)
  const row = data as { org_number: string | null; peppol_participants: string[] | null } | null
  const allowed = new Set<string>()
  for (const value of [row?.org_number ?? '', ...(row?.peppol_participants ?? [])]) {
    const cleaned = value.replace(/\s/g, '')
    if (cleaned) allowed.add(cleaned)
  }
  return allowed
}

export async function recordPeppolSubmission(
  supabase: SupabaseClient,
  params: { keyId: string; companyRef: string; provider: string; providerSubmissionId: string; idempotencyKey: string },
): Promise<void> {
  const { error } = await supabase
    .from('connector_peppol_submissions')
    .upsert(
      {
        connector_key_id: params.keyId,
        company_ref: params.companyRef,
        provider: params.provider,
        provider_submission_id: params.providerSubmissionId,
        idempotency_key: params.idempotencyKey,
      },
      { onConflict: 'provider,provider_submission_id', ignoreDuplicates: true },
    )
  if (error) throw new Error(`submission record failed: ${error.message}`)
}

/** The submission row for (key, company, provider submission id): both the key and the company must match. */
export async function findOwnedPeppolSubmission(
  supabase: SupabaseClient,
  params: { keyId: string; companyRef: string; provider: string; providerSubmissionId: string },
): Promise<{ id: string; company_ref: string } | null> {
  const { data, error } = await supabase
    .from('connector_peppol_submissions')
    .select('id, company_ref')
    .eq('connector_key_id', params.keyId)
    .eq('company_ref', params.companyRef)
    .eq('provider', params.provider)
    .eq('provider_submission_id', params.providerSubmissionId)
    .maybeSingle()
  if (error) throw new Error(`submission read failed: ${error.message}`)
  return (data as { id: string; company_ref: string } | null) ?? null
}

export interface PeppolUpstreamFailure {
  /** Short, adapter-classified text (never a raw provider body). */
  text: string
  retryable: boolean
  /** Adapter detail, capped; the instance surfaces it as PeppolTransportError.detail. */
  hint: string | null
}

/**
 * Summarize a transport failure for the connector response. The Qvalia
 * adapter already classifies failures (network, auth, protocol, rejected,
 * duplicate) into its own message text; only that classified text and its
 * capped detail cross to the instance. Anything that is not a transport
 * error is a hosted bug and is not summarized here (the caller rethrows).
 */
export function describePeppolUpstreamFailure(err: unknown): PeppolUpstreamFailure | null {
  if (!isPeppolTransportError(err)) return null
  return {
    text: err.message.slice(0, 200),
    retryable: err.retryable,
    hint: err.detail ? err.detail.slice(0, 300) : null,
  }
}
