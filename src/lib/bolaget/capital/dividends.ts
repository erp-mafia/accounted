/**
 * The dividend register: a vinstutdelning from the stämma's decision to the
 * payout, split per holder from the aktiebok and booked through the engine.
 *
 *   createDividend   records the decision (ABL 18 kap.) and splits it over
 *                    the holders on the decisive day; checks it against
 *                    fritt eget kapital (17:3) and warns.
 *   bookDividend     books the decision (D 2098 or 2091 / K 2898) on the
 *                    decision day and freezes the split; refuses a dividend
 *                    above the fritt eget kapital.
 *   payDividend      books the payout (D 2898 / K bank), or links the payout
 *                    verifikat already booked from the bank.
 *   cancelDividend   a decided dividend not yet booked.
 *   recordLedgerDividend
 *                    the one-time "who received" step for a dividend booked
 *                    before the aktiebok existed: recipients and amounts
 *                    entered by hand against the 2898 payout already in the
 *                    ledger, so KU31 can be filed for it.
 *
 * The functions take plain inputs, so a stämma decision (W2) or an owner
 * tax view (W4) can call them. Every write is dry-runnable; the dry run
 * answers what the approver sees.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { roundOre, sumOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { ensureRegisterParty, loadRegisterParties, type PartyRef } from '../people'
import { loadShareRegisterData } from '../share-register'
import { HOLDING_KINDS, type RegisterParty } from '../types'
import { splitDividend, type DistributionRow } from './dividend-math'
import { checkFreeEquity, type FreeEquityCheck } from './free-equity'
import { dividendDecisionLines, dividendPayoutLines, postCapitalEntry } from './postings'
import { syncKu31Deadline, upsertCapitalDeadline } from './deadlines'
import {
  DIVIDEND_LIABILITY_ACCOUNT,
  type DividendDecidedBy,
  type DividendSourceAccount,
  type DividendStatus,
  type RecordDateBasis,
} from './types'

export interface DividendRow {
  id: string
  company_id: string
  decided_on: string
  decided_by: DividendDecidedBy
  decision_id: string | null
  document_id: string | null
  origin: 'register' | 'ledger'
  share_class_ids: string[] | null
  amount_per_share: number | null
  total_amount: number
  record_date: string
  record_date_basis: RecordDateBasis
  payment_date: string
  source_account: DividendSourceAccount | null
  prudence_confirmed: boolean
  equity_check: Record<string, unknown>
  status: DividendStatus
  decision_entry_id: string | null
  payout_entry_id: string | null
  paid_on: string | null
  note: string | null
  created_at: string
}

export interface DistributionRecord {
  party_id: string
  share_count: number
  amount: number
  by_class: Array<{ share_class_id: string; code: string; shares: number }>
}


function normaliseDividend(row: Record<string, unknown>): DividendRow {
  return {
    ...(row as unknown as DividendRow),
    total_amount: Number(row.total_amount),
    amount_per_share: row.amount_per_share === null || row.amount_per_share === undefined ? null : Number(row.amount_per_share),
  }
}

function warning(code: string, sv: string, en: string): OperationWarning {
  return { code, message_sv: sv, message_en: en }
}

export async function loadDividends(supabase: SupabaseClient, companyId: string): Promise<DividendRow[]> {
  const { data, error } = await supabase
    .from('dividends')
    .select('id, company_id, decided_on, decided_by, decision_id, document_id, origin, share_class_ids, amount_per_share, total_amount, record_date, record_date_basis, payment_date, source_account, prudence_confirmed, equity_check, status, decision_entry_id, payout_entry_id, paid_on, note, created_at')
    .eq('company_id', companyId)
    .order('decided_on', { ascending: false })
  if (error) throw new Error(`dividends read failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normaliseDividend)
}

export async function loadDividend(supabase: SupabaseClient, companyId: string, id: string): Promise<DividendRow | null> {
  const { data, error } = await supabase.from('dividends').select('id, company_id, decided_on, decided_by, decision_id, document_id, origin, share_class_ids, amount_per_share, total_amount, record_date, record_date_basis, payment_date, source_account, prudence_confirmed, equity_check, status, decision_entry_id, payout_entry_id, paid_on, note, created_at').eq('company_id', companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(`dividends read failed: ${error.message}`)
  return data ? normaliseDividend(data as Record<string, unknown>) : null
}

export async function loadDistributions(supabase: SupabaseClient, companyId: string, dividendIds: string[]): Promise<Map<string, DistributionRecord[]>> {
  const out = new Map<string, DistributionRecord[]>()
  if (dividendIds.length === 0) return out
  const { data, error } = await supabase
    .from('dividend_distributions')
    .select('dividend_id, party_id, share_count, amount, by_class')
    .eq('company_id', companyId)
    .in('dividend_id', dividendIds)
  if (error) throw new Error(`dividend_distributions read failed: ${error.message}`)
  for (const row of (data ?? []) as Array<{ dividend_id: string; party_id: string; share_count: number | string; amount: number | string; by_class: DistributionRecord['by_class'] }>) {
    const list = out.get(row.dividend_id) ?? []
    list.push({ party_id: row.party_id, share_count: Number(row.share_count), amount: Number(row.amount), by_class: row.by_class ?? [] })
    out.set(row.dividend_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => b.amount - a.amount || a.party_id.localeCompare(b.party_id))
  return out
}

// ── The split ────────────────────────────────────────────────────────

interface SplitResult {
  rows: DistributionRow[]
  total: number
  totalShares: number
  amountPerShare: number | null
  parties: Map<string, RegisterParty>
  asOf: string
  warnings: OperationWarning[]
  isAvstamningsbolag: boolean
}

async function splitFromRegister(
  ctx: OperationContext,
  args: { recordDate: string; decidedOn: string; paymentDate: string; shareClassIds: string[] | null; amountPerShare: number | null; total: number | null },
): Promise<SplitResult> {
  const today = todayIsoStockholm()
  const asOf = args.recordDate > today ? today : args.recordDate
  const data = await loadShareRegisterData(ctx, asOf)
  const warnings: OperationWarning[] = []
  if (args.recordDate > today) {
    warnings.push(warning(
      'DIVIDEND_RECORD_DATE_AHEAD',
      `Avstämningen sker ${args.recordDate}; fördelningen bygger på aktieboken i dag. Byter aktier ägare före dess, kontrollera fördelningen innan utdelningen bokförs.`,
      `The decisive day is ${args.recordDate}; the split uses today's register. If shares change hands before then, check the split before booking.`,
    ))
  }
  const changed = data.events.some(
    (e) => HOLDING_KINDS.includes(e.kind) && e.event_date > args.decidedOn && e.event_date <= args.paymentDate && args.paymentDate !== args.decidedOn,
  )
  if (changed) {
    warnings.push(warning(
      'DIVIDEND_OWNERSHIP_CHANGED',
      'Aktier har bytt ägare mellan beslutsdagen och betalningsdagen. Kontrollera vilken dag som avgör vem som får utdelningen.',
      'Shares changed hands between the decision and the payment day. Check which day decides who receives the dividend.',
    ))
  }
  const split = splitDividend(
    data.summary.holders.map((h) => ({ party_id: h.party_id, by_class: h.by_class })),
    args.amountPerShare !== null ? { kind: 'per_share', amount_per_share: args.amountPerShare } : { kind: 'total', total: args.total ?? 0 },
    args.shareClassIds,
  )
  return {
    rows: split.rows,
    total: split.total,
    totalShares: split.total_shares,
    amountPerShare: split.amount_per_share,
    parties: data.parties,
    asOf,
    warnings,
    isAvstamningsbolag: data.is_avstamningsbolag,
  }
}

function equityWarnings(check: FreeEquityCheck, prudenceConfirmed: boolean, blocking: boolean): OperationWarning[] {
  const out: OperationWarning[] = []
  if (check.basis === 'unavailable') {
    out.push(warning(
      'DIVIDEND_EQUITY_UNCHECKED',
      'Det fria egna kapitalet kunde inte kontrolleras: det finns inget tidigare räkenskapsår med bokföring här. Kontrollera beloppsspärren mot den senast fastställda balansräkningen (17 kap. 3 § ABL).',
      'Free equity could not be checked: no earlier fiscal year with bookkeeping is in the books. Check the limit against the last adopted balance sheet (ABL 17:3).',
    ))
  } else {
    if (!check.adopted_on) {
      out.push(warning(
        'DIVIDEND_BALANCE_SHEET_NOT_ADOPTED',
        `Inget datum för årsstämman är registrerat för räkenskapsåret som slutade ${check.balance_date}. Utdelning får bara ske på grundval av en fastställd balansräkning (17 kap. 3 § ABL).`,
        `No årsstämma date is recorded for the fiscal year ending ${check.balance_date}. A dividend rests on an adopted balance sheet (ABL 17:3).`,
      ))
    }
    if (check.exceeds && !blocking) {
      out.push(warning(
        'DIVIDEND_EXCEEDS_FREE_EQUITY',
        `Utdelningen (${check.amount} kr) överstiger det fria egna kapitalet som finns kvar (${check.available} kr). Den kan inte bokföras (17 kap. 3 § ABL).`,
        `The dividend (${check.amount} kr) exceeds the free equity left (${check.available} kr). It cannot be booked (ABL 17:3).`,
      ))
    }
  }
  if (!prudenceConfirmed) {
    out.push(warning(
      'DIVIDEND_PRUDENCE_UNCONFIRMED',
      'Bekräfta att utdelningen är försvarlig med hänsyn till bolagets kapitalbehov, likviditet och ställning (försiktighetsregeln, 17 kap. 3 § andra stycket ABL).',
      'Confirm the dividend is justifiable given the company\'s capital needs, liquidity and position (prudence rule, ABL 17:3 second paragraph).',
    ))
  }
  return out
}

function identityWarnings(rows: readonly DistributionRecord[], parties: Map<string, RegisterParty>): OperationWarning[] {
  const missing = rows.filter((r) => parties.get(r.party_id)?.kind === 'person' && !parties.get(r.party_id)?.personnummer_masked)
  if (missing.length === 0) return []
  return [warning(
    'DIVIDEND_HOLDER_IDENTITY_MISSING',
    `${missing.length === 1 ? 'En mottagare' : `${missing.length} mottagare`} saknar personnummer. Lägg till det under Ägare och aktiebok innan kontrolluppgiften KU31 skapas.`,
    `${missing.length} recipient(s) have no personnummer. Add it under Ägare och aktiebok before the KU31 file is made.`,
  )]
}

function previewHolders(rows: readonly DistributionRecord[], parties: Map<string, RegisterParty>) {
  return rows.map((r) => {
    const p = parties.get(r.party_id)
    return {
      party_id: r.party_id,
      name: p?.name ?? '',
      kind: p?.kind ?? 'person',
      identity: p ? (p.kind === 'company' ? p.org_number : p.personnummer_masked) : null,
      share_count: r.share_count,
      amount: r.amount,
    }
  })
}

function equitySummary(check: FreeEquityCheck) {
  return {
    basis: check.basis,
    balance_date: check.balance_date,
    adopted_on: check.adopted_on,
    free_equity: check.free_equity,
    later_transfers: check.later_transfers,
    available: check.available,
    exceeds: check.exceeds,
  }
}

async function replaceDistributions(ctx: OperationContext, dividendId: string, rows: readonly DistributionRecord[]): Promise<void> {
  const { error: deleteError } = await ctx.supabase.from('dividend_distributions').delete().eq('company_id', ctx.companyId).eq('dividend_id', dividendId)
  if (deleteError) throw new Error(`dividend_distributions delete failed: ${deleteError.message}`)
  // One insert per holder, as a literal row the schema guard can check (a company has few holders).
  for (const r of rows) {
    const { error } = await ctx.supabase.from('dividend_distributions').insert({
      company_id: ctx.companyId,
      dividend_id: dividendId,
      party_id: r.party_id,
      share_count: r.share_count,
      amount: r.amount,
      by_class: r.by_class,
    })
    if (error) throw new Error(`dividend_distributions insert failed: ${error.message}`)
  }
}

/**
 * Whether a conditional update (status still where the caller found it)
 * moved the row: the claim that keeps two approvals from both posting.
 * False when another call got there first.
 */
