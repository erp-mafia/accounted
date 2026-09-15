import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type {
  CreateBrfApartmentSchema,
  CreateBrfPledgeSchema,
  InitialBrfHoldingSchema,
  RecordBrfTransferSchema,
  ReleaseBrfPledgeSchema,
  UpdateBrfApartmentSchema,
} from '@/lib/api/schemas'
import { BrfRegisterError, type BrfRegisterErrorCode } from '@/lib/brf/errors'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Apartment register of a bostadsrättsförening.
 *
 * BRL (1991:614) 9 kap. 8 §: the board keeps a medlemsförteckning and a
 * lägenhetsförteckning. The medlemsförteckning is association_members
 * (EFL 5 kap. applies, BRL 1 kap. 1 §; 9 kap. 9 § adds "the bostadsrätt the
 * member holds", which this register supplies). 9 kap. 10 §: for every
 * apartment the beteckning, belägenhet, rumsantal and övriga utrymmen, the
 * date Bolagsverket registered the ekonomisk plan, the bostadsrättshavare's
 * name and the insats; a pantsättning is noted with its date. 9 kap. 11 §:
 * both registers are available at the association and a bostadsrättshavare
 * may ask for an extract of the lägenhetsförteckning.
 *
 * The ledger owns the totals (2083 Insatser, 2087 Upplåtelseavgifter); the
 * register owns which apartment carries which part of them, and
 * `apartmentCapitalReconciliation` compares the two.
 *
 * A transfer (överlåtelse, BRL 6 kap.) goes through record_brf_transfer():
 * the RPC refuses a förvärvare who is not an admitted member on the transfer
 * date (6 kap. 5 §: a transfer to someone refused membership is void; 2 kap.
 * 3 §) and a share larger than the överlåtare holds, then moves the holding
 * atomically. The transfer row carries the KU55 data points (lib/brf/ku55).
 */

export type BrfUpplatenMed = 'bostadsratt' | 'hyresratt'
export type BrfTransferKind = 'sale' | 'gift' | 'arv' | 'bodelning' | 'other'

export interface BrfApartmentRow {
  id: string
  company_id: string
  apartment_number: string
  lantmateriet_number: string | null
  location: string
  rooms: number | string | null
  kvm: number | string | null
  other_spaces: string | null
  upplaten_med: BrfUpplatenMed
  andelstal_arsavgift: number | string | null
  andelstal_kapital: number | string | null
  insats: number | string | null
  upplatelseavgift: number | string | null
  upplatelse_date: string | null
  ekonomisk_plan_registered_on: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface BrfHoldingRow {
  id: string
  company_id: string
  apartment_id: string
  member_id: string
  share: number | string
  from_date: string
  to_date: string | null
  acquired_by_transfer_id: string | null
  closed_by_transfer_id: string | null
  created_at: string
  updated_at: string
}

export interface BrfTransferRow {
  id: string
  company_id: string
  apartment_id: string
  transfer_date: string
  kind: BrfTransferKind
  share: number | string
  from_member_id: string
  to_member_id: string
  price: number | string | null
  additional_price: number | string | null
  forvarv_date: string | null
  forvarv_genom_arv_gava_bodelning: boolean
  forvarv_price: number | string | null
  kapitaltillskott: number | string | null
  inre_fond_vid_overlatelse: number | string | null
  inre_fond_vid_forvarv: number | string | null
  andel_formogenhet_1974: number | string | null
  ku55_uppgifter: 'G' | 'I'
  agreement_document_id: string | null
  notes: string | null
  created_at: string
}

export interface BrfPledgeRow {
  id: string
  company_id: string
  apartment_id: string
  member_id: string | null
  creditor: string
  notified_on: string
  reference: string | null
  released_on: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** The member columns the register needs (never the personnummer ciphertext). */
interface MemberSummary {
  id: string
  member_number: string
  name: string
  postal_address: string | null
  admitted_on: string
  exited_on: string | null
}

async function listMemberSummaries(supabase: SupabaseClient, companyId: string): Promise<MemberSummary[]> {
  return fetchAllRows<MemberSummary>(
    ({ from, to }) =>
      supabase
        .from('association_members')
        .select('id, member_number, name, postal_address, admitted_on, exited_on')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (row) => row.id },
  )
}

export async function listApartments(supabase: SupabaseClient, companyId: string): Promise<BrfApartmentRow[]> {
  const rows = await fetchAllRows<BrfApartmentRow>(
    ({ from, to }) =>
      supabase
        .from('brf_apartments')
        .select('id, company_id, apartment_number, lantmateriet_number, location, rooms, kvm, other_spaces, upplaten_med, andelstal_arsavgift, andelstal_kapital, insats, upplatelseavgift, upplatelse_date, ekonomisk_plan_registered_on, notes, created_at, updated_at')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (row) => row.id },
  )
  rows.sort((a, b) => a.apartment_number.localeCompare(b.apartment_number, 'sv', { numeric: true }))
  return rows
}

export async function getApartment(
  supabase: SupabaseClient,
  companyId: string,
  apartmentId: string,
): Promise<BrfApartmentRow> {
  const { data, error } = await supabase
    .from('brf_apartments')
    .select('id, company_id, apartment_number, lantmateriet_number, location, rooms, kvm, other_spaces, upplaten_med, andelstal_arsavgift, andelstal_kapital, insats, upplatelseavgift, upplatelse_date, ekonomisk_plan_registered_on, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', apartmentId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new BrfRegisterError('BRF_APARTMENT_NOT_FOUND')
  return data as BrfApartmentRow
}

export async function createApartment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof CreateBrfApartmentSchema>,
): Promise<BrfApartmentRow> {
  const { data, error } = await supabase
    .from('brf_apartments')
    .insert({
      company_id: companyId,
      user_id: userId,
      apartment_number: input.apartment_number,
      lantmateriet_number: input.lantmateriet_number ?? null,
      location: input.location,
      rooms: input.rooms ?? null,
      kvm: input.kvm ?? null,
      other_spaces: input.other_spaces ?? null,
      upplaten_med: input.upplaten_med,
      andelstal_arsavgift: input.andelstal_arsavgift ?? null,
      andelstal_kapital: input.andelstal_kapital ?? null,
      insats: input.insats === undefined || input.insats === null ? null : roundOre(input.insats),
      upplatelseavgift:
        input.upplatelseavgift === undefined || input.upplatelseavgift === null
          ? null
          : roundOre(input.upplatelseavgift),
      upplatelse_date: input.upplatelse_date ?? null,
      ekonomisk_plan_registered_on: input.ekonomisk_plan_registered_on ?? null,
      notes: input.notes ?? null,
    })
    .select('id, company_id, apartment_number, lantmateriet_number, location, rooms, kvm, other_spaces, upplaten_med, andelstal_arsavgift, andelstal_kapital, insats, upplatelseavgift, upplatelse_date, ekonomisk_plan_registered_on, notes, created_at, updated_at')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new BrfRegisterError('BRF_APARTMENT_NUMBER_TAKEN')
    throw error
  }
  return data as BrfApartmentRow
}

