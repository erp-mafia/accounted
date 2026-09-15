import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type {
  AppointAssociationAuditorSchema,
  UpdateAssociationAuditorSchema,
} from '@/lib/api/schemas'
import { AssociationRegisterError } from '@/lib/associations/errors'
import {
  listContributions,
  memberCapitalReconciliation,
  memberRegisterExtract,
  type AssociationContributionRow,
  type MemberCapitalReconciliation,
  type MemberRegisterExtractRow,
} from '@/lib/associations/member-register'
import { activeAuditorsOn } from '@/lib/bokslut/arsredovisning/audit-dependency'
import type {
  AnnualReportProfile,
  AssociationAuditorKind,
  AssociationAuditorSummary,
} from '@/lib/bokslut/arsredovisning/compliance-types'
import { getAnnualReportProfile } from '@/lib/bokslut/arsredovisning/profile-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Revisor roster of an ekonomisk förening (EFL 2018:672 8 kap.).
 *
 * The association elects its revisor(s) at the stämma (8 kap. 8 §); the
 * assignment runs to the end of the first årsstämma after the year of
 * appointment unless the stadgar say otherwise and ends at the latest at
 * the årsstämma in the fourth financial year after the appointment (8 kap.
 * 24 §). An assignment that ends early (8 kap. 25 §) is dated, never
 * deleted: the roster the stämma elected stays readable for the audit trail
 * of every årsredovisning it signed.
 *
 * The signed revisionsberättelse itself is archived on the period's
 * compliance profile (annual_report_profiles); `buildAuditBundle` collects
 * what the revisor asks the board for: the roster, the profile's audit
 * facts, the medlemsförteckning, the förteckning over förlagsinsatser (EFL
 * 11 kap. 6 §) and the member-capital reconciliation against 2083/2087/2084.
 */

