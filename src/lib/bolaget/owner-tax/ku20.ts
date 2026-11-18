/**
 * KU20 per inkomstår from the owner loan register: the interest the
 * company paid to natural persons on loans they gave it (SFL 17:1-3;
 * Skatteverket's KU20 guidance: interest on a delägare's loan is reported
 * in field 503, field 061 marked; a fåmansföretag withholds 30 % tax, field
 * 001, SFL 10:15). One kontrolluppgift per recipient, the year's interest
 * on all their loans summed first.
 *
 * Interest to a legal person gets no KU20. The file is the Kontrolluppgifter
 * schema 12.0 (inkomstår 2026), downloaded by an owner or administrator
 * only: personnummer are read and decrypted here and nowhere else. The
 * contact person is the one the company gave for KU31 the same year.
 */
import { sumOre, roundOre, truncateToWholeKronor } from '@/lib/money'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { companyIdentity, KU31_PROGRAM_NAME, kuRecipientIdentity, loadKu31Settings, stockholmTimestamp, unreadablePersonnummer } from '../capital/ku31'
import { loadFullPersonnummer, loadRegisterParties } from '../people'
import { loadInsiderTimeline } from './insiders'
import { buildKu20Xml, KU20_INCOME_YEAR, validateKu20File, type Ku20FileInput, type Ku20Recipient } from './ku20-xml'
import { famansForYear, loadLoanInterest, loadOwnerLoans, OWNER_INTEREST_WITHHOLDING } from './loans'

export interface Ku20RecipientView {
  party_id: string
  name: string
  /** Masked personnummer; never the full one. */
  identity: string | null
  interest: number
  tax_withheld: number
  /** Fields 503 and 001: whole kronor, öre dropped. */
  reported_interest: number
  reported_tax: number
  /** Field 061: a delägare in a fåmansföretag, or a närstående. */
  delagare: boolean
  /** 30 % of the interest when the company is a fåmansföretag and the recipient a delägare; null otherwise. */
  expected_tax: number | null
  reason: 'personnummer_missing' | null
}

export interface Ku20Blocker {
  code: string
  message_sv: string
  party_id?: string
}

export interface Ku20Status {
  income_year: number
  deadline: string
  file_supported: boolean
  famansforetag: { value: boolean; confirmed: boolean }
  recipients: Ku20RecipientView[]
  /** Interest to companies in the year: no KU20. */
  legal_person_interest: number
  contact: { name: string | null; phone: string | null; email: string | null }
  blockers: Ku20Blocker[]
  warnings: Ku20Blocker[]
  ready: boolean
}

export async function loadKu20Status(ctx: OperationContext, year: number): Promise<Ku20Status> {
  const [loans, interest, famans, settings, timeline] = await Promise.all([
    loadOwnerLoans(ctx.supabase, ctx.companyId),
    loadLoanInterest(ctx.supabase, ctx.companyId, year),
    famansForYear(ctx, year),
    loadKu31Settings(ctx, year),
    loadInsiderTimeline(ctx),
  ])
  const loanById = new Map(loans.map((l) => [l.id, l]))
  const totals = new Map<string, { interest: number; tax: number; related: boolean }>()
  for (const row of interest) {
    const loan = loanById.get(row.owner_loan_id)
    if (!loan || loan.direction !== 'borrows' || loan.status === 'cancelled' || row.interest_amount <= 0) continue
    const t = totals.get(loan.party_id) ?? { interest: 0, tax: 0, related: false }
    t.interest = roundOre(t.interest + row.interest_amount)
    t.tax = roundOre(t.tax + row.tax_withheld)
    t.related = t.related || loan.relation === 'related_person'
    totals.set(loan.party_id, t)
  }
  const parties = await loadRegisterParties(ctx.companyId, [...totals.keys()])
  const start = timeline(`${year}-01-01`)
  const end = timeline(`${year}-12-31`)

  const recipients: Ku20RecipientView[] = []
  let legalPersonInterest = 0
  for (const [partyId, t] of totals) {
    const p = parties.get(partyId)
    if (p?.kind === 'company') {
      legalPersonInterest = roundOre(legalPersonInterest + t.interest)
      continue
    }
    const delagare = famans.famansforetag && (start.holders.has(partyId) || end.holders.has(partyId) || t.related)
    recipients.push({
      party_id: partyId,
      name: p?.name ?? '',
      identity: p?.personnummer_masked ?? null,
      interest: t.interest,
      tax_withheld: t.tax,
      reported_interest: truncateToWholeKronor(t.interest),
      reported_tax: truncateToWholeKronor(t.tax),
      delagare,
      expected_tax: delagare ? roundOre(t.interest * OWNER_INTEREST_WITHHOLDING) : null,
      reason: p?.personnummer_masked ? null : 'personnummer_missing',
    })
  }
  recipients.sort((a, b) => b.interest - a.interest || a.name.localeCompare(b.name, 'sv'))

  const blockers: Ku20Blocker[] = []
  const warnings: Ku20Blocker[] = []
  const fileSupported = year === KU20_INCOME_YEAR
  if (!fileSupported) {
    blockers.push({ code: 'KU20_SCHEMA_YEAR', message_sv: `Filen kan skapas för inkomstår ${KU20_INCOME_YEAR} (Skatteverkets schema 12.0). Lämna kontrolluppgifter för ${year} i Skatteverkets e-tjänst.` })
  }
  if (recipients.length === 0) {
    blockers.push({ code: 'KU20_NO_RECIPIENTS', message_sv: `Ingen ränta till fysiska personer är registrerad för ${year}. Registrera årets ränta på lånen från ägare och närstående.` })
  }
  for (const r of recipients) {
    if (r.reason === 'personnummer_missing') {
      blockers.push({ code: 'KU20_PERSONNUMMER_MISSING', party_id: r.party_id, message_sv: `${r.name || 'En mottagare'} saknar personnummer. Lägg till det under Bolaget, Aktiebok (personens uppgifter).` })
    }
    if (r.expected_tax !== null && r.tax_withheld !== r.expected_tax) {
      warnings.push({ code: 'KU20_WITHHOLDING_EXPECTED', party_id: r.party_id, message_sv: `${r.name}: ett fåmansföretag gör skatteavdrag med 30 % på ränta till en delägare (${r.expected_tax} kr), registrerat är ${r.tax_withheld} kr.` })
    }
  }
  if (!famans.confirmed) {
    warnings.push({ code: 'KU20_FAMANS_UNCONFIRMED', message_sv: `Om bolaget är ett fåmansföretag ${year} är inte bekräftat; aktieboken tyder på att det ${famans.famansforetag ? 'är' : 'inte är'} det. Svara under Kapital och utdelning, KU31.` })
  }
  if (!settings?.contact_name || !settings.contact_phone || !settings.contact_email) {
    blockers.push({ code: 'KU20_CONTACT_MISSING', message_sv: 'Ange kontaktperson med namn, telefon och e-post under Kapital och utdelning, KU31 (samma kontaktperson gäller KU20).' })
  }
  const company = await companyIdentity(ctx)
  if (!company.org_number) blockers.push({ code: 'KU20_PAYER_ORG_NUMBER', message_sv: 'Bolagets organisationsnummer saknas. Ange det under Inställningar, Företag.' })

  return {
    income_year: year,
    deadline: `${year + 1}-01-31`,
    file_supported: fileSupported,
    famansforetag: { value: famans.famansforetag, confirmed: famans.confirmed },
    recipients,
    legal_person_interest: legalPersonInterest,
    contact: { name: settings?.contact_name ?? null, phone: settings?.contact_phone ?? null, email: settings?.contact_email ?? null },
    blockers,
    warnings,
    ready: blockers.length === 0,
  }
}

