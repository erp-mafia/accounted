/**
 * Uppskjuten skatt for one K3 fiscal year (BFNAR 2012:1 kap. 29): the
 * user's inputs, the proposal the year-end wizard shows, the posting, and the
 * movements the K3 note on uppskjuten skatt reads. The arithmetic is in
 * deferred-tax.ts.
 *
 * The temporary differences:
 *   - a tax loss carried forward (the year's closing underskott from the
 *     bolagsskatt computation), only when the user has judged it
 *     recoverable and said why (29.29: convincing factors after losses);
 *   - temporary differences entered by hand (an item whose book and tax
 *     values differ that the register does not compute).
 *   - buildings and markanläggningar with a tax plan: their carrying amount
 *     against their tax value on that plan (IL 19-20 kap.,
 *     building-tax.ts).
 *
 * K3 years only: a K2 company books no deferred tax (K2 has no kap. 29), so
 * a K2 year gets no proposal and the posting refuses one.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { frameworkForYear } from '@/lib/bokslut/framework-for-year'
import { yearEndDispositionBusinessEvent } from '@/lib/bokslut/dispositions-business-event'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { codedRefusal } from '@/lib/errors/refusal'
import { roundOre } from '@/lib/money'
import type { ProposedDisposition } from '../types'
import { BOLAGSSKATT_RATE } from './bolagsskatt-calculator'
import {
  closingDeferredTax,
  DEFERRED_TAX_ASSET_ACCOUNT,
  DEFERRED_TAX_LIABILITY_ACCOUNT,
  deferredTaxItem,
  deferredTaxPosting,
  lossCarryforwardDifference,
  type DeferredTaxBalances,
  type DeferredTaxItem,
  type DeferredTaxKind,
  type TemporaryDifferenceInput,
} from './deferred-tax'
import { loadBuildingTemporaryDifferences } from '@/lib/bokslut/assets/building-tax-service'
import type { JournalEntry } from '@/types'

export const ManualDifferenceSchema = z.object({
  label: z.string().trim().min(1).max(200),
  nature: z.enum(['asset', 'liability']),
  carrying_amount: z.number().min(-1_000_000_000_000).max(1_000_000_000_000),
  tax_value: z.number().min(-1_000_000_000_000).max(1_000_000_000_000),
})

export type ManualDifference = z.infer<typeof ManualDifferenceSchema>

/** The inputs' fields, for a schema that adds its own (an operation's fiscal_period_id). */
export const DeferredTaxAssessmentFields = z.object({
  loss_recognised: z.boolean(),
  loss_reason: z.string().trim().max(2000).nullable().optional(),
  manual_items: z.array(ManualDifferenceSchema).max(100),
})

/** A recognised loss carried forward needs the 29.29 judgement written down. */
export function requireLossReason(
  value: { loss_recognised: boolean; loss_reason?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.loss_recognised && !value.loss_reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loss_reason'],
      message: 'Beskriv vad som övertygande talar för att underskottet kan utnyttjas (K3 29.29).',
    })
  }
}

export const DeferredTaxAssessmentSchema = DeferredTaxAssessmentFields.superRefine(requireLossReason)

export type DeferredTaxAssessmentInput = z.infer<typeof DeferredTaxAssessmentSchema>

export interface DeferredTaxAssessment {
  loss_recognised: boolean
  loss_reason: string | null
  manual_items: ManualDifference[]
}

const EMPTY_ASSESSMENT: DeferredTaxAssessment = { loss_recognised: false, loss_reason: null, manual_items: [] }

export class DeferredTaxNotApplicableError extends Error {
  readonly code = 'DEFERRED_TAX_NOT_APPLICABLE'
  constructor() {
    super('DEFERRED_TAX_NOT_APPLICABLE')
    this.name = 'DeferredTaxNotApplicableError'
  }
}