/** Non-identity fields only: the beteckning is the register key and stays. */
export async function updateApartment(
  supabase: SupabaseClient,
  companyId: string,
  apartmentId: string,
  input: z.infer<typeof UpdateBrfApartmentSchema>,
): Promise<BrfApartmentRow> {
  await getApartment(supabase, companyId, apartmentId)
  // An object literal so the phantom-column guard can check every key; an
  // undefined value is dropped by JSON serialisation and leaves the column,
  // null clears it.
  const money = (value: number | null | undefined): number | null | undefined =>
    value === undefined || value === null ? value : roundOre(value)
  const { data, error } = await supabase
    .from('brf_apartments')
    .update({
      lantmateriet_number: input.lantmateriet_number,
      location: input.location,
      rooms: input.rooms,
      kvm: input.kvm,
      other_spaces: input.other_spaces,
      upplaten_med: input.upplaten_med,
      andelstal_arsavgift: input.andelstal_arsavgift,
      andelstal_kapital: input.andelstal_kapital,
      insats: money(input.insats),
      upplatelseavgift: money(input.upplatelseavgift),
      upplatelse_date: input.upplatelse_date,
      ekonomisk_plan_registered_on: input.ekonomisk_plan_registered_on,
      notes: input.notes,
    })
    .eq('company_id', companyId)
    .eq('id', apartmentId)
    .select('id, company_id, apartment_number, lantmateriet_number, location, rooms, kvm, other_spaces, upplaten_med, andelstal_arsavgift, andelstal_kapital, insats, upplatelseavgift, upplatelse_date, ekonomisk_plan_registered_on, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as BrfApartmentRow
}

export async function listHoldings(
  supabase: SupabaseClient,
  companyId: string,
  options: { apartmentId?: string; memberId?: string; openOnly?: boolean } = {},
): Promise<BrfHoldingRow[]> {
  return fetchAllRows<BrfHoldingRow>(
    ({ from, to }) => {
      let query = supabase
        .from('brf_apartment_holdings')
        .select('id, company_id, apartment_id, member_id, share, from_date, to_date, acquired_by_transfer_id, closed_by_transfer_id, created_at, updated_at')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (options.apartmentId) query = query.eq('apartment_id', options.apartmentId)
      if (options.memberId) query = query.eq('member_id', options.memberId)
      if (options.openOnly) query = query.is('to_date', null)
      return query
    },
    { dedupeBy: (row) => row.id },
  )
}

/**
 * The first upplåtelse (or a register load): open a holding without a
 * transfer. The open shares of the apartment may not exceed 1; the database
 * trigger is the backstop, the check here gives the caller a typed error.
 */
export async function assignInitialHolder(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  apartmentId: string,
  input: z.infer<typeof InitialBrfHoldingSchema>,
): Promise<BrfHoldingRow> {
  await getApartment(supabase, companyId, apartmentId)
  const { data: member, error: memberError } = await supabase
    .from('association_members')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', input.member_id)
    .maybeSingle()
  if (memberError) throw memberError
  if (!member) throw new BrfRegisterError('BRF_HOLDING_MEMBER_NOT_FOUND')

  const open = await listHoldings(supabase, companyId, { apartmentId, openOnly: true })
  const held = open.reduce((sum, row) => sum + Number(row.share), 0)
  if (held + input.share > 1.000001) throw new BrfRegisterError('BRF_HOLDING_EXCEEDS_APARTMENT')

  const { data, error } = await supabase
    .from('brf_apartment_holdings')
    .insert({
      company_id: companyId,
      user_id: userId,
      apartment_id: apartmentId,
      member_id: input.member_id,
      share: input.share,
      from_date: input.from_date,
    })
    .select('id, company_id, apartment_id, member_id, share, from_date, to_date, acquired_by_transfer_id, closed_by_transfer_id, created_at, updated_at')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23514') throw new BrfRegisterError('BRF_HOLDING_EXCEEDS_APARTMENT')
    throw error
  }
  return data as BrfHoldingRow
}

