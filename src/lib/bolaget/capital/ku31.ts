/**
 * KU31 per inkomstår from the dividend register: who received what, what
 * still blocks the file, and the file itself.
 *
 * Who gets a KU31 (SFL 19:2-3; Skatteverket's KU31 guidance): every natural
 * person and estate (dödsbo) the company paid a dividend to in the year. A
 * Swedish legal person gets none; a foreign legal person only from an
 * avstämningsbolag, which keeps no register here. So a holder of kind
 * 'company' is listed as not reported, never put in the file.
 *
 * The inkomstår is the year of the dividend's betalningsdag: in a company
 * outside Euroclear the dividend is at the holder's disposal on the stämma
 * day unless a later betalningsdag was decided, and is taxed when it is at
 * their disposal (Skatteverket, KU31 guidance). Only booked and paid
 * dividends count; one still only decided is reported as a warning.
 *
 * Amounts: field 574 is whole kronor with the öre dropped
 * (truncateToWholeKronor, SFF 2011:1261 22:1, as every Skatteverket-bound
 * amount here), summed per recipient over the year's dividends first.
 *
 * Personnummer: read from party_person_private and decrypted only in
 * generateKu31File, for an owner or administrator, straight into the file.
 * Never stored here, never in a status answer, never in audit_log.
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre, sumOre, truncateToWholeKronor } from '@/lib/money'
import { readCompanyOrgNumber } from '@/lib/company/org-number'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { loadFullPersonnummer, loadRegisterParties } from '../people'
import { loadShareRegisterData } from '../share-register'
import type { RegisterParty } from '../types'
import { loadDistributions, loadDividends, type DividendRow } from './dividends'
import { deriveFamansforetag, type FamansDerivation } from './famans'
import { buildKu31Xml, KU31_INCOME_YEAR, KU31_SCHEMA_VERSION, validateKu31File, type Ku31FileInput, type Ku31Recipient } from './ku31-xml'

export const KU31_PROGRAM_NAME = 'Accounted'

export interface Ku31Settings {
  famansforetag: boolean | null
  famansforetag_derived: boolean | null
  famansforetag_confirmed_at: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  last_generated_at: string | null
}

export interface Ku31RecipientView {
  party_id: string
  name: string
  kind: 'person' | 'company'
  /** Masked personnummer or the org number; never the full personnummer. */
  identity: string | null
  /** The year's dividends to this holder, to the öre. */
  amount: number
  /** What field 574 reports: whole kronor, öre dropped. */
  reported_amount: number
  reported: boolean
  /** Why a holder is not in the file. */
  reason: 'legal_person' | 'personnummer_missing' | null
}

export interface Ku31Blocker {
  code: string
  message_sv: string
  party_id?: string
}

export interface Ku31Status {
  income_year: number
  deadline: string
  schema_version: string
  file_supported: boolean
  dividends: Array<{ dividend_id: string; decided_on: string; payment_date: string; status: string; total_amount: number; origin: string }>
  /** Dividends with a betalningsdag in the year that are still only decided (not booked): not in the file. */
  unbooked_dividends: number
  recipients: Ku31RecipientView[]
  famansforetag: boolean | null
  famansforetag_derivation: FamansDerivation
  contact: { name: string | null; phone: string | null; email: string | null }
  last_generated_at: string | null
  blockers: Ku31Blocker[]
  ready: boolean
}

function yearOf(d: DividendRow): number {
  return Number(d.payment_date.slice(0, 4))
}

export async function loadKu31Settings(ctx: OperationContext, year: number): Promise<Ku31Settings | null> {
  const { data, error } = await ctx.supabase
    .from('ku31_filings')
    .select('famansforetag, famansforetag_derived, famansforetag_confirmed_at, contact_name, contact_phone, contact_email, last_generated_at')
    .eq('company_id', ctx.companyId)
    .eq('income_year', year)
    .maybeSingle()
  if (error) throw new Error(`ku31_filings read failed: ${error.message}`)
  return (data as Ku31Settings | null) ?? null
}

export async function companyIdentity(ctx: OperationContext): Promise<{ name: string; org_number: string | null }> {
  const { data, error } = await ctx.supabase.from('companies').select('name').eq('id', ctx.companyId).maybeSingle()
  if (error) throw new Error(`companies read failed: ${error.message}`)
  const row = (data ?? {}) as { name?: string | null }
  return { name: row.name?.trim() || '', org_number: normalizeOrgNumber(await readCompanyOrgNumber(ctx.supabase, ctx.companyId)) }
}

