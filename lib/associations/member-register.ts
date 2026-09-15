import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type {
  CreateAssociationContributionSchema,
  CreateAssociationMemberSchema,
  ExitAssociationMemberSchema,
  SettleAssociationContributionSchema,
} from '@/lib/api/schemas'
import { resolveCompanyEntityType, supportsMemberCapital } from '@/lib/company/entity-type'
import { AssociationRegisterError } from '@/lib/associations/errors'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Member register of an ekonomisk förening.
 *
 * EFL (2018:672) 5 kap. 1-3 §§: the board keeps a medlemsförteckning with
 * each member's name and postal address, the dates of admission and exit,
 * and the number and amount of the member's insatser per the latest adopted
 * balance sheet. 5 kap. 5 §: a member may ask for a membership certificate.
 * 5 kap. 6 §: the record is kept for seven years after a member has left.
 * 11 kap. 6 §: a separate förteckning over förlagsinsatser.
 *
 * The ledger owns the totals (2083 Medlemsinsatser, 2087 Insatsemission,
 * 2084 Förlagsinsatser); this register owns who holds which part of them.
 * `memberCapitalReconciliation` compares the two, and the year-end wizard
 * treats a difference as a finding, never as something to fabricate.
 *
 * Repayment on exit (EFL 10 kap. 11 §): only to a member who has left, at
 * most the paid amount, and per statute six months after the end of the
 * fiscal year in which the member left. The date rule depends on the
 * association's stadgar and the stämma, so it is left to the reviewer; the
 * two hard rules are enforced here.
 */

export type AssociationContributionKind = 'obligatory' | 'over' | 'emission' | 'forlags'
export type AssociationContributionStatus = 'paid' | 'repaid' | 'forfeited'