export async function listTransfers(
  supabase: SupabaseClient,
  companyId: string,
  options: { apartmentId?: string; incomeYear?: number } = {},
): Promise<BrfTransferRow[]> {
  const rows = await fetchAllRows<BrfTransferRow>(
    ({ from, to }) => {
      let query = supabase
        .from('brf_apartment_transfers')
        .select('id, company_id, apartment_id, transfer_date, kind, share, from_member_id, to_member_id, price, additional_price, forvarv_date, forvarv_genom_arv_gava_bodelning, forvarv_price, kapitaltillskott, inre_fond_vid_overlatelse, inre_fond_vid_forvarv, andel_formogenhet_1974, ku55_uppgifter, agreement_document_id, notes, created_at')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (options.apartmentId) query = query.eq('apartment_id', options.apartmentId)
      if (options.incomeYear !== undefined) {
        query = query
          .gte('transfer_date', `${options.incomeYear}-01-01`)
          .lte('transfer_date', `${options.incomeYear}-12-31`)
      }
      return query
    },
    { dedupeBy: (row) => row.id },
  )
  rows.sort((a, b) => a.transfer_date.localeCompare(b.transfer_date) || a.created_at.localeCompare(b.created_at))
  return rows
}

const RPC_ERROR_CODES = new Set<BrfRegisterErrorCode>([
  'BRF_APARTMENT_NOT_FOUND',
  'BRF_TRANSFER_FORBIDDEN',
  'BRF_TRANSFER_SAME_MEMBER',
  'BRF_TRANSFER_SELLER_NOT_HOLDER',
  'BRF_TRANSFER_SHARE_EXCEEDS_HOLDING',
  'BRF_TRANSFER_DATE_BEFORE_HOLDING',
  'BRF_TRANSFER_BUYER_NOT_MEMBER',
])

