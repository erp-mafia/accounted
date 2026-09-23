import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidOrgNumber, normalizeOrgNumber } from '@/lib/documents/extract/fields'
import { ledgerKey } from '@/lib/parties/ledger-key'

/**
 * The other party of an agreement as a row in `parties`, reusing the party
 * suggestion RPC so a document-born party carries its facts and lands in
 * Motparter as a suggestion. A printed organisation number is a proven
 * identity; a name alone is a guess, and a name that fits several parties is
 * left alone rather than linked to the wrong one.
 */
export interface CounterpartyInput {
  companyId: string
  /** The person who brought the document; a created party is filed under them. */
  userId: string
  documentId: string
  name: string | null
  orgNumber: string | null
  /** Where the name or number stands in the document. */
  citation: { page: number | null; quote: string | null } | null
}

export type CounterpartyResolution =
  | { partyId: string; basis: 'proven' | 'guessed'; method: 'org_number' | 'name'; confidence: number; created: boolean }
  | { partyId: null; reason: 'no_identity' | 'ambiguous' }

interface PartyRow {
  id: string
}

export async function resolveCounterparty(supabase: SupabaseClient, input: CounterpartyInput): Promise<CounterpartyResolution> {
  const org = normalizeOrgNumber(input.orgNumber)
  const orgNumber = org && isValidOrgNumber(org) ? org : null
  const name = input.name?.trim() || null
  const key = name ? ledgerKey(name) : ''

  if (orgNumber) {
    const existing = await findByOrgNumber(supabase, input.companyId, orgNumber)
    if (existing) return { partyId: existing, basis: 'proven', method: 'org_number', confidence: 1, created: false }
    await suggestParty(supabase, input, { key: key || orgNumber, name, orgNumber })
    const created = await findByOrgNumber(supabase, input.companyId, orgNumber)
    if (created) return { partyId: created, basis: 'proven', method: 'org_number', confidence: 1, created: true }
  }

  if (!key || !name) return { partyId: null, reason: 'no_identity' }
  const byName = await findByName(supabase, input.companyId, key, name)
  if (byName.length > 1) return { partyId: null, reason: 'ambiguous' }
  if (byName.length === 1) return { partyId: byName[0], basis: 'guessed', method: 'name', confidence: 0.7, created: false }
  await suggestParty(supabase, input, { key, name, orgNumber: null })
  const created = await findByName(supabase, input.companyId, key, name)
  if (created.length === 1) return { partyId: created[0], basis: 'guessed', method: 'name', confidence: 0.6, created: true }
  return { partyId: null, reason: created.length ? 'ambiguous' : 'no_identity' }
}

async function findByOrgNumber(supabase: SupabaseClient, companyId: string, orgNumber: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('parties')
    .select('id')
    .eq('company_id', companyId)
    .eq('org_number', orgNumber)
    .is('merged_into', null)
    .maybeSingle()
  if (error) throw new Error(`party lookup failed: ${error.message}`)
  return (data as PartyRow | null)?.id ?? null
}

/** Live parties that carry the name as an alias key, or print it as their display or legal name. */
async function findByName(supabase: SupabaseClient, companyId: string, key: string, name: string): Promise<string[]> {
  const live = () => supabase.from('parties').select('id').eq('company_id', companyId).is('merged_into', null).is('archived_at', null).limit(5)
  const [byKey, byDisplay, byLegal] = await Promise.all([live().contains('alias_keys', [key]), live().ilike('display_name', name), live().ilike('legal_name', name)])
  for (const result of [byKey, byDisplay, byLegal]) if (result.error) throw new Error(`party lookup failed: ${result.error.message}`)
  const ids = [byKey, byDisplay, byLegal].flatMap((r) => ((r.data ?? []) as PartyRow[]).map((p) => p.id))
  return [...new Set(ids)]
}

async function suggestParty(supabase: SupabaseClient, input: CounterpartyInput, party: { key: string; name: string | null; orgNumber: string | null }): Promise<void> {
  const reference = { document_id: input.documentId, page: input.citation?.page ?? null, cited_text: input.citation?.quote ?? null }
  const facts = [
    ...(party.orgNumber ? [{ field: 'org_number', value: party.orgNumber, source: 'document', reference }] : []),
    ...(party.name ? [{ field: 'legal_name', value: party.name, source: 'document', reference }] : []),
  ]
  const item = {
    key: party.key,
    display_name: party.name ?? party.orgNumber,
    legal_name: party.name,
    kind: 'company',
    origin: 'document',
    org_number: party.orgNumber,
    alias_keys: [],
    facts,
    identities: [],
    reason: { source: 'arkiv', document_id: input.documentId },
  }
  const { error } = await supabase.rpc('apply_party_suggestions', { p_company_id: input.companyId, p_user_id: input.userId, p_items: [item] })
  if (error) throw new Error(`party suggestion failed: ${error.message}`)
}
