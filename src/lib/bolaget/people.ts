/**
 * People and companies in the Bolaget registers: a `parties` row each (kind
 * person or company, origin 'bolaget'), plus identity and postal address in
 * party_person_private, which only the service role reads or writes.
 *
 * The personnummer is stored three ways (20261029210000_bolaget_registers.sql):
 * encrypted (to print the aktiebok, ABL 5:5), as a keyed HMAC (to find the
 * same person twice without decrypting) and masked (what members and agents
 * see). It is collected in the app only: the operation inputs never carry
 * it (staging-pii-guard), and nothing here returns it except
 * loadFullPersonnummer, which only the aktiebok printout for an owner or
 * admin calls.
 */
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptStoredPersonalNumber, encryptPersonalNumberForStorage, maskPersonalNumber } from '@/lib/auth/bankid'
import { normalizeSignerPersonalNumber } from '@/lib/auth/bankid-signer'
import { looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'
import { formatOrgNumberDisplay, isValidOrgNumber, normalizeOrgNumber } from '@/lib/invariants/org-number'
import { createServiceClient } from '@/lib/supabase/server'
import type { OperationContext } from '@/lib/operations/types'
import type { PartyAddress, PartyKind, RegisterParty } from './types'

/** A holder, pledgee or role holder as an input names one: an existing party, or a new one by name. */
export interface PartyRef {
  party_id?: string | null
  name?: string | null
  kind?: PartyKind | null
  org_number?: string | null
}

export class PartyRefError extends Error {
  constructor(readonly code: 'BOLAGET_PARTY_NOT_FOUND' | 'BOLAGET_PARTY_INVALID' | 'BOLAGET_PERSONNUMMER_IN_APP_ONLY', message: string) {
    super(message)
    this.name = 'PartyRefError'
  }
}

function hmacKey(): Buffer {
  const key = process.env.BANKID_ENCRYPTION_KEY
  if (!key) throw new Error('BANKID_ENCRYPTION_KEY is required to store a personnummer')
  // A key of its own, derived from the encryption secret: the same bytes are
  // never used for two purposes.
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update('accounted/party_person_private/hmac/v1').digest()
}

/** Keyed HMAC-SHA256 of a 12-digit personnummer (hex). */
export function personnummerHmac(personnummer12: string): string {
  return crypto.createHmac('sha256', hmacKey()).update(personnummer12).digest('hex')
}

/** YYYYMMDD-NNNN, the form the aktiebok prints. */
export function formatPersonnummer12(personnummer12: string): string {
  return `${personnummer12.slice(0, 8)}-${personnummer12.slice(8)}`
}

/**
 * Validate a reference before anything is written: an existing party id, or
 * a name with a kind. A person never carries an org number here: a
 * personnummer-shaped number is refused and collected in the app instead.
 */
export function checkPartyRef(ref: PartyRef, label: string): void {
  if (ref.party_id) return
  const name = ref.name?.trim()
  if (!name) throw new PartyRefError('BOLAGET_PARTY_INVALID', `Ange ${label}: en befintlig person eller ett namn.`)
  const org = ref.org_number?.trim()
  if (org && looksLikeSwedishPersonalNumber(org)) {
    throw new PartyRefError(
      'BOLAGET_PERSONNUMMER_IN_APP_ONLY',
      'Ett personnummer registreras bara i Accounted, under Ägare och aktiebok, aldrig i ett anrop.',
    )
  }
  if (org && !isValidOrgNumber(org)) throw new PartyRefError('BOLAGET_PARTY_INVALID', `Organisationsnumret för ${name} är inte giltigt.`)
}

/** The party ids that belong to this company, of those given. */
async function partiesInCompany(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Map<string, { display_name: string; kind: string; org_number: string | null }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const { data, error } = await supabase
    .from('parties')
    .select('id, display_name, kind, org_number')
    .eq('company_id', companyId)
    .in('id', unique)
  if (error) throw new Error(`parties read failed: ${error.message}`)
  return new Map(((data ?? []) as Array<{ id: string; display_name: string; kind: string; org_number: string | null }>).map((p) => [p.id, p]))
}

/** Fails when a referenced party id is not this company's. */
export async function assertPartiesInCompany(supabase: SupabaseClient, companyId: string, ids: Array<string | null | undefined>): Promise<void> {
  const wanted = ids.filter((id): id is string => Boolean(id))
  const found = await partiesInCompany(supabase, companyId, wanted)
  for (const id of wanted) {
    if (!found.has(id)) throw new PartyRefError('BOLAGET_PARTY_NOT_FOUND', 'Personen eller företaget finns inte i bolagets register.')
  }
}

/**
 * The party a reference names, created when it is new. A company is found
 * by its org number; a person by name when exactly one register person has
 * it (so a shareholder an agent names is the board member already seeded),
 * otherwise created.
 */
export async function ensureRegisterParty(ctx: OperationContext, ref: PartyRef): Promise<string> {
  if (ref.party_id) {
    await assertPartiesInCompany(ctx.supabase, ctx.companyId, [ref.party_id])
    return ref.party_id
  }
  checkPartyRef(ref, 'personen')
  const name = ref.name!.trim()
  const kind: PartyKind = ref.kind === 'company' || ref.org_number ? 'company' : 'person'
  if (kind === 'person') {
    const { data, error } = await ctx.supabase
      .from('parties')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('kind', 'person')
      .is('merged_into', null)
      .ilike('display_name', name.replace(/[%_\\]/g, (c) => `\\${c}`))
      .limit(2)
    if (error) throw new Error(`parties read failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ id: string }>
    if (rows.length === 1) return rows[0]!.id
  }
  const { data: partyId, error } = await ctx.supabase.rpc('ensure_party', {
    p_company_id: ctx.companyId,
    p_user_id: ctx.userId,
    p_name: name,
    p_org_number: ref.org_number ? normalizeOrgNumber(ref.org_number) : null,
    p_kind: kind,
    p_origin: 'bolaget',
  })
  if (error || !partyId) throw new Error(`ensure_party failed: ${error?.message ?? 'no id'}`)
  return partyId as string
}

export interface PersonPrivateInput {
  /** Any accepted form (10 or 12 digits, with or without hyphen); null clears it. */
  personnummer?: string | null
  birth_date?: string | null
  foreign_id?: string | null
  address_line1?: string | null
  address_line2?: string | null
  postal_code?: string | null
  city?: string | null
  country?: string | null
  email?: string | null
  phone?: string | null
}

export type PersonPrivateOutcome =
  | { ok: true; personnummer_masked: string | null }
  | { ok: false; code: 'BOLAGET_PARTY_NOT_FOUND' | 'BOLAGET_PERSONNUMMER_INVALID' | 'BOLAGET_PERSONNUMMER_TAKEN' }

/**
 * Save a register party's identity and address (the app's own form only).
 * Fields left undefined keep their value.
 */
export async function savePersonPrivate(companyId: string, partyId: string, input: PersonPrivateInput): Promise<PersonPrivateOutcome> {
  const service = createServiceClient()
  const found = await partiesInCompany(service, companyId, [partyId])
  if (!found.has(partyId)) return { ok: false, code: 'BOLAGET_PARTY_NOT_FOUND' }

  // Undefined keys are left out of the request, so a field not sent keeps its value.
  const text = (value: string | null | undefined, upper = false) =>
    value === undefined ? undefined : value === null || value.trim() === '' ? null : upper ? value.trim().toUpperCase() : value.trim()
  let masked: string | null | undefined
  let encrypted: string | null | undefined
  let hmac: string | null | undefined
  if (input.personnummer !== undefined) {
    if (input.personnummer === null || input.personnummer.trim() === '') {
      masked = null
      encrypted = null
      hmac = null
    } else {
      const full = normalizeSignerPersonalNumber(input.personnummer)
      if (!full) return { ok: false, code: 'BOLAGET_PERSONNUMMER_INVALID' }
      hmac = personnummerHmac(full)
      const { data: other } = await service
        .from('party_person_private')
        .select('party_id')
        .eq('company_id', companyId)
        .eq('personnummer_hmac', hmac)
        .neq('party_id', partyId)
        .maybeSingle()
      if (other) return { ok: false, code: 'BOLAGET_PERSONNUMMER_TAKEN' }
      masked = maskPersonalNumber(full)
      encrypted = encryptPersonalNumberForStorage(full)
    }
  }
  const { error } = await service.from('party_person_private').upsert(
    {
      party_id: partyId,
      company_id: companyId,
      personnummer_encrypted: encrypted,
      personnummer_hmac: hmac,
      personnummer_masked: masked,
      birth_date: text(input.birth_date),
      foreign_id: text(input.foreign_id),
      address_line1: text(input.address_line1),
      address_line2: text(input.address_line2),
      postal_code: text(input.postal_code),
      city: text(input.city),
      country: text(input.country, true),
      email: text(input.email),
      phone: text(input.phone),
    },
    { onConflict: 'party_id' },
  )
  if (error) {
    if (error.code === '23505') return { ok: false, code: 'BOLAGET_PERSONNUMMER_TAKEN' }
    throw new Error(`party_person_private upsert failed: ${error.message}`)
  }
  if (masked === undefined) {
    const { data } = await service.from('party_person_private').select('personnummer_masked').eq('party_id', partyId).maybeSingle()
    masked = (data as { personnummer_masked: string | null } | null)?.personnummer_masked ?? null
  }
  return { ok: true, personnummer_masked: masked }
}

interface PrivateRow {
  party_id: string
  personnummer_masked: string | null
  birth_date: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
  email: string | null
}

/** Register parties by id, with masked identity and address. Never the personnummer itself. */
export async function loadRegisterParties(companyId: string, partyIds: string[]): Promise<Map<string, RegisterParty>> {
  const unique = [...new Set(partyIds)]
  const out = new Map<string, RegisterParty>()
  if (unique.length === 0) return out
  const service = createServiceClient()
  const [parties, privates] = await Promise.all([
    partiesInCompany(service, companyId, unique),
    service
      .from('party_person_private')
      .select('party_id, personnummer_masked, birth_date, address_line1, address_line2, postal_code, city, country, email')
      .eq('company_id', companyId)
      .in('party_id', unique),
  ])
  if (privates.error) throw new Error(`party_person_private read failed: ${privates.error.message}`)
  const privateById = new Map(((privates.data ?? []) as PrivateRow[]).map((p) => [p.party_id, p]))
  for (const id of unique) {
    const p = parties.get(id)
    if (!p) continue
    const priv = privateById.get(id)
    const address: PartyAddress | null =
      priv && (priv.address_line1 || priv.postal_code || priv.city)
        ? { line1: priv.address_line1, line2: priv.address_line2, postal_code: priv.postal_code, city: priv.city, country: priv.country }
        : null
    out.set(id, {
      party_id: id,
      name: p.display_name,
      kind: p.kind === 'person' ? 'person' : 'company',
      org_number: p.kind === 'person' ? null : p.org_number,
      personnummer_masked: priv?.personnummer_masked ?? null,
      birth_date: priv?.birth_date ?? null,
      address,
      email: priv?.email ?? null,
    })
  }
  return out
}

/**
 * The full personnummer per party (YYYYMMDD-NNNN), for the aktiebok
 * printout (ABL 5:5) an owner or admin asks for. Never for an agent.
 */
export async function loadFullPersonnummer(companyId: string, partyIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(partyIds)]
  if (unique.length === 0) return out
  const { data, error } = await createServiceClient()
    .from('party_person_private')
    .select('party_id, personnummer_encrypted')
    .eq('company_id', companyId)
    .in('party_id', unique)
    .not('personnummer_encrypted', 'is', null)
  if (error) throw new Error(`party_person_private read failed: ${error.message}`)
  for (const row of (data ?? []) as Array<{ party_id: string; personnummer_encrypted: string }>) {
    try {
      out.set(row.party_id, formatPersonnummer12(decryptStoredPersonalNumber(row.personnummer_encrypted)))
    } catch {
      // A row that does not decrypt prints masked instead.
    }
  }
  return out
}

/** How a register party is identified in print: personnummer (full or masked), org number, or birth date. */
export function identityText(party: RegisterParty, fullPersonnummer?: Map<string, string>): string {
  if (party.kind === 'company') return party.org_number ? formatOrgNumberDisplay(party.org_number) : ''
  return fullPersonnummer?.get(party.party_id) ?? party.personnummer_masked ?? party.birth_date ?? ''
}