function claimed(result: { data: unknown; error: { message: string } | null }): boolean {
  if (result.error) throw new Error(`dividends update failed: ${result.error.message}`)
  return Array.isArray(result.data) && result.data.length > 0
}

/** A released claim (its posting failed, no verifikat id written) only logs when the release itself fails. */
function released(ctx: OperationContext, dividendId: string, result: { error: { message: string } | null }): void {
  if (result.error) ctx.log.error('[bolaget] dividend claim not released', new Error(result.error.message), { companyId: ctx.companyId, dividendId })
}

// ── Create ───────────────────────────────────────────────────────────

export interface DividendInput {
  decided_on: string
  decided_by: DividendDecidedBy
  decision_id?: string | null
  document_id?: string | null
  /** One of the two: the amount per share (ABL 18:3), or a total to split. */
  amount_per_share?: number | null
  total_amount?: number | null
  /** The classes the dividend is paid on; all when empty. */
  share_class_ids?: string[] | null
  record_date_basis?: RecordDateBasis | null
  /** Required when the basis is 'other'. */
  record_date?: string | null
  /** The betalningsdag (ABL 18:3); the decision day when absent. */
  payment_date?: string | null
  prudence_confirmed?: boolean | null
  note?: string | null
}

export interface DividendCreated {
  dividend_id: string
  status: DividendStatus
  total_amount: number
  record_date: string
  payment_date: string
  distributions: Array<{ party_id: string; share_count: number; amount: number }>
}

