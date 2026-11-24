/**
 * The agenda a new meeting starts with. An årsstämma is prefilled from the
 * company's own records (ABL 7:11): the årsredovisning for the fiscal year
 * (the latest version, else the narrative: the board's proposal and the
 * proposed dividend), discharge for every board member and VD in office
 * during the year, re-election of the board and the revisor in office on
 * the meeting day, and fees. Other meetings get the procedural items only.
 *
 * Texts stay empty: the minutes compose each sentence from the terms
 * (./minutes-text.ts), so editing the terms edits the minutes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext } from '@/lib/operations/types'
import { loadRoles } from '../roles'
import { loadShareRegisterData } from '../share-register'
import { BOARD_MEMBER_ROLES, type CompanyRoleKind } from '../types'
import { AUDITOR_ELECTION_ROLES, BOARD_ELECTION_ROLES, type DecisionPayloads } from './payloads'
import { dividendPerShare, heldDuring } from './rules'
import { proposalTextWithoutAmounts } from '@/lib/bokslut/arsredovisning/disposition-text'
import type { DecisionKind, MeetingKind, MeetingOrgan } from './types'

export interface DecisionDraft {
  kind: DecisionKind
  title: string
  text: string | null
  payload: Record<string, unknown>
}

export interface ArsstammaTemplateInput {
  fiscalPeriod: { id: string; period_start: string; period_end: string }
  annualReport: {
    versionId: string | null
    resultatdisposition: string | null
    proposedDividend: number
    /** Fritt eget kapital at the stämma's disposal and what is carried forward; null without a version. */
    amounts: { total: number; carried_forward: number } | null
  } | null
  board: Array<{ party_id: string; name: string; role: (typeof BOARD_ELECTION_ROLES)[number] }>
  auditors: Array<{ party_id: string; name: string; kind: 'person' | 'company'; org_number: string | null; role: (typeof AUDITOR_ELECTION_ROLES)[number] }>
  discharge: Array<{ party_id: string; name: string; roles: CompanyRoleKind[] }>
  totalShares: number
}

function procedural(topic: string, title: string): DecisionDraft {
  return { kind: 'ovrigt', title, text: null, payload: { topic } }
}

const TERM = 'intill slutet av nästa årsstämma'