/** The year's inputs, and whether the user has saved any for the year. */
async function readAssessment(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<{ assessment: DeferredTaxAssessment; saved: boolean }> {
  const { data, error } = await supabase
    .from('deferred_tax_assessments')
    .select('loss_recognised, loss_reason, manual_items')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa underlaget för uppskjuten skatt: ${error.message}`)
  if (!data) return { assessment: EMPTY_ASSESSMENT, saved: false }
  const row = data as { loss_recognised: boolean; loss_reason: string | null; manual_items: unknown }
  const parsed = z.array(ManualDifferenceSchema).safeParse(row.manual_items)
  return {
    assessment: {
      loss_recognised: row.loss_recognised,
      loss_reason: row.loss_reason,
      manual_items: parsed.success ? parsed.data : [],
    },
    saved: true,
  }
}

export async function loadDeferredTaxAssessment(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DeferredTaxAssessment> {
  return (await readAssessment(supabase, companyId, fiscalPeriodId)).assessment
}

export async function saveDeferredTaxAssessment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: DeferredTaxAssessmentInput,
  /** dryRun: the same checks; answers the inputs as they would be saved. */
  options: { dryRun?: boolean } = {},
): Promise<DeferredTaxAssessment> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at, closing_entry_id')
    .eq('company_id', companyId)
    .eq('id', fiscalPeriodId)
    .maybeSingle()
  if (periodError) throw new Error(`Kunde inte läsa räkenskapsåret: ${periodError.message}`)
  if (!period) throw codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found')
  const open = period as { is_closed: boolean; locked_at: string | null; closing_entry_id: string | null }
  if (open.is_closed || open.locked_at || open.closing_entry_id) {
    throw codedRefusal('PERIOD_LOCKED', 'The fiscal period is locked or closed')
  }
  if ((await frameworkForYear(supabase, companyId, fiscalPeriodId)) !== 'k3') {
    throw new DeferredTaxNotApplicableError()
  }
  if (options.dryRun) {
    return {
      loss_recognised: input.loss_recognised,
      loss_reason: input.loss_reason?.trim() || null,
      manual_items: input.manual_items,
    }
  }
  const { error } = await supabase.from('deferred_tax_assessments').upsert(
    {
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      loss_recognised: input.loss_recognised,
      loss_reason: input.loss_reason?.trim() || null,
      manual_items: input.manual_items,
      updated_by: userId,
    },
    { onConflict: 'company_id,fiscal_period_id' },
  )
  if (error) throw new Error(`Kunde inte spara underlaget för uppskjuten skatt: ${error.message}`)
  return loadDeferredTaxAssessment(supabase, companyId, fiscalPeriodId)
}

/** The ledger's deferred tax at the balansdag, before this year's posting. */
export async function deferredTaxBalances(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DeferredTaxBalances & { openingLiability: number; openingAsset: number }> {
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
  const row = (account: string) => trialBalance.rows.find((candidate) => candidate.account_number === account)
  const liability = row(DEFERRED_TAX_LIABILITY_ACCOUNT)
  const asset = row(DEFERRED_TAX_ASSET_ACCOUNT)
  return {
    liability: roundOre((liability?.closing_credit ?? 0) - (liability?.closing_debit ?? 0)),
    asset: roundOre((asset?.closing_debit ?? 0) - (asset?.closing_credit ?? 0)),
    openingLiability: roundOre((liability?.opening_credit ?? 0) - (liability?.opening_debit ?? 0)),
    openingAsset: roundOre((asset?.opening_debit ?? 0) - (asset?.opening_credit ?? 0)),
  }
}

/** What the year's deferred tax is computed from, for the wizard. */
export interface DeferredTaxSnapshot {
  rate: number
  /** The year's closing underskott from the bolagsskatt computation. */
  closingDeficit: number
  assessment: DeferredTaxAssessment
  items: DeferredTaxItem[]
  /** Net deferred tax the ledger holds now and at the balansdag after the posting. */
  opening: number
  closing: number
  change: number
  /**
   * The ledger holds deferred tax (2240/1370) and nobody has saved the
   * year's inputs: nothing is proposed. The items are only what the app can
   * see (the buildings, the year's underskott), so a posting would take
   * every other difference behind that balance (an SIE import, a voucher
   * booked by hand, last year's loss) back through 8940 unasked.
   */
  needsInputs: boolean
}

/**
 * The year's closing underskott from the bolagsskatt computation: a negative
 * taxable result after the deficit brought forward (INK2S 4.14 a) rolls into
 * the next year (IL 40 kap.).
 */
export function closingDeficitOf(bolagsskatt: ProposedDisposition | null | undefined): number {
  const taxable = Number((bolagsskatt?.computation as { taxableResult?: unknown } | undefined)?.taxableResult)
  return Number.isFinite(taxable) && taxable < 0 ? roundOre(-taxable) : 0
}

/** The temporary differences of the year (see the module comment). */
export function deferredTaxItems(
  assessment: DeferredTaxAssessment,
  closingDeficit: number,
  rate: number = BOLAGSSKATT_RATE,
  /** Differences the register computes: the buildings on their tax plan. */
  computed: readonly TemporaryDifferenceInput[] = [],
): DeferredTaxItem[] {
  const items: DeferredTaxItem[] = computed.map((difference) => deferredTaxItem(difference, rate))
  if (assessment.loss_recognised && closingDeficit > 0.005) {
    items.push(deferredTaxItem(lossCarryforwardDifference(closingDeficit, assessment.loss_reason), rate))
  }
  for (const manual of assessment.manual_items) {
    items.push(
      deferredTaxItem(
        {
          kind: 'manual',
          label: manual.label,
          nature: manual.nature,
          carryingAmount: manual.carrying_amount,
          taxValue: manual.tax_value,
        },
        rate,
      ),
    )
  }
  return items.filter((item) => Math.abs(item.deferred_tax) >= 0.005)
}

/**
 * The deferred tax disposition for the year, or null in a K2 year. The
 * proposal carries the snapshot so the wizard can show the items; a zero
 * change still answers the snapshot (nothing to post).
 *
 * The closing deferred tax is what the year's inputs state; the change is
 * measured against what the ledger holds. Until the user has saved the
 * year's inputs, a ledger balance is not explained by anything here, so no
 * proposal is made (needsInputs) and nothing can be posted, from any door.
 */
export async function buildDeferredTaxProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { closingDeficit: number },
): Promise<{ proposal: ProposedDisposition | null; snapshot: DeferredTaxSnapshot } | null> {
  if ((await frameworkForYear(supabase, companyId, fiscalPeriodId)) !== 'k3') return null
  const [{ assessment, saved }, balances, period] = await Promise.all([
    readAssessment(supabase, companyId, fiscalPeriodId),
    deferredTaxBalances(supabase, companyId, fiscalPeriodId),
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw new Error(`Kunde inte läsa räkenskapsåret: ${error.message}`)
        return data as { id: string; period_start: string; period_end: string } | null
      }),
  ])
  const buildings = period ? await loadBuildingTemporaryDifferences(supabase, companyId, period) : []
  const closingDeficit = roundOre(Math.max(0, options.closingDeficit))
  const items = deferredTaxItems(
    assessment,
    closingDeficit,
    BOLAGSSKATT_RATE,
    buildings.map((building) => ({
      kind: 'building' as const,
      label: building.name,
      nature: 'asset' as const,
      carryingAmount: building.carryingAmount,
      taxValue: building.taxValue,
    })),
  )
  const closing = closingDeferredTax(items)
  const posting = deferredTaxPosting(balances, closing)
  const ledgerHolds = Math.abs(balances.liability) >= 0.005 || Math.abs(balances.asset) >= 0.005
  const snapshot: DeferredTaxSnapshot = {
    rate: BOLAGSSKATT_RATE,
    closingDeficit,
    assessment,
    items,
    opening: posting.opening,
    closing: posting.closing,
    change: posting.change,
    needsInputs: !saved && ledgerHolds,
  }
  if (snapshot.needsInputs || posting.lines.length === 0) return { proposal: null, snapshot }
  return {
    snapshot,
    proposal: {
      kind: 'uppskjuten_skatt_kap29',
      label: 'Uppskjuten skatt',
      description:
        posting.change >= 0
          ? `Uppskjuten skatt ökar med ${posting.change} kr (K3 kap. 29): kostnad på 8940 mot uppskjuten skatt i balansräkningen.`
          : `Uppskjuten skatt minskar med ${-posting.change} kr (K3 kap. 29): intäkt på 8940 mot uppskjuten skatt i balansräkningen.`,
      amount: Math.abs(posting.change),
      signedAmount: posting.change,
      lines: posting.lines,
      warnings: [],
      computation: {
        rate: snapshot.rate,
        opening: snapshot.opening,
        closing: snapshot.closing,
        change: snapshot.change,
        items: items as unknown as Record<string, unknown>[],
      },
    },
  }
}

/**
 * Post the year's deferred tax: a year_end voucher on 8940/2240/1370 and the
 * items it was computed from, in one transaction (commit_deferred_tax).
 * Null when there is nothing to post.
 */
export async function postDeferredTax(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  period: { id: string; period_end: string },
  options: { closingDeficit: number },
): Promise<JournalEntry | null> {
  const built = await buildDeferredTaxProposal(supabase, companyId, period.id, options)
  if (!built) throw new DeferredTaxNotApplicableError()
  const { proposal, snapshot } = built
  if (!proposal) return null
  const draft = await postingPort.draftJournalEntry({
    supabase,
    companyId,
    userId,
    event: () =>
      yearEndDispositionBusinessEvent({
        disposition: 'uppskjuten_skatt_kap29',
        fiscalPeriodId: period.id,
        periodEnd: period.period_end,
        amount: proposal.amount,
        linkBasis: linkBasisColumns('user_created'),
      }),
    input: {
      fiscal_period_id: period.id,
      entry_date: period.period_end,
      description: `Bokslutsdisposition: ${proposal.label}`,
      source_type: 'year_end',
      voucher_series: 'A',
      lines: proposal.lines,
    },
  })
  const { entry } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'commit_deferred_tax',
    args: [draft, { closing: snapshot.closing, change: snapshot.change, items: snapshot.items }],
  })
  return entry
}

/** Opening, change and closing of one deferred tax account or kind. */
export interface DeferredTaxMovement {
  opening: number
  change: number
  closing: number
}

/**
 * The year's movements in deferred tax for the K3 note (ÅRL 5:36 for
 * större företag, K3 29.34-29.35): 2240 and 1370 from the ledger, and per
 * kind from the posted items of this year and the latest earlier year. The
 * seam the K3 årsredovisning reads (K3 plan phase 1).
 */
export async function deferredTaxMovements(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<{
  liability: DeferredTaxMovement
  asset: DeferredTaxMovement
  byKind: Array<{ kind: DeferredTaxKind; opening: number; closing: number }>
}> {
  const balances = await deferredTaxBalances(supabase, companyId, fiscalPeriodId)
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (periodError) throw new Error(`Kunde inte läsa räkenskapsåret: ${periodError.message}`)
  const periodStart = (period as { period_start: string } | null)?.period_start ?? ''

  const { data: rows, error } = await supabase
    .from('deferred_tax_items')
    .select('kind, deferred_tax, fiscal_period_id, fiscal_period:fiscal_periods!deferred_tax_items_fiscal_period_id_fkey(period_end), journal_entry:journal_entries!deferred_tax_items_journal_entry_id_fkey(status)')
    .eq('company_id', companyId)
  if (error) throw new Error(`Kunde inte läsa posterna för uppskjuten skatt: ${error.message}`)
  type Row = {
    kind: DeferredTaxKind
    deferred_tax: number | string
    fiscal_period_id: string
    fiscal_period: { period_end: string } | { period_end: string }[] | null
    journal_entry: { status: string } | { status: string }[] | null
  }
  const one = <T,>(value: T | T[] | null): T | null => (Array.isArray(value) ? value[0] ?? null : value)
  const posted = ((rows ?? []) as Row[]).filter((row) => one(row.journal_entry)?.status === 'posted')
  const thisYear = posted.filter((row) => row.fiscal_period_id === fiscalPeriodId)
  const earlierEnds = posted
    .map((row) => one(row.fiscal_period)?.period_end ?? '')
    .filter((end) => end !== '' && end < periodStart)
    .sort()
  const latestEarlierEnd = earlierEnds[earlierEnds.length - 1]
  const earlier = posted.filter((row) => latestEarlierEnd && one(row.fiscal_period)?.period_end === latestEarlierEnd)
  const sumBy = (list: Row[], kind: DeferredTaxKind) =>
    roundOre(list.filter((row) => row.kind === kind).reduce((sum, row) => sum + (Number(row.deferred_tax) || 0), 0))
  const kinds: DeferredTaxKind[] = ['loss_carryforward', 'building', 'manual']
  const movement = (opening: number, closing: number): DeferredTaxMovement => ({
    opening,
    change: roundOre(closing - opening),
    closing,
  })
  return {
    liability: movement(balances.openingLiability, balances.liability),
    asset: movement(balances.openingAsset, balances.asset),
    byKind: kinds
      .map((kind) => ({
        kind,
        opening: sumBy(earlier, kind),
        // A year with nothing posted keeps the latest earlier year's items.
        closing: thisYear.length > 0 ? sumBy(thisYear, kind) : sumBy(earlier, kind),
      }))
      .filter((row) => row.opening !== 0 || row.closing !== 0),
  }
}
