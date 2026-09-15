import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type {
  BookAssociationDistributionSchema,
  CreateAssociationDistributionSchema,
  PayAssociationDistributionSchema,
} from '@/lib/api/schemas'
import { AssociationRegisterError } from '@/lib/associations/errors'
import { listContributions, listMembers } from '@/lib/associations/member-register'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * Värdeöverföringar from an ekonomisk förening to its members (design
 * section 5, the distributions half of the member-capital module).
 *
 * EFL (2018:672) 12 kap. governs value transfers: 12 kap. 1 § names the
 * forms, 12 kap. 2 § the beloppsspärr (the transfer may not leave bundet eget
 * kapital uncovered, so at most the fritt eget kapital of the latest adopted
 * balance sheet may go out) and 12 kap. 3 § the försiktighetsregel (the
 * board's judgement of what the förening can spare, which no rule here
 * replaces). 13 kap. puts the decision on vinstutdelning with the
 * föreningsstämma on the board's proposal.
 *
 * Tax (IL 39 kap. 22-23 §§): a kooperativ förening may deduct gottgörelse
 * given in proportion to purchases or sales (efterlikvid, återbäring) and
 * utdelning given in proportion to paid insatser. The rebate is booked as a
 * cost (8840 Lämnade gottgörelser) and reaches INK2R by itself; the
 * insats dividend is a disposition of fritt eget kapital and never touches
 * the result, so its deduction has to be claimed in the skattemässiga
 * justeringar (the INK2 engine warns until it is).
 *
 * Postings, all through the bookkeeping engine:
 *   insats_dividend / forlags_dividend  decision Dr 2091 / Cr 2898,
 *                                       payment  Dr 2898 / Cr bank
 *   cooperative_rebate                  decision Dr 8840 / Cr 2890,
 *                                       payment  Dr 2890 / Cr bank
 * These are the same accounts as the member_dividend_* and
 * cooperative_rebate_* booking templates, so a transaction matched through a
 * template and a decision booked here land on the same posts.
 */

export type AssociationDistributionKind = 'insats_dividend' | 'forlags_dividend' | 'cooperative_rebate'
export type AssociationDistributionStatus = 'decided' | 'booked' | 'paid'
export type AssociationAllocationBasis = 'contributions' | 'turnover' | 'custom'

export interface AssociationDistributionRow {
  id: string
  company_id: string
  kind: AssociationDistributionKind
  fiscal_period_id: string
  decision_date: string
  decided_by: 'stamma' | 'board'
  decision_reference: string | null
  allocation_basis: AssociationAllocationBasis
  total_amount: number | string
  status: AssociationDistributionStatus
  journal_entry_id: string | null
  payment_journal_entry_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AssociationAllocationRow {
  id: string
  company_id: string
  distribution_id: string
  member_id: string
  basis_value: number | string
  amount: number | string
  created_at: string
  updated_at: string
}

export interface AssociationDistributionWithAllocations extends AssociationDistributionRow {
  allocations: AssociationAllocationRow[]
}

export const DISTRIBUTION_COLUMNS =
  'id, company_id, kind, fiscal_period_id, decision_date, decided_by, decision_reference, allocation_basis, total_amount, status, journal_entry_id, payment_journal_entry_id, notes, created_at, updated_at'
export const ALLOCATION_COLUMNS =
  'id, company_id, distribution_id, member_id, basis_value, amount, created_at, updated_at'

/** Accounts of the decision and payment verifikat per kind. */
export const DISTRIBUTION_ACCOUNTS: Record<
  AssociationDistributionKind,
  { decisionDebit: string; liability: string }
> = {
  insats_dividend: { decisionDebit: '2091', liability: '2898' },
  forlags_dividend: { decisionDebit: '2091', liability: '2898' },
  cooperative_rebate: { decisionDebit: '8840', liability: '2890' },
}

/** Fritt eget kapital: balanserat resultat and the result chain (2097 is an aktiebolag post). */
export const FREE_EQUITY_ACCOUNTS = ['2091', '2098', '2099'] as const

const KIND_LABEL: Record<AssociationDistributionKind, string> = {
  insats_dividend: 'Utdelning på medlemsinsatser',
  forlags_dividend: 'Utdelning på förlagsinsatser',
  cooperative_rebate: 'Gottgörelse till medlemmar',
}

export interface AllocationPlanLine {
  member_id: string
  basis_value: number
  amount: number
}

/**
 * Spread `total` over the basis values in öre. Each share is rounded to öre;
 * the rounding residual (at most a few öre) lands on the largest basis so the
 * lines sum to the total exactly, which the database guard requires before
 * the row can be booked. Members with a zero basis get nothing and are
 * dropped.
 */
export function allocateByBasis(
  total: number,
  basis: ReadonlyArray<{ member_id: string; basis_value: number }>,
): AllocationPlanLine[] {
  const positive = basis.filter((line) => line.basis_value > 0)
  const basisSum = roundOre(positive.reduce((sum, line) => sum + line.basis_value, 0))
  if (positive.length === 0 || basisSum <= 0) {
    throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_NO_BASIS')
  }
  const totalOre = Math.round(total * 100)
  const lines = positive.map((line) => ({
    member_id: line.member_id,
    basis_value: roundOre(line.basis_value),
    amount: roundOre(Math.round((totalOre * line.basis_value) / basisSum) / 100),
  }))
  const allocatedOre = lines.reduce((sum, line) => sum + Math.round(line.amount * 100), 0)
  const residualOre = totalOre - allocatedOre
  if (residualOre !== 0) {
    const largest = lines.reduce((best, line) => (line.basis_value > best.basis_value ? line : best), lines[0])
    largest.amount = roundOre(largest.amount + residualOre / 100)
  }
  return lines
}

/**
 * The distributable fritt eget kapital per the closed books of the period
 * (EFL 12 kap. 2 §): credit balances on 2091/2098/2099 including the closing
 * entry, less what earlier decisions on the same period already committed.
 */
export async function distributableEquity(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<number> {
  const [trialBalance, decided] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
    listDistributions(supabase, companyId, { fiscalPeriodId }),
  ])
  const freeEquity = trialBalance.rows
    .filter((row) => (FREE_EQUITY_ACCOUNTS as readonly string[]).includes(row.account_number))
    .reduce((sum, row) => sum + (row.closing_credit ?? 0) - (row.closing_debit ?? 0), 0)
  const committed = decided
    .filter((d) => d.kind !== 'cooperative_rebate')
    .reduce((sum, d) => sum + Number(d.total_amount), 0)
  return roundOre(freeEquity - committed)
}