/**
 * Record an överlåtelse through record_brf_transfer(). The agreement, when
 * given, must be a document of this company (the FK alone would accept any
 * company's document).
 */
export async function recordTransfer(
  supabase: SupabaseClient,
  companyId: string,
  apartmentId: string,
  input: z.infer<typeof RecordBrfTransferSchema>,
): Promise<BrfTransferRow> {
  await getApartment(supabase, companyId, apartmentId)
  if (input.agreement_document_id) {
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', input.agreement_document_id)
      .maybeSingle()
    if (docError) throw docError
    if (!doc) throw new BrfRegisterError('BRF_TRANSFER_DOCUMENT_NOT_FOUND')
  }
  const { data, error } = await supabase.rpc('record_brf_transfer', {
    p_apartment_id: apartmentId,
    p_input: {
      from_member_id: input.from_member_id,
      to_member_id: input.to_member_id,
      share: input.share,
      transfer_date: input.transfer_date,
      kind: input.kind,
      price: input.price ?? null,
      additional_price: input.additional_price ?? null,
      forvarv_date: input.forvarv_date ?? null,
      forvarv_genom_arv_gava_bodelning: input.forvarv_genom_arv_gava_bodelning ?? false,
      forvarv_price: input.forvarv_price ?? null,
      kapitaltillskott: input.kapitaltillskott ?? null,
      inre_fond_vid_overlatelse: input.inre_fond_vid_overlatelse ?? null,
      inre_fond_vid_forvarv: input.inre_fond_vid_forvarv ?? null,
      andel_formogenhet_1974: input.andel_formogenhet_1974 ?? null,
      ku55_uppgifter: input.ku55_uppgifter ?? 'I',
      agreement_document_id: input.agreement_document_id ?? null,
      notes: input.notes ?? null,
    },
  })
  if (error) throw error
  const result = data as { ok: boolean; code?: string; transfer_id?: string }
  if (!result?.ok) {
    const code = result?.code as BrfRegisterErrorCode | undefined
    if (code && RPC_ERROR_CODES.has(code)) throw new BrfRegisterError(code)
    throw new Error(`record_brf_transfer failed: ${result?.code ?? 'unknown'}`)
  }
  const { data: row, error: readError } = await supabase
    .from('brf_apartment_transfers')
    .select('id, company_id, apartment_id, transfer_date, kind, share, from_member_id, to_member_id, price, additional_price, forvarv_date, forvarv_genom_arv_gava_bodelning, forvarv_price, kapitaltillskott, inre_fond_vid_overlatelse, inre_fond_vid_forvarv, andel_formogenhet_1974, ku55_uppgifter, agreement_document_id, notes, created_at')
    .eq('company_id', companyId)
    .eq('id', result.transfer_id as string)
    .single()
  if (readError) throw readError
  return row as BrfTransferRow
}

export async function listPledges(
  supabase: SupabaseClient,
  companyId: string,
  options: { apartmentId?: string; openOnly?: boolean } = {},
): Promise<BrfPledgeRow[]> {
  return fetchAllRows<BrfPledgeRow>(
    ({ from, to }) => {
      let query = supabase
        .from('brf_pledges')
        .select('id, company_id, apartment_id, member_id, creditor, notified_on, reference, released_on, notes, created_at, updated_at')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (options.apartmentId) query = query.eq('apartment_id', options.apartmentId)
      if (options.openOnly) query = query.is('released_on', null)
      return query
    },
    { dedupeBy: (row) => row.id },
  )
}

