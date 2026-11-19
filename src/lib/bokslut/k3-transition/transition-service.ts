/**
 * The guided transition to K3 (BFNAR 2012:1 kap. 35) for a company whose
 * earlier årsredovisningar were prepared under K2: start it on the first K3
 * year, split the fixed assets on components at the transition date
 * (35.18, assets/transition-split-service.ts), choose the relief rules
 * (35.21-35.29, 35.34) and describe the changed principles (35.33), then
 * commit: one voucher in that year, dated its first day, with the opening
 * deferred tax (unless 35.27) and the stated adjustments against equity
 * (35.11). Locked and closed years are never touched. The facts are what
 * the årsredovisning's transition notes read (35.30-35.33).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { K3TransitionBlockedError, K3TransitionInvalidError, k3TransitionBlockFromRpc } from '@/lib/bookkeeping/errors'
import { frameworkForYear } from '@/lib/bokslut/framework-for-year'
import { loadBuildingTemporaryDifferences } from '@/lib/bokslut/assets/building-tax-service'
import { isTaxRealProperty, taxPlanForYear } from '@/lib/bokslut/assets/building-tax'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { addDaysIso } from '@/lib/bokslut/assets/plan-calendar'
import {
  listTransitionSplitCandidates,
  type TransitionSplitCandidate,
} from '@/lib/bokslut/assets/transition-split-service'
import { BOLAGSSKATT_RATE } from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import { closingDeferredTax, deferredTaxPosting, type DeferredTaxItem } from '@/lib/bokslut/tax-provision/deferred-tax'
import {
  deferredTaxBalances,
  deferredTaxItems,
  ManualDifferenceSchema,
} from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { resolveCompanyEntityType, retainedResultAccount } from '@/lib/company/entity-type'
import { linkBasisColumns } from '@/lib/links/stamp'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { roundOre } from '@/lib/money'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'
import {
  adjustmentErrors,
  K3_RELIEF_RULE_CODES,
  TRANSITION_DESCRIPTION,
  transitionLines,
  type K3ReliefRule,
} from './transition'

export interface K3TransitionRow {
  id: string
  fiscal_period_id: string
  deferred_tax_relief: boolean
  relief_rules: K3ReliefRule[]
  changed_principles: string
  journal_entry_id: string | null
  opening_deferred_tax: number
  deferred_tax_items: DeferredTaxItem[]
  committed_at: string | null
}

export interface K3TransitionPeriod {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

export interface K3TransitionState {
  transition: K3TransitionRow | null
  /** Committed: its voucher is posted, or it was committed with nothing to book. */
  committed: boolean
  /** The first K3 year; its first day is the transition date (35.7). */
  period: K3TransitionPeriod | null
  /** The register's tangible assets from before the transition (35.18). */
  assets: TransitionSplitCandidate[]
}

type StoredRow = Omit<K3TransitionRow, 'opening_deferred_tax'> & {
  opening_deferred_tax: number | string
  journal_entry: { status: string } | { status: string }[] | null
}

function isCommitted(row: StoredRow): boolean {
  if (!row.committed_at) return false
  if (!row.journal_entry_id) return true
  const entry = Array.isArray(row.journal_entry) ? row.journal_entry[0] : row.journal_entry
  return entry?.status === 'posted'
}

async function loadRow(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ row: K3TransitionRow; committed: boolean } | null> {
  const { data, error } = await supabase
    .from('k3_transitions')
    .select(
      'id, fiscal_period_id, deferred_tax_relief, relief_rules, changed_principles, journal_entry_id, opening_deferred_tax, deferred_tax_items, committed_at, journal_entry:journal_entries!k3_transitions_journal_entry_id_fkey(status)',
    )
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa övergången till K3: ${error.message}`)
  if (!data) return null
  const stored = data as unknown as StoredRow
  const { journal_entry: _entry, ...rest } = stored
  return {
    row: {
      ...rest,
      relief_rules: (rest.relief_rules ?? []) as K3ReliefRule[],
      opening_deferred_tax: roundOre(Number(rest.opening_deferred_tax) || 0),
      deferred_tax_items: Array.isArray(rest.deferred_tax_items) ? rest.deferred_tax_items : [],
    },
    committed: isCommitted(stored),
  }
}

async function loadPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<K3TransitionPeriod | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed, locked_at')
    .eq('company_id', companyId)
    .eq('id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa räkenskapsåret: ${error.message}`)
  return (data as K3TransitionPeriod | null) ?? null
}