export async function listDistributions(
  supabase: SupabaseClient,
  companyId: string,
  options: { fiscalPeriodId?: string } = {},
): Promise<AssociationDistributionRow[]> {
  const rows = await fetchAllRows<AssociationDistributionRow>(
    ({ from, to }) => {
      let query = supabase
        .from('association_distributions')
        .select(DISTRIBUTION_COLUMNS)
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (options.fiscalPeriodId) query = query.eq('fiscal_period_id', options.fiscalPeriodId)
      return query
    },
    { dedupeBy: (row) => row.id },
  )
  rows.sort((a, b) => a.decision_date.localeCompare(b.decision_date) || a.created_at.localeCompare(b.created_at))
  return rows
}

export async function listAllocations(
  supabase: SupabaseClient,
  companyId: string,
  distributionId: string,
): Promise<AssociationAllocationRow[]> {
  return fetchAllRows<AssociationAllocationRow>(
    ({ from, to }) =>
      supabase
        .from('association_distribution_allocations')
        .select(ALLOCATION_COLUMNS)
        .eq('company_id', companyId)
        .eq('distribution_id', distributionId)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (row) => row.id },
  )
}

async function readDistribution(
  supabase: SupabaseClient,
  companyId: string,
  distributionId: string,
): Promise<AssociationDistributionRow> {
  const { data, error } = await supabase
    .from('association_distributions')
    .select(DISTRIBUTION_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', distributionId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_NOT_FOUND')
  return data as AssociationDistributionRow
}

/**
 * Basis from the register for `allocation_basis = 'contributions'`: paid
 * insatser (obligatory, over, emission) for an insats dividend, paid
 * förlagsinsatser for a förlags dividend. A cooperative rebate has no
 * register basis; it is spread on turnover the caller supplies.
 */
async function contributionBasis(
  supabase: SupabaseClient,
  companyId: string,
  kind: AssociationDistributionKind,
): Promise<Array<{ member_id: string; basis_value: number }>> {
  if (kind === 'cooperative_rebate') {
    throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_NO_BASIS')
  }
  const kinds: ReadonlyArray<'obligatory' | 'over' | 'emission' | 'forlags'> =
    kind === 'forlags_dividend' ? ['forlags'] : ['obligatory', 'over', 'emission']
  const contributions = await listContributions(supabase, companyId)
  const byMember = new Map<string, number>()
  for (const c of contributions) {
    if (c.status !== 'paid' || !kinds.includes(c.kind)) continue
    byMember.set(c.member_id, roundOre((byMember.get(c.member_id) ?? 0) + Number(c.amount)))
  }
  return [...byMember.entries()].map(([member_id, basis_value]) => ({ member_id, basis_value }))
}

/**
 * Record a decided värdeöverföring with its allocation per member. The
 * beloppsspärr (EFL 12 kap. 2 §) applies to the dividends: the total may
 * not exceed the distributable fritt eget kapital of the period. A rebate is
 * a cost of the year it belongs to (IL 39 kap. 22 §) and is not measured
 * against equity here; the försiktighetsregel stays with the board.
 */