export function resolveDividendDates(input: Pick<DividendInput, 'decided_on' | 'payment_date' | 'record_date_basis' | 'record_date'>):
  | { ok: true; paymentDate: string; recordDate: string; basis: RecordDateBasis }
  | { ok: false; messageSv: string } {
  const paymentDate = input.payment_date ?? input.decided_on
  if (paymentDate < input.decided_on) return { ok: false, messageSv: 'Betalningsdagen kan inte ligga före beslutsdagen.' }
  const basis: RecordDateBasis = input.record_date_basis ?? 'decision_date'
  if (basis === 'other' && !input.record_date) return { ok: false, messageSv: 'Ange vilken dag som avgör vem som får utdelningen.' }
  const recordDate = basis === 'decision_date' ? input.decided_on : basis === 'payment_date' ? paymentDate : input.record_date!
  return { ok: true, paymentDate, recordDate, basis }
}

export async function createDividend(ctx: OperationContext, input: DividendInput, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<DividendCreated>> {
  const today = todayIsoStockholm()
  if (input.decided_on > today) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Beslutsdagen kan inte ligga i framtiden.' }
  const hasPerShare = typeof input.amount_per_share === 'number'
  const hasTotal = typeof input.total_amount === 'number'
  if (hasPerShare === hasTotal) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange antingen belopp per aktie eller ett totalbelopp.' }
  }
  const dates = resolveDividendDates(input)
  if (!dates.ok) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: dates.messageSv }
  const shareClassIds = input.share_class_ids && input.share_class_ids.length > 0 ? [...new Set(input.share_class_ids)] : null

  const split = await splitFromRegister(ctx, {
    recordDate: dates.recordDate,
    decidedOn: input.decided_on,
    paymentDate: dates.paymentDate,
    shareClassIds,
    amountPerShare: hasPerShare ? input.amount_per_share! : null,
    total: hasTotal ? input.total_amount! : null,
  })
  if (split.isAvstamningsbolag) return { ok: false, code: 'SHARE_REGISTER_AVSTAMNINGSBOLAG' }
  if (split.rows.length === 0 || split.total <= 0) return { ok: false, code: 'DIVIDEND_NO_HOLDERS' }

  const check = await checkFreeEquity(ctx.supabase, ctx.companyId, input.decided_on, split.total)
  const warnings = [
    ...split.warnings,
    ...equityWarnings(check, input.prudence_confirmed === true, false),
    ...identityWarnings(split.rows, split.parties),
  ]
  if (input.decided_by === 'extra_stamma') {
    warnings.push(warning(
      'DIVIDEND_EXTRA_STAMMA_REGISTRATION',
      'Ett beslut om utdelning på en extra bolagsstämma ska genast anmälas till Bolagsverket för registrering (18 kap. 10 § ABL).',
      'A dividend decided at an extra general meeting is filed with Bolagsverket for registration at once (ABL 18:10).',
    ))
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        decided_on: input.decided_on,
        decided_by: input.decided_by,
        record_date: dates.recordDate,
        record_date_basis: dates.basis,
        payment_date: dates.paymentDate,
        register_as_of: split.asOf,
        amount_per_share: split.amountPerShare,
        total_amount: split.total,
        total_shares: split.totalShares,
        holders: previewHolders(split.rows, split.parties),
        equity: equitySummary(check),
        warnings: warnings.map((w) => w.message_sv),
      },
    }
  }

  const { data, error } = await ctx.supabase
    .from('dividends')
    .insert({
      company_id: ctx.companyId,
      decided_on: input.decided_on,
      decided_by: input.decided_by,
      decision_id: input.decision_id ?? null,
      document_id: input.document_id ?? null,
      origin: 'register',
      share_class_ids: shareClassIds,
      amount_per_share: split.amountPerShare,
      total_amount: split.total,
      record_date: dates.recordDate,
      record_date_basis: dates.basis,
      payment_date: dates.paymentDate,
      prudence_confirmed: input.prudence_confirmed === true,
      equity_check: equitySummary(check),
      status: 'decided',
      note: input.note?.trim() || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single()
  if (error) throw new Error(`dividends insert failed: ${error.message}`)
  const dividendId = (data as { id: string }).id
  await replaceDistributions(ctx, dividendId, split.rows)

  if (input.decided_by === 'extra_stamma') {
    await upsertCapitalDeadline(ctx, {
      sourceKey: `bolaget:dividend:${dividendId}:registration`,
      title: 'Anmäl utdelningsbeslutet från extra bolagsstämma till Bolagsverket',
      dueOn: input.decided_on,
      priority: 'important',
      notes: `Utdelning beslutad på extra bolagsstämma ${input.decided_on}. Beslutet ska genast anmälas för registrering (18 kap. 10 § ABL).`,
    })
  }

  return {
    ok: true,
    data: {
      dividend_id: dividendId,
      status: 'decided',
      total_amount: split.total,
      record_date: dates.recordDate,
      payment_date: dates.paymentDate,
      distributions: split.rows.map((r) => ({ party_id: r.party_id, share_count: r.share_count, amount: r.amount })),
    },
    created: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ── Book the decision ────────────────────────────────────────────────

/** 2098 while it holds the result the dividend is taken from (before the stämma moved it to 2091), else 2091. */
export async function chooseSourceAccount(supabase: SupabaseClient, companyId: string, decidedOn: string, total: number): Promise<DividendSourceAccount> {
  const periodId = await findFiscalPeriod(supabase, companyId, decidedOn)
  if (!periodId) return '2091'
  const tb = await generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'include', toDate: decidedOn })
  const row = tb.rows.find((r) => r.account_number === '2098')
  const credit = row ? roundOre(row.closing_credit - row.closing_debit) : 0
  return credit >= roundOre(total) ? '2098' : '2091'
}

export interface BookDividendInput {
  dividend_id: string
  source_account?: DividendSourceAccount | null
  /** Confirms the prudence assessment (ABL 17:3 second paragraph) at booking. */
  prudence_confirmed?: boolean | null
}

export interface DividendBooked {
  dividend_id: string
  status: DividendStatus
  decision_entry_id: string
  source_account: DividendSourceAccount
  total_amount: number
}

export async function bookDividend(ctx: OperationContext, input: BookDividendInput, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<DividendBooked>> {
  const dividend = await loadDividend(ctx.supabase, ctx.companyId, input.dividend_id)
  if (!dividend) return { ok: false, code: 'DIVIDEND_NOT_FOUND' }
  if (dividend.status !== 'decided') return { ok: false, code: 'DIVIDEND_STATUS_INVALID', details: { status: dividend.status } }

  let rows: DistributionRecord[] = (await loadDistributions(ctx.supabase, ctx.companyId, [dividend.id])).get(dividend.id) ?? []
  let total = dividend.total_amount
  let parties = new Map<string, RegisterParty>()
  const warnings: OperationWarning[] = []
  if (dividend.origin === 'register') {
    const split = await splitFromRegister(ctx, {
      recordDate: dividend.record_date,
      decidedOn: dividend.decided_on,
      paymentDate: dividend.payment_date,
      shareClassIds: dividend.share_class_ids,
      amountPerShare: dividend.amount_per_share,
      total: dividend.amount_per_share === null ? dividend.total_amount : null,
    })
    if (split.rows.length === 0) return { ok: false, code: 'DIVIDEND_NO_HOLDERS' }
    rows = split.rows
    total = split.total
    parties = split.parties
    warnings.push(...split.warnings)
  } else {
    parties = await loadRegisterParties(ctx.companyId, rows.map((r) => r.party_id))
  }

  const check = await checkFreeEquity(ctx.supabase, ctx.companyId, dividend.decided_on, total, dividend.id)
  if (check.exceeds) {
    return {
      ok: false,
      code: 'DIVIDEND_EXCEEDS_FREE_EQUITY',
      details: { amount: check.amount, available: check.available, free_equity: check.free_equity, later_transfers: check.later_transfers, balance_date: check.balance_date },
    }
  }
  const prudence = dividend.prudence_confirmed || input.prudence_confirmed === true
  warnings.push(...equityWarnings(check, prudence, true), ...identityWarnings(rows, parties))

  const source = input.source_account ?? (await chooseSourceAccount(ctx.supabase, ctx.companyId, dividend.decided_on, total))
  const lines = dividendDecisionLines(source, total)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        dividend_id: dividend.id,
        entry_date: dividend.decided_on,
        source_account: source,
        total_amount: total,
        lines: lines.map((l) => ({ account_number: l.account_number, debit: l.debit_amount, credit: l.credit_amount })),
        holders: previewHolders(rows, parties),
        equity: equitySummary(check),
        warnings: warnings.map((w) => w.message_sv),
      },
    }
  }

  // The split as booked: refreshed from the register while the dividend is still decided.
  if (dividend.origin === 'register') await replaceDistributions(ctx, dividend.id, rows)
  // Claim the step before posting, so two approvals racing each other cannot both post.
  const booking = await ctx.supabase
    .from('dividends')
    .update({ status: 'booked', source_account: source, total_amount: total, prudence_confirmed: prudence, equity_check: equitySummary(check) })
    .eq('company_id', ctx.companyId)
    .eq('id', dividend.id)
    .eq('status', 'decided')
    .select('id')
  if (!claimed(booking)) return { ok: false, code: 'DIVIDEND_STATUS_INVALID' }
  let entry: { id: string }
  try {
    entry = await postCapitalEntry({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      entryDate: dividend.decided_on,
      description: `Beslutad utdelning ${dividend.decided_on}`,
      lines,
      category: 'owner.transfer',
      pendingOperationId: ctx.pendingOperationId ?? null,
    })
  } catch (error) {
    // Nothing was posted: release the claim, then let the engine's refusal (a locked period, a closed year) reach the caller.
    released(
      ctx,
      dividend.id,
      await ctx.supabase
        .from('dividends')
        .update({ status: 'decided' })
        .eq('company_id', ctx.companyId)
        .eq('id', dividend.id)
        .eq('status', 'booked')
        .is('decision_entry_id', null),
    )
    throw error
  }
  const { error } = await ctx.supabase
    .from('dividends')
    .update({ decision_entry_id: entry.id })
    .eq('company_id', ctx.companyId)
    .eq('id', dividend.id)
  if (error) {
    ctx.log.error('[bolaget] dividend booked but not marked', new Error(error.message), { companyId: ctx.companyId, dividendId: dividend.id })
    return { ok: false, code: 'DIVIDEND_UPDATE_FAILED', partialPostedIds: { decision_entry_id: entry.id } }
  }
  await syncKu31Deadline(ctx, Number(dividend.payment_date.slice(0, 4)))
  return {
    ok: true,
    data: { dividend_id: dividend.id, status: 'booked', decision_entry_id: entry.id, source_account: source, total_amount: total },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ── Pay ──────────────────────────────────────────────────────────────

export interface PayDividendInput {
  dividend_id: string
  /** The day the money left; the betalningsdag when absent. */
  paid_on?: string | null
  /** The bank account the payout is booked from (19xx). */
  bank_account?: string | null
  /** A payout verifikat already booked (D 2898 / K bank): linked, nothing new is booked. */
  journal_entry_id?: string | null
}

export interface DividendPaid {
  dividend_id: string
  status: DividendStatus
  payout_entry_id: string
  paid_on: string
  linked: boolean
}

interface PayoutLine {
  journal_entry_id: string
  account_number: string
  debit_amount: number | string
  journal_entries: { id: string; voucher_series: string | null; voucher_number: number | null; entry_date: string; description: string | null }
}

/** The 2898 debit lines of posted verifikat of this company, read entry first (lib/bookkeeping/entry-lines.ts). */
async function payoutLines(
  supabase: SupabaseClient,
  companyId: string,
  filter: { entryId: string } | { year: number },
): Promise<PayoutLine[]> {
  return fetchEntryLines<PayoutLine>({
    supabase,
    entryColumns: 'id, voucher_series, voucher_number, entry_date, description',
    lineColumns: 'journal_entry_id, account_number, debit_amount',
    filterEntries: (q) => {
      const base = q.eq('company_id', companyId).eq('status', 'posted')
      return 'entryId' in filter ? base.eq('id', filter.entryId) : base.gte('entry_date', `${filter.year}-01-01`).lte('entry_date', `${filter.year}-12-31`)
    },
    filterLines: (q) => q.eq('account_number', DIVIDEND_LIABILITY_ACCOUNT),
  })
}

/** The 2898 debit of a posted verifikat of this company, or null when it is not one. */
async function payoutEntryDebit(supabase: SupabaseClient, companyId: string, entryId: string): Promise<number | null> {
  const lines = await payoutLines(supabase, companyId, { entryId })
  if (lines.length === 0) return null
  return sumOre(lines.map((l) => Number(l.debit_amount)))
}

export async function payDividend(ctx: OperationContext, input: PayDividendInput, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<DividendPaid>> {
  const dividend = await loadDividend(ctx.supabase, ctx.companyId, input.dividend_id)
  if (!dividend) return { ok: false, code: 'DIVIDEND_NOT_FOUND' }
  if (dividend.status !== 'booked') return { ok: false, code: 'DIVIDEND_STATUS_INVALID', details: { status: dividend.status } }
  const paidOn = input.paid_on ?? dividend.payment_date
  if (paidOn > todayIsoStockholm()) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Utbetalningsdagen kan inte ligga i framtiden.' }
  if (paidOn < dividend.decided_on) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Utbetalningen kan inte ligga före beslutet.' }
  const warnings: OperationWarning[] = []

  if (input.journal_entry_id) {
    const debit = await payoutEntryDebit(ctx.supabase, ctx.companyId, input.journal_entry_id)
    if (debit === null || debit <= 0) return { ok: false, code: 'DIVIDEND_PAYOUT_ENTRY_INVALID' }
    if (roundOre(debit) !== roundOre(dividend.total_amount)) {
      warnings.push(warning(
        'DIVIDEND_PAYOUT_AMOUNT_DIFFERS',
        `Verifikatet debiterar 2898 med ${debit} kr, utdelningen är ${dividend.total_amount} kr. Kontrollera att hela utdelningen är utbetald.`,
        `The verifikat debits 2898 by ${debit} kr; the dividend is ${dividend.total_amount} kr. Check the whole dividend was paid.`,
      ))
    }
    if (dryRun) {
      return { ok: true, dryRun: true, preview: { dividend_id: dividend.id, paid_on: paidOn, link_entry_id: input.journal_entry_id, debit_2898: debit, warnings: warnings.map((w) => w.message_sv) } }
    }
    const link = await ctx.supabase
      .from('dividends')
      .update({ status: 'paid', paid_on: paidOn, payout_entry_id: input.journal_entry_id })
      .eq('company_id', ctx.companyId)
      .eq('id', dividend.id)
      .eq('status', 'booked')
      .select('id')
    if (!claimed(link)) return { ok: false, code: 'DIVIDEND_STATUS_INVALID' }
    await syncKu31Deadline(ctx, Number(dividend.payment_date.slice(0, 4)))
    return { ok: true, data: { dividend_id: dividend.id, status: 'paid', payout_entry_id: input.journal_entry_id, paid_on: paidOn, linked: true }, ...(warnings.length ? { warnings } : {}) }
  }

  const bank = input.bank_account ?? (await resolvePrimaryBankAccount(ctx.supabase, ctx.companyId, ctx.log))
  const lines = dividendPayoutLines(bank, dividend.total_amount)
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        dividend_id: dividend.id,
        paid_on: paidOn,
        total_amount: dividend.total_amount,
        lines: lines.map((l) => ({ account_number: l.account_number, debit: l.debit_amount, credit: l.credit_amount })),
        warnings: [],
      },
    }
  }
  const payout = await ctx.supabase
    .from('dividends')
    .update({ status: 'paid', paid_on: paidOn })
    .eq('company_id', ctx.companyId)
    .eq('id', dividend.id)
    .eq('status', 'booked')
    .select('id')
  if (!claimed(payout)) return { ok: false, code: 'DIVIDEND_STATUS_INVALID' }
  let entry: { id: string }
  try {
    entry = await postCapitalEntry({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      entryDate: paidOn,
      description: `Utbetald utdelning (beslut ${dividend.decided_on})`,
      lines,
      category: 'owner.transfer',
      pendingOperationId: ctx.pendingOperationId ?? null,
    })
  } catch (error) {
    released(
      ctx,
      dividend.id,
      await ctx.supabase
        .from('dividends')
        .update({ status: 'booked', paid_on: null })
        .eq('company_id', ctx.companyId)
        .eq('id', dividend.id)
        .eq('status', 'paid')
        .is('payout_entry_id', null),
    )
    throw error
  }
  const { error } = await ctx.supabase
    .from('dividends')
    .update({ payout_entry_id: entry.id })
    .eq('company_id', ctx.companyId)
    .eq('id', dividend.id)
  if (error) {
    ctx.log.error('[bolaget] dividend payout booked but not marked', new Error(error.message), { companyId: ctx.companyId, dividendId: dividend.id })
    return { ok: false, code: 'DIVIDEND_UPDATE_FAILED', partialPostedIds: { payout_entry_id: entry.id } }
  }
  await syncKu31Deadline(ctx, Number(dividend.payment_date.slice(0, 4)))
  return { ok: true, data: { dividend_id: dividend.id, status: 'paid', payout_entry_id: entry.id, paid_on: paidOn, linked: false } }
}