export interface AssociationAuditorRow {
  id: string
  company_id: string
  name: string
  kind: AssociationAuditorKind
  registration_reference: string | null
  appointed_on: string
  term_ends_on: string | null
  appointment_reference: string | null
  ended_on: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export async function listAuditors(
  supabase: SupabaseClient,
  companyId: string,
  options: { includeEnded?: boolean } = {},
): Promise<AssociationAuditorRow[]> {
  const rows = await fetchAllRows<AssociationAuditorRow>(
    ({ from, to }) => {
      let query = supabase
        .from('association_auditors')
        .select('id, company_id, name, kind, registration_reference, appointed_on, term_ends_on, appointment_reference, ended_on, notes, created_at, updated_at')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (!options.includeEnded) query = query.is('ended_on', null)
      return query
    },
    { dedupeBy: (row) => row.id },
  )
  rows.sort((a, b) => a.appointed_on.localeCompare(b.appointed_on) || a.name.localeCompare(b.name, 'sv'))
  return rows
}

/** The roster reduced to what the audit dependency evaluates, ended terms included. */
export async function listAuditorSummaries(
  supabase: SupabaseClient,
  companyId: string,
): Promise<AssociationAuditorSummary[]> {
  const rows = await listAuditors(supabase, companyId, { includeEnded: true })
  return rows.map(({ id, name, kind, appointed_on, term_ends_on, ended_on }) => ({
    id,
    name,
    kind,
    appointed_on,
    term_ends_on,
    ended_on,
  }))
}

export async function appointAuditor(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof AppointAssociationAuditorSchema>,
): Promise<AssociationAuditorRow> {
  const { data, error } = await supabase
    .from('association_auditors')
    .insert({
      company_id: companyId,
      user_id: userId,
      name: input.name,
      kind: input.kind,
      registration_reference: input.registration_reference ?? null,
      appointed_on: input.appointed_on,
      term_ends_on: input.term_ends_on ?? null,
      appointment_reference: input.appointment_reference ?? null,
      notes: input.notes ?? null,
    })
    .select('id, company_id, name, kind, registration_reference, appointed_on, term_ends_on, appointment_reference, ended_on, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as AssociationAuditorRow
}

/**
 * End the assignment (a date, EFL 8 kap. 24-25 §§) or correct the term and
 * references. An ended assignment cannot be ended again; its references can
 * still be corrected.
 */
export async function updateAuditor(
  supabase: SupabaseClient,
  companyId: string,
  auditorId: string,
  input: z.infer<typeof UpdateAssociationAuditorSchema>,
): Promise<AssociationAuditorRow> {
  const { data: existing, error: readError } = await supabase
    .from('association_auditors')
    .select('id, company_id, name, kind, registration_reference, appointed_on, term_ends_on, appointment_reference, ended_on, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', auditorId)
    .maybeSingle()
  if (readError) throw readError
  if (!existing) throw new AssociationRegisterError('ASSOCIATION_AUDITOR_NOT_FOUND')
  const current = existing as AssociationAuditorRow
  if (input.ended_on !== undefined && current.ended_on) {
    throw new AssociationRegisterError('ASSOCIATION_AUDITOR_ALREADY_ENDED')
  }

  const patch: Record<string, unknown> = {}
  if (input.ended_on !== undefined) patch.ended_on = input.ended_on
  if (input.term_ends_on !== undefined) patch.term_ends_on = input.term_ends_on
  if (input.registration_reference !== undefined) patch.registration_reference = input.registration_reference
  if (input.appointment_reference !== undefined) patch.appointment_reference = input.appointment_reference
  if (input.notes !== undefined) patch.notes = input.notes

  const { data, error } = await supabase
    .from('association_auditors')
    .update(patch)
    .eq('company_id', companyId)
    .eq('id', auditorId)
    .select('id, company_id, name, kind, registration_reference, appointed_on, term_ends_on, appointment_reference, ended_on, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as AssociationAuditorRow
}

/**
 * Check that a document the caller wants to archive as the revisions-
 * berättelse exists in this company's archive before the id is stored on
 * the profile; the FK alone would accept any company's document.
 */
export async function requireCompanyDocument(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new AssociationRegisterError('ASSOCIATION_AUDIT_DOCUMENT_NOT_FOUND')
}

export interface ForlagsinsatsRegisterRow {
  contribution_id: string
  member_id: string
  member_number: string
  holder_name: string
  units: number
  amount: number
  paid_on: string
  status: AssociationContributionRow['status']
  settled_on: string | null
}

export interface AuditBundle {
  generated_at: string
  fiscal_period_id: string
  auditors: {
    active_on_period_end: AssociationAuditorSummary[]
    all: AssociationAuditorRow[]
  }
  audit_facts: Pick<
    AnnualReportProfile,
    | 'auditor_report_required'
    | 'auditor_report_included'
    | 'auditor_report_signed_on'
    | 'auditor_report_opinion'
    | 'auditor_report_deviations'
    | 'auditor_report_document_id'
  >
  member_register: MemberRegisterExtractRow[]
  forlagsinsats_register: ForlagsinsatsRegisterRow[]
  member_capital_reconciliation: MemberCapitalReconciliation
}

/**
 * Everything the revisor asks the board for in one read: roster, the
 * archived-report facts for the period, the two statutory registers and the
 * reconciliation of the register against the ledger. Nothing here is
 * derived from anything the revisor would have to trust blindly: the
 * reconciliation shows the ledger balances next to the register sums.
 */
export async function buildAuditBundle(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  periodEndIso: string,
): Promise<AuditBundle> {
  const [auditors, profile, register, contributions, reconciliation] = await Promise.all([
    listAuditors(supabase, companyId, { includeEnded: true }),
    getAnnualReportProfile(supabase, companyId, fiscalPeriodId),
    memberRegisterExtract(supabase, companyId),
    listContributions(supabase, companyId),
    memberCapitalReconciliation(supabase, companyId, fiscalPeriodId),
  ])
  const { data: members, error } = await supabase
    .from('association_members')
    .select('id, member_number, name')
    .eq('company_id', companyId)
  if (error) throw error
  const holders = new Map(
    ((members ?? []) as Array<{ id: string; member_number: string; name: string }>).map((m) => [m.id, m]),
  )
  const forlags: ForlagsinsatsRegisterRow[] = contributions
    .filter((c) => c.kind === 'forlags')
    .map((c) => {
      const holder = holders.get(c.member_id)
      return {
        contribution_id: c.id,
        member_id: c.member_id,
        member_number: holder?.member_number ?? '',
        holder_name: holder?.name ?? '',
        units: c.units,
        amount: Number(c.amount),
        paid_on: c.paid_on,
        status: c.status,
        settled_on: c.settled_on,
      }
    })
    .sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.contribution_id.localeCompare(b.contribution_id))
  const summaries: AssociationAuditorSummary[] = auditors.map(
    ({ id, name, kind, appointed_on, term_ends_on, ended_on }) => ({
      id,
      name,
      kind,
      appointed_on,
      term_ends_on,
      ended_on,
    }),
  )
  return {
    generated_at: new Date().toISOString(),
    fiscal_period_id: fiscalPeriodId,
    auditors: { active_on_period_end: activeAuditorsOn(summaries, periodEndIso), all: auditors },
    audit_facts: {
      auditor_report_required: profile.auditor_report_required,
      auditor_report_included: profile.auditor_report_included,
      auditor_report_signed_on: profile.auditor_report_signed_on,
      auditor_report_opinion: profile.auditor_report_opinion,
      auditor_report_deviations: profile.auditor_report_deviations,
      auditor_report_document_id: profile.auditor_report_document_id,
    },
    member_register: register,
    forlagsinsats_register: forlags,
    member_capital_reconciliation: reconciliation,
  }
}

function csvEscape(value: string | number | null | boolean): string {
  const text = value === null ? '' : String(value)
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvSection(title: string, header: string[], rows: Array<Array<string | number | null | boolean>>): string {
  return [
    `# ${title}`,
    header.join(';'),
    ...rows.map((row) => row.map(csvEscape).join(';')),
    '',
  ].join('\n')
}

/**
 * One semicolon-separated file with a `# heading` line per section: the
 * roster, the audit facts, the medlemsförteckning, the förlagsinsats
 * register and the reconciliation. Excel opens it as one sheet; the revisor
 * gets one attachment instead of five.
 */
export function auditBundleCsv(bundle: AuditBundle): string {
  const auditors = csvSection(
    'Revisorer',
    ['Namn', 'Slag', 'Registreringsreferens', 'Vald', 'Mandat till', 'Uppdrag avslutat', 'Uppdragsreferens'],
    bundle.auditors.all.map((a) => [
      a.name,
      a.kind,
      a.registration_reference,
      a.appointed_on,
      a.term_ends_on,
      a.ended_on,
      a.appointment_reference,
    ]),
  )
  const facts = csvSection(
    'Revisionsberättelse',
    ['Krävs', 'Inkluderad', 'Undertecknad', 'Uttalande', 'Avvikelser', 'Dokument'],
    [[
      bundle.audit_facts.auditor_report_required,
      bundle.audit_facts.auditor_report_included,
      bundle.audit_facts.auditor_report_signed_on,
      bundle.audit_facts.auditor_report_opinion,
      bundle.audit_facts.auditor_report_deviations,
      bundle.audit_facts.auditor_report_document_id,
    ]],
  )
  const members = csvSection(
    'Medlemsförteckning',
    ['Medlemsnummer', 'Namn', 'Postadress', 'Inträde', 'Utträde', 'Antal insatser', 'Insatsbelopp', 'Förlagsinsatser'],
    bundle.member_register.map((r) => [
      r.member_number,
      r.name,
      r.postal_address,
      r.admitted_on,
      r.exited_on,
      r.contribution_units,
      r.contribution_amount,
      r.forlagsinsats_amount,
    ]),
  )
  const forlags = csvSection(
    'Förteckning över förlagsinsatser',
    ['Medlemsnummer', 'Innehavare', 'Antal', 'Belopp', 'Inbetald', 'Status', 'Inlöst'],
    bundle.forlagsinsats_register.map((r) => [
      r.member_number,
      r.holder_name,
      r.units,
      r.amount,
      r.paid_on,
      r.status,
      r.settled_on,
    ]),
  )
  const reconciliation = csvSection(
    'Avstämning medlemskapital',
    ['Post', 'Konton', 'Register', 'Huvudbok', 'Differens'],
    bundle.member_capital_reconciliation.lines.map((l) => [
      l.label,
      l.accounts.join(','),
      l.register_amount,
      l.ledger_balance,
      l.difference,
    ]),
  )
  return [auditors, facts, members, forlags, reconciliation].join('\n')
}