export async function famansDerivationFor(ctx: OperationContext, year: number): Promise<FamansDerivation> {
  const today = todayIsoStockholm()
  const yearEnd = `${year}-12-31`
  const register = await loadShareRegisterData(ctx, yearEnd < today ? yearEnd : today)
  return deriveFamansforetag(register.summary.holders.map((h) => ({ party_id: h.party_id, votes: h.votes })))
}

/** Per holder, the year's dividends, with the parties as the registers show them. */
async function yearRecipients(ctx: OperationContext, dividends: readonly DividendRow[]): Promise<{ totals: Map<string, number>; parties: Map<string, RegisterParty> }> {
  const distributions = await loadDistributions(ctx.supabase, ctx.companyId, dividends.map((d) => d.id))
  const totals = new Map<string, number>()
  for (const list of distributions.values()) {
    for (const row of list) totals.set(row.party_id, roundOre((totals.get(row.party_id) ?? 0) + row.amount))
  }
  const parties = await loadRegisterParties(ctx.companyId, [...totals.keys()])
  return { totals, parties }
}

export async function loadKu31Status(ctx: OperationContext, year: number): Promise<Ku31Status> {
  const [all, settings, derivation] = await Promise.all([
    loadDividends(ctx.supabase, ctx.companyId),
    loadKu31Settings(ctx, year),
    famansDerivationFor(ctx, year),
  ])
  const ofYear = all.filter((d) => yearOf(d) === year)
  const reportable = ofYear.filter((d) => d.status === 'booked' || d.status === 'paid')
  const unbooked = ofYear.filter((d) => d.status === 'decided').length
  const { totals, parties } = await yearRecipients(ctx, reportable)

  const recipients: Ku31RecipientView[] = [...totals.entries()]
    .map(([partyId, amount]) => {
      const p = parties.get(partyId)
      const kind = p?.kind ?? 'person'
      const reason: Ku31RecipientView['reason'] = kind === 'company' ? 'legal_person' : !p?.personnummer_masked ? 'personnummer_missing' : null
      return {
        party_id: partyId,
        name: p?.name ?? '',
        kind,
        identity: p ? (kind === 'company' ? p.org_number : p.personnummer_masked) : null,
        amount,
        reported_amount: truncateToWholeKronor(amount),
        reported: kind === 'person',
        reason,
      }
    })
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'sv'))

  const blockers: Ku31Blocker[] = []
  const fileSupported = year === KU31_INCOME_YEAR
  if (!fileSupported) {
    blockers.push({
      code: 'KU31_SCHEMA_YEAR',
      message_sv: `Filen kan skapas för inkomstår ${KU31_INCOME_YEAR} (Skatteverkets schema ${KU31_SCHEMA_VERSION}). Lämna kontrolluppgifter för ${year} i Skatteverkets e-tjänst.`,
    })
  }
  if (!recipients.some((r) => r.reported)) {
    blockers.push({ code: 'KU31_NO_RECIPIENTS', message_sv: `Ingen utdelning till fysiska personer är bokförd med betalningsdag ${year}.` })
  }
  for (const r of recipients.filter((x) => x.reason === 'personnummer_missing')) {
    blockers.push({
      code: 'KU31_PERSONNUMMER_MISSING',
      party_id: r.party_id,
      message_sv: `${r.name || 'En mottagare'} saknar personnummer. Lägg till det under Bolaget, Ägare och aktiebok (personens uppgifter) och skapa filen igen.`,
    })
  }
  if (settings?.famansforetag === null || settings?.famansforetag === undefined) {
    blockers.push({ code: 'KU31_FAMANS_UNANSWERED', message_sv: 'Svara på om bolaget är ett fåmansföretag under inkomståret (fält 061 eller 062).' })
  }
  if (!settings?.contact_name || !settings.contact_phone || !settings.contact_email) {
    blockers.push({ code: 'KU31_CONTACT_MISSING', message_sv: 'Ange kontaktperson med namn, telefon och e-post för filen.' })
  }
  const company = await companyIdentity(ctx)
  if (!company.org_number) {
    blockers.push({ code: 'KU31_PAYER_ORG_NUMBER', message_sv: 'Bolagets organisationsnummer saknas. Ange det under Inställningar, Företag.' })
  }

  return {
    income_year: year,
    deadline: `${year + 1}-01-31`,
    schema_version: KU31_SCHEMA_VERSION,
    file_supported: fileSupported,
    dividends: ofYear.map((d) => ({
      dividend_id: d.id,
      decided_on: d.decided_on,
      payment_date: d.payment_date,
      status: d.status,
      total_amount: d.total_amount,
      origin: d.origin,
    })),
    unbooked_dividends: unbooked,
    recipients,
    famansforetag: settings?.famansforetag ?? null,
    famansforetag_derivation: derivation,
    contact: { name: settings?.contact_name ?? null, phone: settings?.contact_phone ?? null, email: settings?.contact_email ?? null },
    last_generated_at: settings?.last_generated_at ?? null,
    blockers,
    ready: blockers.length === 0,
  }
}