// ── Cancel ───────────────────────────────────────────────────────────

export async function cancelDividend(ctx: OperationContext, dividendId: string): Promise<OperationOutcome<{ dividend_id: string; status: DividendStatus }>> {
  const dividend = await loadDividend(ctx.supabase, ctx.companyId, dividendId)
  if (!dividend) return { ok: false, code: 'DIVIDEND_NOT_FOUND' }
  if (dividend.status !== 'decided') return { ok: false, code: 'DIVIDEND_STATUS_INVALID', details: { status: dividend.status } }
  const { error } = await ctx.supabase.from('dividends').update({ status: 'cancelled' }).eq('company_id', ctx.companyId).eq('id', dividend.id)
  if (error) throw new Error(`dividends update failed: ${error.message}`)
  return { ok: true, data: { dividend_id: dividend.id, status: 'cancelled' } }
}

// ── Who received (dividends booked before the aktiebok) ──────────────

export interface LedgerPayout {
  journal_entry_id: string
  voucher: string
  entry_date: string
  description: string
  amount: number
}

/**
 * The payouts of a year in the ledger: posted verifikat that debit 2898,
 * not yet linked to a dividend in the register. The starting point of the
 * "who received" step for a dividend paid before the aktiebok existed.
 */
export async function listLedgerDividendPayouts(supabase: SupabaseClient, companyId: string, year: number): Promise<LedgerPayout[]> {
  const [lines, linked] = await Promise.all([
    payoutLines(supabase, companyId, { year }),
    supabase.from('dividends').select('payout_entry_id').eq('company_id', companyId).not('payout_entry_id', 'is', null),
  ])
  if (linked.error) throw new Error(`dividends read failed: ${linked.error.message}`)
  const taken = new Set(((linked.data ?? []) as Array<{ payout_entry_id: string }>).map((d) => d.payout_entry_id))
  const byEntry = new Map<string, LedgerPayout>()
  for (const line of lines) {
    if (taken.has(line.journal_entry_id)) continue
    const entry = line.journal_entries
    const current = byEntry.get(line.journal_entry_id) ?? {
      journal_entry_id: line.journal_entry_id,
      voucher: formatVoucher(entry ?? {}),
      entry_date: entry?.entry_date ?? '',
      description: entry?.description ?? '',
      amount: 0,
    }
    current.amount = roundOre(current.amount + Number(line.debit_amount))
    byEntry.set(line.journal_entry_id, current)
  }
  return [...byEntry.values()].filter((p) => p.amount > 0).sort((a, b) => a.entry_date.localeCompare(b.entry_date))
}