export async function createDistribution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof CreateAssociationDistributionSchema>,
): Promise<AssociationDistributionWithAllocations> {
  const total = roundOre(input.total_amount)
  if (input.kind !== 'cooperative_rebate') {
    const distributable = await distributableEquity(supabase, companyId, input.fiscal_period_id)
    if (total > distributable) {
      throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_EXCEEDS_FREE_EQUITY')
    }
  }

  const basis =
    input.allocation_basis === 'contributions'
      ? await contributionBasis(supabase, companyId, input.kind)
      : (input.allocations ?? []).map((line) => ({ member_id: line.member_id, basis_value: line.basis_value }))
  // Every allocated member must belong to this company's register.
  const members = await listMembers(supabase, companyId, { includeExited: true })
  const known = new Set(members.map((m) => m.id))
  for (const line of basis) {
    if (!known.has(line.member_id)) throw new AssociationRegisterError('ASSOCIATION_MEMBER_NOT_FOUND')
  }
  const plan = allocateByBasis(total, basis)

  const { data, error } = await supabase
    .from('association_distributions')
    .insert({
      company_id: companyId,
      user_id: userId,
      kind: input.kind,
      fiscal_period_id: input.fiscal_period_id,
      decision_date: input.decision_date,
      decided_by: input.decided_by,
      decision_reference: input.decision_reference ?? null,
      allocation_basis: input.allocation_basis,
      total_amount: total,
      notes: input.notes ?? null,
    })
    .select(DISTRIBUTION_COLUMNS)
    .single()
  if (error) throw error
  const distribution = data as AssociationDistributionRow

  const { data: allocations, error: allocationError } = await supabase
    .from('association_distribution_allocations')
    .insert(
      plan.map((line) => ({
        company_id: companyId,
        user_id: userId,
        distribution_id: distribution.id,
        member_id: line.member_id,
        basis_value: line.basis_value,
        amount: line.amount,
      })),
    )
    .select(ALLOCATION_COLUMNS)
  if (allocationError) throw allocationError
  return { ...distribution, allocations: (allocations ?? []) as AssociationAllocationRow[] }
}

/**
 * Book the decision verifikat in the distribution's period and move the row
 * to `booked`. The database guard refuses the status change unless the
 * allocations equal the total.
 */
export async function bookDistribution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  distributionId: string,
  input: z.infer<typeof BookAssociationDistributionSchema>,
): Promise<AssociationDistributionRow> {
  const distribution = await readDistribution(supabase, companyId, distributionId)
  if (distribution.status !== 'decided') {
    throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_ALREADY_BOOKED')
  }
  const allocations = await listAllocations(supabase, companyId, distributionId)
  const allocated = roundOre(allocations.reduce((sum, a) => sum + Number(a.amount), 0))
  const total = roundOre(Number(distribution.total_amount))
  if (allocated !== total) {
    throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_ALLOCATIONS_MISMATCH')
  }
  const accounts = DISTRIBUTION_ACCOUNTS[distribution.kind]
  const lines: CreateJournalEntryLineInput[] = [
    { account_number: accounts.decisionDebit, debit_amount: total, credit_amount: 0 },
    { account_number: accounts.liability, debit_amount: 0, credit_amount: total },
  ]
  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: distribution.fiscal_period_id,
    entry_date: input.entry_date ?? distribution.decision_date,
    description: `${KIND_LABEL[distribution.kind]}: beslut ${distribution.decision_date}${
      distribution.decision_reference ? ` (${distribution.decision_reference})` : ''
    }`,
    source_type: 'manual',
    source_id: distribution.id,
    lines,
  })
  const { data, error } = await supabase
    .from('association_distributions')
    .update({ status: 'booked', journal_entry_id: entry.id })
    .eq('company_id', companyId)
    .eq('id', distributionId)
    .select(DISTRIBUTION_COLUMNS)
    .single()
  if (error) throw error
  return data as AssociationDistributionRow
}

/**
 * Book the payment (Dr liability / Cr bank) in the open period covering the
 * payment date and move the row to `paid`. The payment may fall in a later
 * fiscal year than the decision.
 */
export async function payDistribution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  distributionId: string,
  input: z.infer<typeof PayAssociationDistributionSchema>,
): Promise<AssociationDistributionRow> {
  const distribution = await readDistribution(supabase, companyId, distributionId)
  if (distribution.status === 'decided') {
    throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_NOT_BOOKED')
  }
  if (distribution.status === 'paid') {
    throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_ALREADY_PAID')
  }
  const periodId = await findFiscalPeriod(supabase, companyId, input.paid_on)
  if (!periodId) throw new AssociationRegisterError('ASSOCIATION_DISTRIBUTION_NO_OPEN_PERIOD')
  const total = roundOre(Number(distribution.total_amount))
  const accounts = DISTRIBUTION_ACCOUNTS[distribution.kind]
  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: periodId,
    entry_date: input.paid_on,
    description: `${KIND_LABEL[distribution.kind]}: utbetalning`,
    source_type: 'manual',
    source_id: distribution.id,
    lines: [
      { account_number: accounts.liability, debit_amount: total, credit_amount: 0 },
      { account_number: input.bank_account, debit_amount: 0, credit_amount: total },
    ],
  })
  const { data, error } = await supabase
    .from('association_distributions')
    .update({ status: 'paid', payment_journal_entry_id: entry.id })
    .eq('company_id', companyId)
    .eq('id', distributionId)
    .select(DISTRIBUTION_COLUMNS)
    .single()
  if (error) throw error
  return data as AssociationDistributionRow
}