export interface Ku31SettingsInput {
  famansforetag?: boolean | null
  contact_name?: string | null
  contact_phone?: string | null
  contact_email?: string | null
}

/** The fåmansföretag answer and the contact person for a year. Fields left undefined keep their value. */
export async function saveKu31Settings(ctx: OperationContext, year: number, input: Ku31SettingsInput): Promise<OperationOutcome<Ku31Settings>> {
  const existing = await loadKu31Settings(ctx, year)
  const answered = input.famansforetag !== undefined
  const derived = answered ? (await famansDerivationFor(ctx, year)).derived : undefined
  const confirmed = input.famansforetag === undefined ? undefined : input.famansforetag !== null
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim())
  // Undefined fields are left out of the request, so a field not sent keeps its value.
  const fields = {
    famansforetag: input.famansforetag,
    famansforetag_derived: derived,
    famansforetag_confirmed_by: confirmed === undefined ? undefined : confirmed ? ctx.userId : null,
    famansforetag_confirmed_at: confirmed === undefined ? undefined : confirmed ? new Date().toISOString() : null,
    contact_name: text(input.contact_name),
    contact_phone: text(input.contact_phone),
    contact_email: text(input.contact_email),
  }
  const { error } = existing
    ? await ctx.supabase
        .from('ku31_filings')
        .update({
          famansforetag: fields.famansforetag,
          famansforetag_derived: fields.famansforetag_derived,
          famansforetag_confirmed_by: fields.famansforetag_confirmed_by,
          famansforetag_confirmed_at: fields.famansforetag_confirmed_at,
          contact_name: fields.contact_name,
          contact_phone: fields.contact_phone,
          contact_email: fields.contact_email,
        })
        .eq('company_id', ctx.companyId)
        .eq('income_year', year)
    : await ctx.supabase.from('ku31_filings').insert({
        company_id: ctx.companyId,
        income_year: year,
        famansforetag: fields.famansforetag,
        famansforetag_derived: fields.famansforetag_derived,
        famansforetag_confirmed_by: fields.famansforetag_confirmed_by,
        famansforetag_confirmed_at: fields.famansforetag_confirmed_at,
        contact_name: fields.contact_name,
        contact_phone: fields.contact_phone,
        contact_email: fields.contact_email,
      })
  if (error) throw new Error(`ku31_filings write failed: ${error.message}`)
  const saved = await loadKu31Settings(ctx, year)
  return { ok: true, data: saved! }
}

/** Field 570 per recipient: kept per year, new recipients numbered after the highest. */
async function specificationNumbers(ctx: OperationContext, year: number, partyIds: readonly string[]): Promise<Map<string, number>> {
  const read = async () => {
    const { data, error } = await ctx.supabase
      .from('ku31_specification_numbers')
      .select('party_id, specification_number')
      .eq('company_id', ctx.companyId)
      .eq('income_year', year)
    if (error) throw new Error(`ku31_specification_numbers read failed: ${error.message}`)
    return new Map(((data ?? []) as Array<{ party_id: string; specification_number: number | string }>).map((r) => [r.party_id, Number(r.specification_number)]))
  }
  const existing = await read()
  const missing = partyIds.filter((id) => !existing.has(id))
  if (missing.length > 0) {
    let next = Math.max(0, ...existing.values()) + 1
    for (const partyId of missing) {
      const { error } = await ctx.supabase
        .from('ku31_specification_numbers')
        .insert({ company_id: ctx.companyId, income_year: year, party_id: partyId, specification_number: next })
      // A concurrent download numbered them first: read what it wrote.
      if (error?.code === '23505') break
      if (error) throw new Error(`ku31_specification_numbers insert failed: ${error.message}`)
      next += 1
    }
    return read()
  }
  return existing
}

export interface KuRecipientIdentity {
  /** 12 digits: personnummer or samordningsnummer with century. */
  identity: string
  first_name: string | null
  last_name: string | null
  street: string | null
  postal_code: string | null
  city: string | null
}

/**
 * A recipient as a Kontrolluppgifter file (KU31, KU20) names them: the
 * 12-digit personnummer, the name split in two and the postal address.
 * Null when no readable personnummer is on file.
 */