export async function notifyPledge(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof CreateBrfPledgeSchema>,
): Promise<BrfPledgeRow> {
  await getApartment(supabase, companyId, input.apartment_id)
  if (input.member_id) {
    const { data: member, error: memberError } = await supabase
      .from('association_members')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', input.member_id)
      .maybeSingle()
    if (memberError) throw memberError
    if (!member) throw new BrfRegisterError('BRF_MEMBER_NOT_FOUND')
  }
  const { data, error } = await supabase
    .from('brf_pledges')
    .insert({
      company_id: companyId,
      user_id: userId,
      apartment_id: input.apartment_id,
      member_id: input.member_id ?? null,
      creditor: input.creditor,
      notified_on: input.notified_on,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
    })
    .select('id, company_id, apartment_id, member_id, creditor, notified_on, reference, released_on, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as BrfPledgeRow
}

export async function releasePledge(
  supabase: SupabaseClient,
  companyId: string,
  pledgeId: string,
  input: z.infer<typeof ReleaseBrfPledgeSchema>,
): Promise<BrfPledgeRow> {
  const { data: existing, error: readError } = await supabase
    .from('brf_pledges')
    .select('id, company_id, apartment_id, member_id, creditor, notified_on, reference, released_on, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', pledgeId)
    .maybeSingle()
  if (readError) throw readError
  if (!existing) throw new BrfRegisterError('BRF_PLEDGE_NOT_FOUND')
  if ((existing as BrfPledgeRow).released_on) throw new BrfRegisterError('BRF_PLEDGE_ALREADY_RELEASED')
  const { data, error } = await supabase
    .from('brf_pledges')
    .update({ released_on: input.released_on, notes: input.notes ?? (existing as BrfPledgeRow).notes })
    .eq('company_id', companyId)
    .eq('id', pledgeId)
    .select('id, company_id, apartment_id, member_id, creditor, notified_on, reference, released_on, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as BrfPledgeRow
}

/**
 * Store a member's personnummer encrypted (KU55 fältkod 215). Encryption is
 * server-side and the ciphertext is never returned by the register listings.
 */
export async function setMemberPersonalNumber(
  supabase: SupabaseClient,
  companyId: string,
  memberId: string,
  personalNumber: string | null,
): Promise<void> {
  const { data: member, error: readError } = await supabase
    .from('association_members')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', memberId)
    .maybeSingle()
  if (readError) throw readError
  if (!member) throw new BrfRegisterError('BRF_MEMBER_NOT_FOUND')
  const { error } = await supabase
    .from('association_members')
    .update({ personal_number_ciphertext: personalNumber ? encryptPersonnummer(personalNumber) : null })
    .eq('company_id', companyId)
    .eq('id', memberId)
  if (error) throw error
}

/** The lägenhetsförteckning extract (BRL 9 kap. 10-11 §§), one row per apartment. */
export interface ApartmentRegisterExtractRow {
  apartment_number: string
  lantmateriet_number: string | null
  location: string
  rooms: number | null
  kvm: number | null
  other_spaces: string | null
  upplaten_med: BrfUpplatenMed
  ekonomisk_plan_registered_on: string | null
  insats: number | null
  upplatelseavgift: number | null
  andelstal_arsavgift: number | null
  andelstal_kapital: number | null
  holders: Array<{ member_number: string; name: string; share: number; from_date: string }>
  pledges: Array<{ creditor: string; notified_on: string; reference: string | null }>
}

const num = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value)

export async function apartmentRegisterExtract(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ApartmentRegisterExtractRow[]> {
  const [apartments, holdings, pledges, members] = await Promise.all([
    listApartments(supabase, companyId),
    listHoldings(supabase, companyId, { openOnly: true }),
    listPledges(supabase, companyId, { openOnly: true }),
    listMemberSummaries(supabase, companyId),
  ])
  const memberById = new Map(members.map((m) => [m.id, m]))
  return apartments.map((apartment) => ({
    apartment_number: apartment.apartment_number,
    lantmateriet_number: apartment.lantmateriet_number,
    location: apartment.location,
    rooms: num(apartment.rooms),
    kvm: num(apartment.kvm),
    other_spaces: apartment.other_spaces,
    upplaten_med: apartment.upplaten_med,
    ekonomisk_plan_registered_on: apartment.ekonomisk_plan_registered_on,
    insats: num(apartment.insats),
    upplatelseavgift: num(apartment.upplatelseavgift),
    andelstal_arsavgift: num(apartment.andelstal_arsavgift),
    andelstal_kapital: num(apartment.andelstal_kapital),
    holders: holdings
      .filter((h) => h.apartment_id === apartment.id)
      .map((h) => {
        const member = memberById.get(h.member_id)
        return {
          member_number: member?.member_number ?? '',
          name: member?.name ?? '',
          share: Number(h.share),
          from_date: h.from_date,
        }
      })
      .sort((a, b) => a.member_number.localeCompare(b.member_number, 'sv', { numeric: true })),
    pledges: pledges
      .filter((p) => p.apartment_id === apartment.id)
      .map((p) => ({ creditor: p.creditor, notified_on: p.notified_on, reference: p.reference }))
      .sort((a, b) => a.notified_on.localeCompare(b.notified_on)),
  }))
}

export function apartmentRegisterCsv(rows: ApartmentRegisterExtractRow[]): string {
  const escape = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = [
    'Lägenhetsbeteckning',
    'Lägenhetsnummer (Lantmäteriet)',
    'Belägenhet',
    'Rum',
    'Kvm',
    'Övriga utrymmen',
    'Upplåten med',
    'Ekonomisk plan registrerad',
    'Insats',
    'Upplåtelseavgift',
    'Andelstal årsavgift',
    'Andelstal kapital',
    'Bostadsrättshavare',
    'Pantsättningar',
  ]
  const lines = rows.map((row) =>
    [
      row.apartment_number,
      row.lantmateriet_number,
      row.location,
      row.rooms,
      row.kvm,
      row.other_spaces,
      row.upplaten_med === 'bostadsratt' ? 'Bostadsrätt' : 'Hyresrätt',
      row.ekonomisk_plan_registered_on,
      row.insats,
      row.upplatelseavgift,
      row.andelstal_arsavgift,
      row.andelstal_kapital,
      row.holders.map((h) => `${h.name} (${h.member_number}, ${(h.share * 100).toFixed(2)} %)`).join(', '),
      row.pledges.map((p) => `${p.creditor} ${p.notified_on}${p.reference ? ` ${p.reference}` : ''}`).join(', '),
    ]
      .map(escape)
      .join(';'),
  )
  return [header.join(';'), ...lines].join('\n') + '\n'
}

export interface ApartmentCapitalReconciliationLine {
  label: string
  accounts: readonly string[]
  register_amount: number
  ledger_balance: number
  difference: number
}

export interface ApartmentCapitalReconciliation {
  fiscal_period_id: string
  apartments_upplatna: number
  lines: ApartmentCapitalReconciliationLine[]
  is_reconciled: boolean
}

/**
 * Insatser and upplåtelseavgifter of the apartments upplåtna med bostadsrätt
 * against the ledger's closing credit balances on 2083 and 2087 (ÅRL 3 kap.
 * 10 b §). A difference is a finding for the bokslut, never corrected here.
 */
export async function apartmentCapitalReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<ApartmentCapitalReconciliation> {
  const [apartments, trialBalance] = await Promise.all([
    listApartments(supabase, companyId),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
  ])
  const upplatna = apartments.filter((a) => a.upplaten_med === 'bostadsratt')
  const balanceOf = (accounts: readonly string[]): number =>
    roundOre(
      trialBalance.rows
        .filter((row) => accounts.includes(row.account_number))
        .reduce((sum, row) => sum + (row.closing_credit ?? 0) - (row.closing_debit ?? 0), 0),
    )
  const sumOf = (pick: (a: BrfApartmentRow) => number | string | null): number =>
    roundOre(upplatna.reduce((sum, a) => sum + (num(pick(a)) ?? 0), 0))
  const lines: ApartmentCapitalReconciliationLine[] = [
    { label: 'Insatser (2083)', accounts: ['2083'], register_amount: sumOf((a) => a.insats), ledger_balance: 0, difference: 0 },
    { label: 'Upplåtelseavgifter (2087)', accounts: ['2087'], register_amount: sumOf((a) => a.upplatelseavgift), ledger_balance: 0, difference: 0 },
  ].map((line) => {
    const ledger = balanceOf(line.accounts)
    return { ...line, ledger_balance: ledger, difference: roundOre(ledger - line.register_amount) }
  })
  return {
    fiscal_period_id: fiscalPeriodId,
    apartments_upplatna: upplatna.length,
    lines,
    is_reconciled: lines.every((line) => line.difference === 0),
  }
}