export interface AssociationMemberRow {
  id: string
  company_id: string
  member_number: string
  name: string
  postal_address: string | null
  email: string | null
  party_id: string | null
  member_class: string | null
  admitted_on: string
  exited_on: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AssociationContributionRow {
  id: string
  company_id: string
  member_id: string
  kind: AssociationContributionKind
  units: number
  amount: number | string
  status: AssociationContributionStatus
  paid_on: string
  settled_on: string | null
  journal_entry_id: string | null
  settlement_journal_entry_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export const MEMBER_COLUMNS =
  'id, company_id, member_number, name, postal_address, email, party_id, member_class, admitted_on, exited_on, notes, created_at, updated_at'
export const CONTRIBUTION_COLUMNS =
  'id, company_id, member_id, kind, units, amount, status, paid_on, settled_on, journal_entry_id, settlement_journal_entry_id, notes, created_at, updated_at'

/** Accounts each contribution kind reconciles to (ÅRL 3 kap. 10 b §). */
export const CONTRIBUTION_ACCOUNTS: Record<AssociationContributionKind, readonly string[]> = {
  obligatory: ['2083'],
  over: ['2083'],
  // Insatser credited through insatsemission (EFL 10 kap. 18-19 §§): BAS 2087
  // for an ekonomisk förening; presented as medlemsinsatser.
  emission: ['2087'],
  forlags: ['2084'],
}

/** Throws ASSOCIATION_FORM_REQUIRED unless the company is an ekonomisk förening. */
export async function requireMemberCapitalForm(
  supabase: SupabaseClient,
  companyId: string,
): Promise<void> {
  const entityType = await resolveCompanyEntityType(supabase, companyId)
  if (!supportsMemberCapital(entityType)) {
    throw new AssociationRegisterError('ASSOCIATION_FORM_REQUIRED')
  }
}

export async function listMembers(
  supabase: SupabaseClient,
  companyId: string,
  options: { includeExited?: boolean } = {},
): Promise<AssociationMemberRow[]> {
  const rows = await fetchAllRows<AssociationMemberRow>(
    ({ from, to }) => {
      let query = supabase
        .from('association_members')
        .select(MEMBER_COLUMNS)
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (!options.includeExited) query = query.is('exited_on', null)
      return query
    },
    { dedupeBy: (row) => row.id },
  )
  rows.sort((a, b) => a.member_number.localeCompare(b.member_number, 'sv', { numeric: true }))
  return rows
}

export async function createMember(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof CreateAssociationMemberSchema>,
): Promise<AssociationMemberRow> {
  const { data, error } = await supabase
    .from('association_members')
    .insert({
      company_id: companyId,
      user_id: userId,
      member_number: input.member_number,
      name: input.name,
      postal_address: input.postal_address ?? null,
      email: input.email ?? null,
      party_id: input.party_id ?? null,
      member_class: input.member_class ?? null,
      admitted_on: input.admitted_on,
      notes: input.notes ?? null,
    })
    .select(MEMBER_COLUMNS)
    .single()
  if (error) throw error
  const member = data as AssociationMemberRow
  await appendEvent(supabase, companyId, userId, member.id, 'admission', input.admitted_on, {
    member_number: member.member_number,
  })
  return member
}

export async function exitMember(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  memberId: string,
  input: z.infer<typeof ExitAssociationMemberSchema>,
): Promise<AssociationMemberRow> {
  const { data: existing, error: readError } = await supabase
    .from('association_members')
    .select(MEMBER_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', memberId)
    .maybeSingle()
  if (readError) throw readError
  if (!existing) throw new AssociationRegisterError('ASSOCIATION_MEMBER_NOT_FOUND')
  const member = existing as AssociationMemberRow
  if (member.exited_on) throw new AssociationRegisterError('ASSOCIATION_MEMBER_ALREADY_EXITED')

  const { data, error } = await supabase
    .from('association_members')
    .update({ exited_on: input.exited_on })
    .eq('company_id', companyId)
    .eq('id', memberId)
    .select(MEMBER_COLUMNS)
    .single()
  if (error) throw error
  await appendEvent(supabase, companyId, userId, memberId, input.reason, input.exited_on, {
    notes: input.notes ?? null,
  })
  return data as AssociationMemberRow
}

export async function listContributions(
  supabase: SupabaseClient,
  companyId: string,
  memberId?: string,
): Promise<AssociationContributionRow[]> {
  return fetchAllRows<AssociationContributionRow>(
    ({ from, to }) => {
      let query = supabase
        .from('association_member_contributions')
        .select(CONTRIBUTION_COLUMNS)
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
      if (memberId) query = query.eq('member_id', memberId)
      return query
    },
    { dedupeBy: (row) => row.id },
  )
}

export async function recordContribution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof CreateAssociationContributionSchema>,
): Promise<AssociationContributionRow> {
  const { data: member, error: memberError } = await supabase
    .from('association_members')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', input.member_id)
    .maybeSingle()
  if (memberError) throw memberError
  if (!member) throw new AssociationRegisterError('ASSOCIATION_MEMBER_NOT_FOUND')

  const { data, error } = await supabase
    .from('association_member_contributions')
    .insert({
      company_id: companyId,
      user_id: userId,
      member_id: input.member_id,
      kind: input.kind,
      units: input.units,
      amount: roundOre(input.amount),
      paid_on: input.paid_on,
      journal_entry_id: input.journal_entry_id ?? null,
      notes: input.notes ?? null,
    })
    .select(CONTRIBUTION_COLUMNS)
    .single()
  if (error) throw error
  const row = data as AssociationContributionRow
  await appendEvent(supabase, companyId, userId, input.member_id, 'contribution', input.paid_on, {
    contribution_id: row.id,
    kind: input.kind,
    units: input.units,
    amount: roundOre(input.amount),
  })
  return row
}

/**
 * Repay (exit, EFL 10 kap. 11 §; redemption of förlagsinsatser, 11 kap. 7 §)
 * or forfeit a contribution. Repayment requires the member to have left and
 * may not exceed the paid amount; a partial repayment keeps the row as
 * repaid with the smaller amount recorded in the event.
 */
export async function settleContribution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  contributionId: string,
  input: z.infer<typeof SettleAssociationContributionSchema>,
): Promise<AssociationContributionRow> {
  const { data: existing, error: readError } = await supabase
    .from('association_member_contributions')
    .select(CONTRIBUTION_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', contributionId)
    .maybeSingle()
  if (readError) throw readError
  if (!existing) throw new AssociationRegisterError('ASSOCIATION_CONTRIBUTION_NOT_FOUND')
  const contribution = existing as AssociationContributionRow
  if (contribution.status !== 'paid') {
    throw new AssociationRegisterError('ASSOCIATION_CONTRIBUTION_ALREADY_SETTLED')
  }
  const paidAmount = roundOre(Number(contribution.amount))
  const settledAmount = input.amount === undefined ? paidAmount : roundOre(input.amount)

  if (input.status === 'repaid') {
    if (settledAmount > paidAmount) {
      throw new AssociationRegisterError('ASSOCIATION_REPAYMENT_EXCEEDS_CONTRIBUTION')
    }
    // Förlagsinsatser are redeemed under EFL 11 kap. 7 § regardless of
    // membership; member insatser only after the member has left.
    if (contribution.kind !== 'forlags') {
      const { data: member, error: memberError } = await supabase
        .from('association_members')
        .select('id, exited_on')
        .eq('company_id', companyId)
        .eq('id', contribution.member_id)
        .maybeSingle()
      if (memberError) throw memberError
      if (!member || !(member as { exited_on: string | null }).exited_on) {
        throw new AssociationRegisterError('ASSOCIATION_REPAYMENT_BEFORE_EXIT')
      }
    }
  }

  const { data, error } = await supabase
    .from('association_member_contributions')
    .update({
      status: input.status,
      settled_on: input.settled_on,
      settlement_journal_entry_id: input.settlement_journal_entry_id ?? null,
      notes: input.notes ?? contribution.notes,
    })
    .eq('company_id', companyId)
    .eq('id', contributionId)
    .select(CONTRIBUTION_COLUMNS)
    .single()
  if (error) throw error
  await appendEvent(supabase, companyId, userId, contribution.member_id, 'settlement', input.settled_on, {
    contribution_id: contributionId,
    status: input.status,
    amount: settledAmount,
    paid_amount: paidAmount,
  })
  return data as AssociationContributionRow
}

export interface MemberCapitalReconciliationLine {
  label: string
  accounts: readonly string[]
  register_amount: number
  ledger_balance: number
  difference: number
}

export interface MemberCapitalReconciliation {
  fiscal_period_id: string
  lines: MemberCapitalReconciliationLine[]
  is_reconciled: boolean
}

/**
 * Register sums (status paid) against the ledger's closing credit balances
 * on the member-capital accounts. A difference is a finding for the bokslut,
 * never something the register fabricates (design section 5).
 */
export async function memberCapitalReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<MemberCapitalReconciliation> {
  const [contributions, trialBalance] = await Promise.all([
    listContributions(supabase, companyId),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
  ])
  const balanceOf = (accounts: readonly string[]): number =>
    roundOre(
      trialBalance.rows
        .filter((row) => accounts.includes(row.account_number))
        .reduce((sum, row) => sum + (row.closing_credit ?? 0) - (row.closing_debit ?? 0), 0),
    )
  const registerSum = (kinds: AssociationContributionKind[]): number =>
    roundOre(
      contributions
        .filter((c) => c.status === 'paid' && kinds.includes(c.kind))
        .reduce((sum, c) => sum + Number(c.amount), 0),
    )
  const lines: MemberCapitalReconciliationLine[] = [
    { label: 'Medlemsinsatser (2083)', accounts: ['2083'], register_amount: registerSum(['obligatory', 'over']), ledger_balance: 0, difference: 0 },
    { label: 'Insatsemission (2087)', accounts: ['2087'], register_amount: registerSum(['emission']), ledger_balance: 0, difference: 0 },
    { label: 'Förlagsinsatser (2084)', accounts: ['2084'], register_amount: registerSum(['forlags']), ledger_balance: 0, difference: 0 },
  ].map((line) => {
    const ledger = balanceOf(line.accounts)
    return { ...line, ledger_balance: ledger, difference: roundOre(ledger - line.register_amount) }
  })
  return {
    fiscal_period_id: fiscalPeriodId,
    lines,
    is_reconciled: lines.every((line) => line.difference === 0),
  }
}

/** The medlemsförteckning extract (EFL 5 kap. 2 §), one row per member. */
export interface MemberRegisterExtractRow {
  member_number: string
  name: string
  postal_address: string | null
  admitted_on: string
  exited_on: string | null
  contribution_units: number
  contribution_amount: number
  forlagsinsats_amount: number
}

export async function memberRegisterExtract(
  supabase: SupabaseClient,
  companyId: string,
): Promise<MemberRegisterExtractRow[]> {
  const [members, contributions] = await Promise.all([
    listMembers(supabase, companyId, { includeExited: true }),
    listContributions(supabase, companyId),
  ])
  return members.map((member) => {
    const own = contributions.filter((c) => c.member_id === member.id && c.status === 'paid')
    const memberInsatser = own.filter((c) => c.kind !== 'forlags')
    return {
      member_number: member.member_number,
      name: member.name,
      postal_address: member.postal_address,
      admitted_on: member.admitted_on,
      exited_on: member.exited_on,
      contribution_units: memberInsatser.reduce((sum, c) => sum + c.units, 0),
      contribution_amount: roundOre(memberInsatser.reduce((sum, c) => sum + Number(c.amount), 0)),
      forlagsinsats_amount: roundOre(
        own.filter((c) => c.kind === 'forlags').reduce((sum, c) => sum + Number(c.amount), 0),
      ),
    }
  })
}

export function memberRegisterCsv(rows: MemberRegisterExtractRow[]): string {
  const escape = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = [
    'Medlemsnummer',
    'Namn',
    'Postadress',
    'Inträde',
    'Utträde',
    'Antal insatser',
    'Insatsbelopp',
    'Förlagsinsatser',
  ]
  const lines = rows.map((row) =>
    [
      row.member_number,
      row.name,
      row.postal_address,
      row.admitted_on,
      row.exited_on,
      row.contribution_units,
      row.contribution_amount,
      row.forlagsinsats_amount,
    ]
      .map(escape)
      .join(';'),
  )
  return [header.join(';'), ...lines].join('\n') + '\n'
}

async function appendEvent(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  memberId: string,
  eventType: 'admission' | 'exit_notice' | 'exit' | 'expulsion' | 'transfer' | 'contribution' | 'settlement' | 'note',
  occurredOn: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('association_member_events').insert({
    company_id: companyId,
    user_id: userId,
    member_id: memberId,
    event_type: eventType,
    occurred_on: occurredOn,
    details,
  })
  if (error) throw error
}