/** The årsstämma's agenda, prefilled. Pure. */
export function buildArsstammaTemplate(input: ArsstammaTemplateInput): DecisionDraft[] {
  const fp = input.fiscalPeriod.id
  const hasAuditor = input.auditors.some((a) => a.role !== 'revisorssuppleant')
  const dividend = input.annualReport?.proposedDividend ?? 0
  const out: DecisionDraft[] = [
    procedural('oppnande', 'Stämmans öppnande'),
    procedural('val_ordforande', 'Val av ordförande och protokollförare vid stämman'),
    procedural('rostlangd', 'Upprättande och godkännande av röstlängd'),
    procedural('val_justerare', 'Val av justeringsperson'),
    procedural('kallelse', 'Prövning av om stämman blivit behörigen sammankallad'),
    procedural('dagordning', 'Godkännande av dagordning'),
    procedural('framlaggande', hasAuditor ? 'Framläggande av årsredovisningen och revisionsberättelsen' : 'Framläggande av årsredovisningen'),
    {
      kind: 'faststallande_rr_br',
      title: 'Fastställande av resultaträkningen och balansräkningen',
      text: null,
      payload: { fiscal_period_id: fp, annual_report_version_id: input.annualReport?.versionId ?? null } satisfies DecisionPayloads['faststallande_rr_br'],
    },
    {
      kind: 'resultatdisposition',
      title: 'Dispositioner beträffande bolagets vinst eller förlust enligt den fastställda balansräkningen',
      text: null,
      payload: {
        fiscal_period_id: fp,
        follows_board_proposal: true,
        available_amount: input.annualReport?.amounts?.total ?? null,
        dividend_total: dividend > 0 ? dividend : null,
        carried_forward: input.annualReport?.amounts?.carried_forward ?? null,
        board_proposal_text: input.annualReport?.resultatdisposition ?? null,
      } satisfies DecisionPayloads['resultatdisposition'],
    },
  ]
  if (dividend > 0 && input.totalShares > 0) {
    const { per_share } = dividendPerShare(dividend, input.totalShares)
    out.push({
      kind: 'utdelning',
      title: 'Utdelning',
      text: null,
      payload: {
        amount_per_share: per_share,
        share_count: input.totalShares,
        total_amount: dividend,
        payment_date: null,
        share_class_code: null,
        fiscal_period_id: fp,
      } satisfies DecisionPayloads['utdelning'],
    })
  }
  out.push(
    {
      kind: 'ansvarsfrihet',
      title: 'Ansvarsfrihet för styrelseledamöterna och den verkställande direktören',
      text: null,
      payload: {
        fiscal_period_id: fp,
        persons: input.discharge.map((p) => ({ party_id: p.party_id, name: p.name, roles: p.roles, granted: true })),
      } satisfies DecisionPayloads['ansvarsfrihet'],
    },
    {
      kind: 'arvoden',
      title: hasAuditor ? 'Arvoden åt styrelsen och revisorn' : 'Arvoden åt styrelsen',
      text: null,
      payload: { board_fees: [], board_fee_total: null, auditor_fee: hasAuditor ? 'enligt godkänd räkning' : null } satisfies DecisionPayloads['arvoden'],
    },
    {
      kind: 'val_styrelse',
      title: input.board.some((b) => b.role === 'styrelsesuppleant') ? 'Val av styrelse och styrelsesuppleant' : 'Val av styrelse',
      text: null,
      payload: {
        members: input.board.map((b) => ({ party_id: b.party_id, name: b.name, role: b.role })),
        term: TERM,
      } satisfies DecisionPayloads['val_styrelse'],
    },
  )
  if (input.auditors.length > 0) {
    out.push({
      kind: 'val_revisor',
      title: 'Val av revisor',
      text: null,
      payload: {
        auditors: input.auditors.map((a) => ({ party_id: a.party_id, name: a.name, kind: a.kind, org_number: a.org_number, role: a.role })),
        term: TERM,
        no_auditor: false,
      } satisfies DecisionPayloads['val_revisor'],
    })
  }
  out.push(procedural('avslutande', 'Stämmans avslutande'))
  return out
}

/** The procedural items of an extra stämma or a board meeting. A per capsulam decision has none. */
export function buildProceduralTemplate(kind: MeetingKind, organ: MeetingOrgan): DecisionDraft[] {
  if (kind === 'per_capsulam') return []
  if (organ === 'styrelse') {
    return [
      procedural('oppnande', 'Mötets öppnande'),
      procedural('val_justerare', 'Val av justerare'),
      procedural('dagordning', 'Godkännande av dagordning'),
      procedural('avslutande', 'Mötets avslutande'),
    ]
  }
  return [
    procedural('oppnande', 'Stämmans öppnande'),
    procedural('val_ordforande', 'Val av ordförande och protokollförare vid stämman'),
    procedural('rostlangd', 'Upprättande och godkännande av röstlängd'),
    procedural('val_justerare', 'Val av justeringsperson'),
    procedural('kallelse', 'Prövning av om stämman blivit behörigen sammankallad'),
    procedural('dagordning', 'Godkännande av dagordning'),
    procedural('avslutande', 'Stämmans avslutande'),
  ]
}

interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
}