export function kuRecipientIdentity(
  partyId: string,
  name: string,
  personnummer: ReadonlyMap<string, string>,
  parties: ReadonlyMap<string, RegisterParty>,
): KuRecipientIdentity | null {
  const pnr = personnummer.get(partyId)
  if (!pnr) return null
  const split = splitName(name)
  const address = parties.get(partyId)?.address ?? null
  return {
    identity: pnr.replace('-', ''),
    first_name: split.first,
    last_name: split.last,
    street: address?.line1 ?? null,
    postal_code: address?.postal_code?.replace(/\s+/g, '') ?? null,
    city: address?.city ?? null,
  }
}

/** The refusal when a recipient's personnummer does not read (KU31 or KU20). */
export function unreadablePersonnummer(form: 'KU31' | 'KU20', r: { party_id: string; name: string }): Extract<OperationOutcome<never>, { ok: false }> {
  return {
    ok: false,
    code: `${form}_NOT_READY`,
    details: { blockers: [{ code: `${form}_PERSONNUMMER_MISSING`, party_id: r.party_id }] },
    messageSv: `${r.name || 'En mottagare'} saknar ett läsbart personnummer. Ange det igen under Bolaget, Ägare och aktiebok.`,
  }
}

/** First and last name from a display name: the last word is the surname. Null when there is only one word. */
export function splitName(name: string): { first: string | null; last: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return { first: null, last: null }
  return { first: parts.slice(0, -1).join(' ').slice(0, 50), last: parts[parts.length - 1]!.slice(0, 50) }
}

/** "YYYY-MM-DDTHH:MM:SS" in Swedish time. */
export function stockholmTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

export interface Ku31File {
  filename: string
  xml: string
  recipients: number
  total_reported: number
}

/**
 * The KU31 file for a year, for an owner or administrator only (it carries
 * full personnummer). Refused while anything blocks it; the refusal lists
 * the blockers.
 */
export async function generateKu31File(ctx: OperationContext, year: number): Promise<OperationOutcome<Ku31File>> {
  const forbidden = await requireCompanyAdmin(ctx, 'Bara ägare och administratörer kan hämta KU31-filen: den innehåller personnummer.')
  if (forbidden) return forbidden
  const status = await loadKu31Status(ctx, year)
  if (!status.ready) {
    return { ok: false, code: 'KU31_NOT_READY', details: { blockers: status.blockers }, messageSv: status.blockers.map((b) => b.message_sv).join(' ') }
  }
  const reported = status.recipients.filter((r) => r.reported)
  const [company, specs, personnummer, parties] = await Promise.all([
    companyIdentity(ctx),
    specificationNumbers(ctx, year, reported.map((r) => r.party_id)),
    loadFullPersonnummer(ctx.companyId, reported.map((r) => r.party_id)),
    loadRegisterParties(ctx.companyId, reported.map((r) => r.party_id)),
  ])
  const settings = await loadKu31Settings(ctx, year)
  const recipients: Ku31Recipient[] = []
  for (const r of reported) {
    const who = kuRecipientIdentity(r.party_id, r.name, personnummer, parties)
    if (!who) return unreadablePersonnummer('KU31', r)
    recipients.push({ specification_number: specs.get(r.party_id)!, ...who, amount: r.reported_amount })
  }
  const input: Ku31FileInput = {
    income_year: year,
    payer_org_number: company.org_number ?? '',
    payer_name: company.name.slice(0, 50),
    share_name: `Aktier i ${company.name}`.slice(0, 50),
    famansforetag: settings?.famansforetag === true,
    contact: { name: settings?.contact_name ?? '', phone: settings?.contact_phone ?? '', email: settings?.contact_email ?? '' },
    created_at: stockholmTimestamp(),
    program_name: KU31_PROGRAM_NAME,
    recipients,
  }
  const issues = validateKu31File(input)
  if (issues.length > 0) {
    // Issues name the field and the specification number, never the personnummer.
    return { ok: false, code: 'KU31_NOT_READY', details: { blockers: issues.map(({ code, field, specification_number }) => ({ code, field, specification_number })) }, messageSv: issues.map((i) => i.message_sv).join(' ') }
  }
  const xml = buildKu31Xml(input)
  const { error } = await ctx.supabase
    .from('ku31_filings')
    .update({ last_generated_at: new Date().toISOString(), last_generated_by: ctx.userId })
    .eq('company_id', ctx.companyId)
    .eq('income_year', year)
  if (error) ctx.log.warn('[bolaget] ku31 generated but not stamped', { companyId: ctx.companyId, year, error: error.message })
  return {
    ok: true,
    data: {
      filename: `KU31_${year}_${company.org_number}.xml`,
      xml,
      recipients: recipients.length,
      total_reported: sumOre(recipients.map((r) => r.amount)),
    },
  }
}