/** Field 570 per recipient: kept per year, new recipients numbered after the highest. */
async function specificationNumbers(ctx: OperationContext, year: number, partyIds: readonly string[]): Promise<Map<string, number>> {
  const read = async () => {
    const { data, error } = await ctx.supabase
      .from('ku20_specification_numbers')
      .select('party_id, specification_number')
      .eq('company_id', ctx.companyId)
      .eq('income_year', year)
    if (error) throw new Error(`ku20_specification_numbers read failed: ${error.message}`)
    return new Map(((data ?? []) as Array<{ party_id: string; specification_number: number | string }>).map((r) => [r.party_id, Number(r.specification_number)]))
  }
  const existing = await read()
  const missing = partyIds.filter((id) => !existing.has(id))
  if (missing.length === 0) return existing
  let next = Math.max(0, ...existing.values()) + 1
  for (const partyId of missing) {
    const { error } = await ctx.supabase
      .from('ku20_specification_numbers')
      .insert({ company_id: ctx.companyId, income_year: year, party_id: partyId, specification_number: next })
    // A concurrent download numbered them first: read what it wrote.
    if (error?.code === '23505') break
    if (error) throw new Error(`ku20_specification_numbers insert failed: ${error.message}`)
    next += 1
  }
  return read()
}

export interface Ku20File {
  filename: string
  xml: string
  recipients: number
  total_reported: number
}

/** The KU20 file for a year, for an owner or administrator only (it carries full personnummer). */
export async function generateKu20File(ctx: OperationContext, year: number): Promise<OperationOutcome<Ku20File>> {
  const forbidden = await requireCompanyAdmin(ctx, 'Bara ägare och administratörer kan hämta KU20-filen: den innehåller personnummer.')
  if (forbidden) return forbidden
  const status = await loadKu20Status(ctx, year)
  if (!status.ready) {
    return { ok: false, code: 'KU20_NOT_READY', details: { blockers: status.blockers }, messageSv: status.blockers.map((b) => b.message_sv).join(' ') }
  }
  const ids = status.recipients.map((r) => r.party_id)
  const [company, specs, personnummer, parties] = await Promise.all([
    companyIdentity(ctx),
    specificationNumbers(ctx, year, ids),
    loadFullPersonnummer(ctx.companyId, ids),
    loadRegisterParties(ctx.companyId, ids),
  ])
  const recipients: Ku20Recipient[] = []
  for (const r of status.recipients) {
    const who = kuRecipientIdentity(r.party_id, r.name, personnummer, parties)
    if (!who) return unreadablePersonnummer('KU20', r)
    recipients.push({ specification_number: specs.get(r.party_id)!, ...who, interest: r.reported_interest, tax_withheld: r.reported_tax, delagare: r.delagare })
  }
  const input: Ku20FileInput = {
    income_year: year,
    payer_org_number: company.org_number ?? '',
    payer_name: company.name.slice(0, 50),
    contact: { name: status.contact.name ?? '', phone: status.contact.phone ?? '', email: status.contact.email ?? '' },
    created_at: stockholmTimestamp(),
    program_name: KU31_PROGRAM_NAME,
    recipients,
  }
  const issues = validateKu20File(input)
  if (issues.length > 0) {
    // Issues name the field and the specification number, never the personnummer.
    return { ok: false, code: 'KU20_NOT_READY', details: { blockers: issues.map(({ code, field, specification_number }) => ({ code, field, specification_number })) }, messageSv: issues.map((i) => i.message_sv).join(' ') }
  }
  return {
    ok: true,
    data: {
      filename: `KU20_${year}_${company.org_number}.xml`,
      xml: buildKu20Xml(input),
      recipients: recipients.length,
      total_reported: sumOre(recipients.map((r) => r.interest)),
    },
  }
}