export interface LedgerDividendInput {
  decided_on: string
  decided_by: DividendDecidedBy
  /** The day the dividend was paid; the KU31 inkomstår follows it. */
  paid_on: string
  /** The payout verifikat in the ledger (D 2898). */
  payout_entry_id: string
  decision_entry_id?: string | null
  recipients: Array<PartyRef & { amount: number; share_count?: number | null }>
  note?: string | null
}

/**
 * Record who received a dividend the ledger already holds: the recipients
 * and their amounts are entered by hand (names here; personnummer in the
 * app's person form). Nothing is booked: the decision and the payout are
 * the verifikat already posted.
 */
export async function recordLedgerDividend(
  ctx: OperationContext,
  input: LedgerDividendInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<DividendCreated>> {
  if (input.paid_on < input.decided_on) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Utbetalningen kan inte ligga före beslutet.' }
  if (input.paid_on > todayIsoStockholm()) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Utbetalningsdagen kan inte ligga i framtiden.' }
  if (input.recipients.length === 0) return { ok: false, code: 'DIVIDEND_NO_HOLDERS' }
  const debit = await payoutEntryDebit(ctx.supabase, ctx.companyId, input.payout_entry_id)
  if (debit === null || debit <= 0) return { ok: false, code: 'DIVIDEND_PAYOUT_ENTRY_INVALID' }
  const total = sumOre(input.recipients.map((r) => r.amount))
  if (total !== roundOre(debit)) {
    return {
      ok: false,
      code: 'DIVIDEND_RECIPIENTS_MISMATCH',
      details: { recipients_total: total, payout: debit },
      messageSv: `Mottagarnas belopp (${total} kr) stämmer inte med utbetalningen på 2898 (${debit} kr).`,
    }
  }
  if (input.recipients.some((r) => !(r.amount > 0))) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Varje mottagare ska ha ett belopp över noll.' }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        decided_on: input.decided_on,
        paid_on: input.paid_on,
        payout_entry_id: input.payout_entry_id,
        total_amount: total,
        recipients: input.recipients.map((r) => ({ party_id: r.party_id ?? null, name: r.name ?? null, amount: roundOre(r.amount) })),
        warnings: [],
      },
    }
  }

  const partyIds: string[] = []
  for (const r of input.recipients) partyIds.push(await ensureRegisterParty(ctx, r))
  if (new Set(partyIds).size !== partyIds.length) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Samma mottagare finns med två gånger.' }

  const { data, error } = await ctx.supabase
    .from('dividends')
    .insert({
      company_id: ctx.companyId,
      decided_on: input.decided_on,
      decided_by: input.decided_by,
      origin: 'ledger',
      total_amount: total,
      record_date: input.decided_on,
      record_date_basis: 'decision_date',
      payment_date: input.paid_on,
      status: 'decided',
      decision_entry_id: input.decision_entry_id ?? null,
      note: input.note?.trim() || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single()
  if (error) throw new Error(`dividends insert failed: ${error.message}`)
  const dividendId = (data as { id: string }).id
  const rows = input.recipients.map((r, i) => ({ party_id: partyIds[i]!, share_count: r.share_count ?? 0, amount: roundOre(r.amount), by_class: [] }))
  await replaceDistributions(ctx, dividendId, rows)
  const { error: paidError } = await ctx.supabase
    .from('dividends')
    .update({ status: 'paid', paid_on: input.paid_on, payout_entry_id: input.payout_entry_id })
    .eq('company_id', ctx.companyId)
    .eq('id', dividendId)
  if (paidError) throw new Error(`dividends update failed: ${paidError.message}`)
  await syncKu31Deadline(ctx, Number(input.paid_on.slice(0, 4)))
  return {
    ok: true,
    data: {
      dividend_id: dividendId,
      status: 'paid',
      total_amount: total,
      record_date: input.decided_on,
      payment_date: input.paid_on,
      distributions: rows.map((r) => ({ party_id: r.party_id, share_count: r.share_count, amount: r.amount })),
    },
    created: true,
  }
}