/** The fiscal year of the company, or null when it is not the company's. */
export async function loadFiscalPeriod(supabase: SupabaseClient, companyId: string, id: string): Promise<FiscalPeriodRow | null> {
  const { data, error } = await supabase.from('fiscal_periods').select('id, period_start, period_end').eq('company_id', companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(`fiscal_periods read failed: ${error.message}`)
  return (data as FiscalPeriodRow | null) ?? null
}

interface ForvaltningsberattelseSlice {
  resultatdisposition?: string | null
  proposed_dividend?: number | null
  resultatdisposition_amounts?: { total?: number; carried_forward?: number } | null
}

/**
 * The board's proposal for the year: from the latest årsredovisning version
 * that is not superseded (its report_data is what the board signed), else
 * from the narrative (the proposal and dividend the user entered).
 */
export async function loadAnnualReportProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<ArsstammaTemplateInput['annualReport']> {
  const { data: versions, error } = await supabase
    .from('annual_report_versions')
    .select('id, version_number, status, report_data')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .neq('status', 'superseded')
    .order('version_number', { ascending: false })
    .limit(1)
  if (error) throw new Error(`annual_report_versions read failed: ${error.message}`)
  const version = ((versions ?? []) as Array<{ id: string; report_data: { forvaltningsberattelse?: ForvaltningsberattelseSlice } | null }>)[0]
  const fb = version?.report_data?.forvaltningsberattelse
  if (version && fb) {
    const amounts = fb.resultatdisposition_amounts
    return {
      versionId: version.id,
      resultatdisposition: fb.resultatdisposition ?? null,
      proposedDividend: Number(fb.proposed_dividend ?? 0),
      amounts:
        amounts && typeof amounts.total === 'number' && typeof amounts.carried_forward === 'number'
          ? { total: amounts.total, carried_forward: amounts.carried_forward }
          : null,
    }
  }
  const { data: narrative, error: narrativeError } = await supabase
    .from('arsredovisning_narratives')
    .select('resultatdisposition, proposed_dividend')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (narrativeError) throw new Error(`arsredovisning_narratives read failed: ${narrativeError.message}`)
  if (!narrative) return null
  const row = narrative as { resultatdisposition: string | null; proposed_dividend: number | string | null }
  const proposedDividend = Number(row.proposed_dividend ?? 0)
  return {
    versionId: null,
    resultatdisposition: proposalTextWithoutAmounts(row.resultatdisposition, proposedDividend),
    proposedDividend,
    amounts: null,
  }
}

/** Everything the årsstämma template reads, loaded for one fiscal year and meeting day. */
export async function loadArsstammaTemplateInput(
  ctx: OperationContext,
  fiscalPeriod: FiscalPeriodRow,
  meetingDate: string,
): Promise<ArsstammaTemplateInput> {
  const [annualReport, roles, register] = await Promise.all([
    loadAnnualReportProposal(ctx.supabase, ctx.companyId, fiscalPeriod.id),
    loadRoles(ctx, meetingDate),
    loadShareRegisterData(ctx, meetingDate),
  ])
  const name = (r: { party: { name: string } | null }) => r.party?.name ?? 'okänd'
  const board = roles.roles
    .filter((r) => r.active && (BOARD_ELECTION_ROLES as readonly string[]).includes(r.role))
    .map((r) => ({ party_id: r.party_id, name: name(r), role: r.role as (typeof BOARD_ELECTION_ROLES)[number] }))
  const auditors = roles.roles
    .filter((r) => r.active && (AUDITOR_ELECTION_ROLES as readonly string[]).includes(r.role))
    .map((r) => ({
      party_id: r.party_id,
      name: name(r),
      kind: r.party?.kind ?? 'person',
      org_number: r.party?.org_number ?? null,
      role: r.role as (typeof AUDITOR_ELECTION_ROLES)[number],
    }))
  // ABL 7:11 p. 3: discharge for the board members and the VD who served during the year.
  const dischargeRoles: readonly CompanyRoleKind[] = [...BOARD_MEMBER_ROLES, 'vd']
  const discharge = new Map<string, { party_id: string; name: string; roles: CompanyRoleKind[] }>()
  for (const r of roles.roles) {
    if (!dischargeRoles.includes(r.role) || !heldDuring(r, fiscalPeriod.period_start, fiscalPeriod.period_end)) continue
    const entry = discharge.get(r.party_id) ?? { party_id: r.party_id, name: name(r), roles: [] }
    if (!entry.roles.includes(r.role)) entry.roles.push(r.role)
    discharge.set(r.party_id, entry)
  }
  return {
    fiscalPeriod,
    annualReport,
    board,
    auditors,
    discharge: [...discharge.values()],
    totalShares: register.summary.total_shares,
  }
}