/** The transition as it stands, with the assets the 35.18 split concerns. */
export async function getK3Transition(supabase: SupabaseClient, companyId: string): Promise<K3TransitionState> {
  const loaded = await loadRow(supabase, companyId)
  if (!loaded) return { transition: null, committed: false, period: null, assets: [] }
  const period = await loadPeriod(supabase, companyId, loaded.row.fiscal_period_id)
  const assets = period ? await listTransitionSplitCandidates(supabase, companyId, period.period_start) : []
  return { transition: loaded.row, committed: loaded.committed, period, assets }
}

/** A fiscal year as the transition sees it: its framework, and whether it is open. */
export interface K3TransitionYear {
  fiscal_period_id: string
  framework: 'k2' | 'k3'
  open: boolean
}

export async function k3TransitionYear(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<K3TransitionYear | null> {
  const period = await loadPeriod(supabase, companyId, fiscalPeriodId)
  if (!period) return null
  return {
    fiscal_period_id: period.id,
    framework: await frameworkForYear(supabase, companyId, period.id),
    open: !period.is_closed && !period.locked_at,
  }
}

export const StartK3TransitionSchema = z.object({ fiscal_period_id: z.string().uuid() }).strict()

/** Start the transition on the first K3 year (an open year reported under K3). */
/** The checks a start must pass, writing nothing: what a dry run answers. */
export async function checkStartK3Transition(
  supabase: SupabaseClient,
  companyId: string,
  input: z.infer<typeof StartK3TransitionSchema>,
): Promise<{ fiscal_period_id: string; fiscal_period_name: string; transition_date: string }> {
  const period = await loadPeriod(supabase, companyId, input.fiscal_period_id)
  if (!period) throw Object.assign(new Error('Fiscal period not found'), { code: 'PERIOD_NOT_FOUND' })
  if (period.is_closed || period.locked_at) throw new K3TransitionBlockedError('period_locked')
  if ((await frameworkForYear(supabase, companyId, period.id)) !== 'k3') throw new K3TransitionBlockedError('not_k3')
  if (await loadRow(supabase, companyId)) throw new K3TransitionBlockedError('already_started')
  return { fiscal_period_id: period.id, fiscal_period_name: period.name, transition_date: period.period_start }
}

export async function startK3Transition(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof StartK3TransitionSchema>,
): Promise<K3TransitionState> {
  const plan = await checkStartK3Transition(supabase, companyId, input)
  const { error } = await supabase
    .from('k3_transitions')
    .insert({ company_id: companyId, fiscal_period_id: plan.fiscal_period_id, created_by: userId })
  if (error) {
    if (error.code === '23505') throw new K3TransitionBlockedError('already_started')
    throw new Error(`Kunde inte påbörja övergången till K3: ${error.message}`)
  }
  return getK3Transition(supabase, companyId)
}

export const UpdateK3TransitionSchema = z
  .object({
    deferred_tax_relief: z.boolean().optional(),
    relief_rules: z.array(z.enum(K3_RELIEF_RULE_CODES)).max(K3_RELIEF_RULE_CODES.length).optional(),
    changed_principles: z.string().max(4000).optional(),
  })
  .strict()

function blocked(error: { code?: string; message: string }, fallback: string): never {
  if (error.code === 'PT409') {
    const reason = k3TransitionBlockFromRpc(error.message)
    if (reason) throw new K3TransitionBlockedError(reason)
  }
  throw new Error(`${fallback}: ${error.message}`)
}

/** The 35.27 choice and the note facts (35.31, 35.33). */
/** The change an update makes, checked, writing nothing: what a dry run answers. */
export async function checkUpdateK3Transition(
  supabase: SupabaseClient,
  companyId: string,
  input: z.infer<typeof UpdateK3TransitionSchema>,
): Promise<{
  k3_transition_id: string
  /** Every field as it will read; unchanged ones as they are. */
  next: { deferred_tax_relief: boolean; relief_rules: K3ReliefRule[]; changed_principles: string }
}> {
  const loaded = await loadRow(supabase, companyId)
  if (!loaded) throw new K3TransitionBlockedError('not_started')
  const relief = input.deferred_tax_relief ?? loaded.row.deferred_tax_relief
  // What was booked stays as booked; the note facts stay editable.
  if (relief !== loaded.row.deferred_tax_relief && loaded.committed) throw new K3TransitionBlockedError('committed')
  return {
    k3_transition_id: loaded.row.id,
    next: {
      deferred_tax_relief: relief,
      relief_rules: input.relief_rules !== undefined ? [...new Set(input.relief_rules)].sort() : loaded.row.relief_rules,
      changed_principles:
        input.changed_principles !== undefined ? input.changed_principles.trim() : loaded.row.changed_principles,
    },
  }
}

export async function updateK3Transition(
  supabase: SupabaseClient,
  companyId: string,
  input: z.infer<typeof UpdateK3TransitionSchema>,
): Promise<K3TransitionState> {
  const { k3_transition_id: id, next } = await checkUpdateK3Transition(supabase, companyId, input)
  // Every field written, unchanged ones as they are: the guard compares
  // values, so an unchanged relief passes on a committed transition.
  const { error } = await supabase
    .from('k3_transitions')
    .update({
      deferred_tax_relief: next.deferred_tax_relief,
      relief_rules: next.relief_rules,
      changed_principles: next.changed_principles,
    })
    .eq('company_id', companyId)
    .eq('id', id)
  if (error) blocked(error, 'Kunde inte spara övergången till K3')
  return getK3Transition(supabase, companyId)
}

/** Whether the transition can be dropped (not committed, no splits left), writing nothing. */
export async function checkDeleteK3Transition(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ k3_transition_id: string }> {
  const loaded = await loadRow(supabase, companyId)
  if (!loaded) throw new K3TransitionBlockedError('not_started')
  if (loaded.committed) throw new K3TransitionBlockedError('committed')
  const { count, error } = await supabase
    .from('asset_transition_splits')
    .select('asset_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('transition_id', loaded.row.id)
  if (error) throw new Error(`Kunde inte läsa komponentuppdelningarna: ${error.message}`)
  if ((count ?? 0) > 0) throw new K3TransitionBlockedError('has_splits')
  return { k3_transition_id: loaded.row.id }
}

/** Drop a transition that is not committed and has no splits left. */
export async function deleteK3Transition(supabase: SupabaseClient, companyId: string): Promise<void> {
  const { k3_transition_id: id } = await checkDeleteK3Transition(supabase, companyId)
  const { error } = await supabase.from('k3_transitions').delete().eq('company_id', companyId).eq('id', id)
  if (error) blocked(error, 'Kunde inte ta bort övergången till K3')
}

export const K3TransitionPostingSchema = z
  .object({
    adjustments: z
      .array(
        z
          .object({
            account_number: accountNumberSchema,
            amount: z.number().min(-1_000_000_000_000).max(1_000_000_000_000),
            description: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    /** A tax loss carried into the first K3 year, recognised only with the 29.29 judgement. */
    loss_carryforward: z
      .object({
        deficit: z.number().min(0).max(1_000_000_000_000),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .nullable()
      .default(null),
    manual_items: z.array(ManualDifferenceSchema).max(100).default([]),
  })
  .strict()

export type K3TransitionPostingInput = z.infer<typeof K3TransitionPostingSchema>

export interface K3TransitionPreview {
  transition_date: string
  equity_account: string
  deferred_tax: {
    relief: boolean
    rate: number
    items: DeferredTaxItem[]
    /** What the ledger holds on 2240 less 1370 at the transition (0 under 35.27: not read). */
    held: number
    /** The opening deferred tax at the transition. */
    opening: number
    change: number
  }
  lines: CreateJournalEntryLineInput[]
  warnings: string[]
}

async function openContext(supabase: SupabaseClient, companyId: string) {
  const loaded = await loadRow(supabase, companyId)
  if (!loaded) throw new K3TransitionBlockedError('not_started')
  if (loaded.committed) throw new K3TransitionBlockedError('committed')
  const period = await loadPeriod(supabase, companyId, loaded.row.fiscal_period_id)
  if (!period) throw new K3TransitionBlockedError('not_started')
  if (period.is_closed || period.locked_at) throw new K3TransitionBlockedError('period_locked')
  // The year may have been switched back to K2 since the transition began.
  if ((await frameworkForYear(supabase, companyId, period.id)) !== 'k3') throw new K3TransitionBlockedError('not_k3')
  return { row: loaded.row, period }
}

/** The transition voucher as it would be posted, without writing anything. */
export async function previewK3Transition(
  supabase: SupabaseClient,
  companyId: string,
  input: K3TransitionPostingInput,
): Promise<K3TransitionPreview> {
  const { row, period } = await openContext(supabase, companyId)
  const errors = adjustmentErrors(input.adjustments)
  if (errors.length > 0) throw new K3TransitionInvalidError(errors.join(' '))
  const equityAccount = retainedResultAccount(await resolveCompanyEntityType(supabase, companyId))
  const dayBefore = addDaysIso(period.period_start, -1)
  const warnings: string[] = []

  let items: DeferredTaxItem[] = []
  if (!row.deferred_tax_relief) {
    const [buildings, assets] = await Promise.all([
      // At the transition date, in the first K3 year: the plans that reach that year.
      loadBuildingTemporaryDifferences(
        supabase,
        companyId,
        { id: period.id, period_start: dayBefore, period_end: dayBefore },
        { yearStart: period.period_start },
      ),
      listAssets(supabase, companyId),
    ])
    items = deferredTaxItems(
      {
        loss_recognised: input.loss_carryforward !== null,
        loss_reason: input.loss_carryforward?.reason ?? null,
        manual_items: input.manual_items,
      },
      input.loss_carryforward?.deficit ?? 0,
      BOLAGSSKATT_RATE,
      buildings.map((building) => ({
        kind: 'building' as const,
        label: building.name,
        nature: 'asset' as const,
        carryingAmount: building.carryingAmount,
        taxValue: building.taxValue,
      })),
    )
    for (const asset of assets) {
      if (
        isTaxRealProperty(asset) &&
        asset.category !== 'land' &&
        asset.acquisition_date < period.period_start &&
        !(asset.disposed_at && asset.disposed_at < period.period_start) &&
        taxPlanForYear(asset, period.period_start) === null
      ) {
        warnings.push(
          `${asset.name} har ingen skattemässig avskrivningsplan, så ingen uppskjuten skatt beräknas för den. Ange planen på tillgången eller som en egen temporär skillnad.`,
        )
      }
    }
  }

  // Under 35.27 nothing about deferred tax is booked, so the ledger's
  // balance is not read.
  const opening = closingDeferredTax(items)
  const posting = row.deferred_tax_relief
    ? { opening: 0, closing: 0, change: 0, lines: [] }
    : await deferredTaxBalances(supabase, companyId, period.id).then((balances) =>
        deferredTaxPosting({ liability: balances.openingLiability, asset: balances.openingAsset }, opening),
      )

  const candidates = await listTransitionSplitCandidates(supabase, companyId, period.period_start)
  const unsplit = candidates.filter((candidate) => candidate.status === 'plain' || candidate.status === 'later_depreciation_posted')
  if (unsplit.length > 0) {
    warnings.push(
      `${unsplit.length} materiella anläggningstillgångar har en plan för hela tillgången. Dela upp dem som har betydande komponenter med väsentligt olika nyttjandeperioder (K3 punkt 17.4 och 35.18).`,
    )
  }

  return {
    transition_date: period.period_start,
    equity_account: equityAccount,
    deferred_tax: {
      relief: row.deferred_tax_relief,
      rate: BOLAGSSKATT_RATE,
      items,
      held: posting.opening,
      opening: row.deferred_tax_relief ? 0 : opening,
      change: posting.change,
    },
    lines: transitionLines({ equityAccount, adjustments: input.adjustments, deferredTaxLines: posting.lines }),
    warnings,
  }
}

/** The business event of the transition voucher, for the posting port. Pure. */
export function k3TransitionBusinessEvent(args: {
  fiscalPeriodId: string
  transitionDate: string
  amount: number
}): BusinessEventDraft {
  const linkBasis = linkBasisColumns('user_created')
  return {
    kind: 'ledger.k3_transition',
    category: null,
    occurredOn: args.transitionDate,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('k3Transition'),
    jurisdiction: 'SE',
  }
}

export interface K3TransitionCommitResult {
  entry: JournalEntry | null
  preview: K3TransitionPreview
}

/**
 * Commit the transition: the voucher (when there is anything to book) and
 * the transition marked committed, in one transaction (commit_k3_transition).
 */
export async function commitK3TransitionPosting(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: K3TransitionPostingInput,
): Promise<K3TransitionCommitResult> {
  const preview = await previewK3Transition(supabase, companyId, input)
  const { period } = await openContext(supabase, companyId)
  const args = {
    equityAccount: preview.equity_account,
    openingDeferredTax: preview.deferred_tax.opening,
    deferredTaxChange: preview.deferred_tax.change,
    items: preview.deferred_tax.items,
  }

  if (preview.lines.length === 0) {
    const { error } = await supabase.rpc('commit_k3_transition', {
      p_company_id: companyId,
      p_entry_id: null,
      p_equity_account: args.equityAccount,
      p_opening_deferred_tax: args.openingDeferredTax,
      p_deferred_tax_change: args.deferredTaxChange,
      p_deferred_tax_items: args.items,
    })
    if (error) {
      if (error.code === '23514' && /locked|closed/i.test(error.message)) throw new K3TransitionBlockedError('period_locked')
      blocked(error, 'Kunde inte bokföra övergången till K3')
    }
    return { entry: null, preview }
  }

  const amount = roundOre(preview.lines.reduce((sum, line) => sum + (Number(line.debit_amount) || 0), 0))
  const draft = await postingPort.draftJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => k3TransitionBusinessEvent({ fiscalPeriodId: period.id, transitionDate: period.period_start, amount }),
    input: {
      fiscal_period_id: period.id,
      entry_date: period.period_start,
      description: TRANSITION_DESCRIPTION,
      source_type: 'system',
      voucher_series: 'A',
      lines: preview.lines,
    },
  })
  const { entry } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'commit_k3_transition',
    args: [draft, args],
  })
  return { entry, preview }
}
