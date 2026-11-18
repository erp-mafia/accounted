#!/usr/bin/env -S npx tsx --conditions react-server
/**
 * Read-only reconciliation: every report agrees with every other.
 *
 * For every company and every fiscal year it runs the report generators the
 * app serves (saldobalans, huvudbok, balansräkning, balansrapport,
 * resultaträkning, resultatrapport, momsrapport, IB/UB continuity) and checks
 * the identities that must hold between them, to the öre:
 *
 *   ledger_balance     the saldobalans balances (debet = kredit), so the
 *                      balansräkning balances (tillgångar = EK + skulder)
 *   tb_vs_gl           saldobalans = huvudbok, per account: IB, debet,
 *                      kredit, UB
 *   bs_vs_tb           balansräkning = saldobalans class 1-2 (+ beräknat
 *                      resultat from everything else)
 *   br_vs_bs           balansrapport = balansräkning (totals, beräknat
 *                      resultat)
 *   is_vs_ledger       resultaträkning = huvudbok class 3-8, per account
 *   rr_vs_is           resultatrapport = resultaträkning (net result)
 *   result_vs_equity   årets resultat (resultaträkning) = change in eget
 *                      kapital on the balansräkning less owner/capital
 *                      movements; the residual is decomposed by cause
 *   continuity         IB of the year = UB of the year before, per account,
 *                      and result accounts open at zero
 *   vat_vs_26xx        momsrapport ruta 49 = movement on the moms accounts
 *                      (26xx) in each redovisningsperiod, outside the
 *                      momsredovisning verifikat; the residual is decomposed
 *   entry_outside_year verifikat whose date lies outside the fiscal year
 *                      they are booked in (saldobalans counts them by year,
 *                      momsrapport and derived IB by date)
 *
 * READ-ONLY BY CONSTRUCTION: the Supabase client is wrapped so that any
 * insert/update/upsert/delete, storage, functions or schema access throws,
 * and only the STABLE report RPCs listed in READ_RPCS can be called
 * (PostgREST runs STABLE functions in a read-only transaction). Nothing in
 * here writes; a code path that tried would fail loudly.
 *
 * Output (customer data: keep it outside the repo):
 *   <out>/companies/<company_id>.json   one result per company (resumable)
 *   <out>/findings.csv                  every disagreement, one per row
 *   <out>/summary.md                    counts per check and cause
 *
 * Usage:
 *   npx tsx --conditions react-server scripts/reconcile-reports.ts \
 *     --env-file .env.prod.local --out /tmp/reconcile [--concurrency 3] \
 *     [--company <uuid>[,<uuid>]] [--limit N] [--force] [--summarize-only]
 */

import { config } from 'dotenv'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

config({ path: arg('env-file') ?? '.env.local' })

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance, fetchTrialBalanceChart } from '../src/lib/reports/trial-balance'
import { generateGeneralLedger } from '../src/lib/reports/general-ledger'
import { balanceSheetFromTrialBalance } from '../src/lib/reports/balance-sheet'
import { generateIncomeStatement } from '../src/lib/reports/income-statement'
import { generateBalansrapport } from '../src/lib/reports/balansrapport'
import { generateResultatrapport } from '../src/lib/reports/resultatrapport'
import { validateBalanceContinuity } from '../src/lib/reports/continuity-check'
import {
  ACCOUNT_RUTA,
  RUTA_49_TERMS,
  calculatePeriodDates,
  loadVatDeclarationLedger,
  vatAccountsWithoutRuta,
  rutorFromTotals,
} from '../src/lib/reports/vat-declaration'
import type { DynamicVatAccounts } from '../src/lib/reports/vat-revenue-accounts'
import { resolvePreviousFiscalPeriod } from '../src/lib/core/bookkeeping/period-service'
import { fetchLinesByEntryIds } from '../src/lib/bookkeeping/entry-lines'
import { fetchAllRows } from '../src/lib/supabase/fetch-all'
import { roundOre } from '../src/lib/money'
import { isEntityType, resultClosingAccounts } from '../src/lib/company/entity-type'
import { isAretsResultatAccount } from '../src/lib/bookkeeping/bas-data/result-accounts'
import { isDeclarationVatAccount } from '../src/lib/vat/moms-box-mapping'
import type { TrialBalanceRow, VatPeriodType } from '../src/types'

// ── Read-only client ──────────────────────────────────────────────────────

/** The report RPCs this run may call. All STABLE + SECURITY INVOKER in production. */
const READ_RPCS = new Set([
  'get_trial_balance_aggregates',
  'compute_prior_opening_balances',
  'get_vat_declaration_totals',
  'result_closing_entry_ids',
  'year_end_chain_entry_ids',
  // The huvudbok and the Balansrapport header read through these.
  'get_ledger_line_counts',
  'get_general_ledger_lines',
  'get_general_ledger_account_page',
  'latest_posted_vouchers',
])

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const BLOCKED_MEMBERS = new Set(['storage', 'functions', 'schema', 'channel', 'realtime'])

let requestCount = 0

function readOnly(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => {
          const builder = target.from(table)
          return new Proxy(builder, {
            get(b, p, r) {
              if (typeof p === 'string' && WRITE_METHODS.has(p)) {
                return () => {
                  throw new Error(`read-only reconciliation: ${p} on ${table} is blocked`)
                }
              }
              const value = Reflect.get(b, p, r)
              return typeof value === 'function' ? value.bind(b) : value
            },
          })
        }
      }
      if (prop === 'rpc') {
        return (fn: string, args?: Record<string, unknown>) => {
          if (!READ_RPCS.has(fn)) {
            throw new Error(`read-only reconciliation: rpc ${fn} is not on the read allowlist`)
          }
          return target.rpc(fn, args)
        }
      }
      if (typeof prop === 'string' && BLOCKED_MEMBERS.has(prop)) {
        throw new Error(`read-only reconciliation: ${prop} is blocked`)
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Counts requests and retries transient gateway failures (all calls are reads). */
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    requestCount++
    try {
      const res = await fetch(input, init)
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
        continue
      }
      return res
    } catch (err) {
      if (attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

type Check =
  | 'ledger_balance'
  | 'tb_vs_gl'
  | 'bs_vs_tb'
  | 'br_vs_bs'
  | 'is_vs_ledger'
  | 'rr_vs_is'
  | 'result_vs_equity'
  | 'continuity'
  | 'vat_vs_26xx'
  | 'entry_outside_year'
  | 'report_error'

interface Finding {
  period_id: string
  period: string
  check: Check
  /** Short machine label for the explanation; several per check. */
  cause: string
  /** The disagreement in SEK (sign as documented per check). */
  amount: number
  detail: Record<string, unknown>
}

interface CompanyMeta {
  id: string
  name: string
  org_number: string | null
  entity_type: string | null
  archived: boolean
  sandbox: boolean
  migration_reset_source: boolean
  moms_period: string | null
  vat_registered: boolean | null
  accounting_method: string | null
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean | null
  closed_externally: boolean | null
  closing_entry_id: string | null
  opening_balance_entry_id: string | null
  previous_period_id: string | null
}

/** One huvudbok line, compacted: net is credit - debit. */
interface Line {
  a: string
  d: string
  e: string
  s: string
  debit: number
  credit: number
}

/** A verifikat tagged opening_balance (the IB tool, SIE #IB, the year-end roll-forward). */
interface IbEntry {
  id: string
  status: string
  entry_date: string
  fiscal_period_id: string
  created_at: string
  created_via: string | null
  import_batch_id: string | null
}

interface CompanyResult {
  company: CompanyMeta
  periods: Array<Pick<PeriodRow, 'id' | 'name' | 'period_start' | 'period_end' | 'is_closed'> & { entries: number }>
  findings: Finding[]
  ms: number
  requests: number
}

const off = (x: number) => Math.abs(roundOre(x)) >= 0.01
const r2 = (x: number) => roundOre(x)
const firstDigit = (account: string) => account.charAt(0)

// ── Company loop ──────────────────────────────────────────────────────────

async function reconcileCompany(sb: SupabaseClient, company: CompanyMeta): Promise<CompanyResult> {
  const started = Date.now()
  const requestsBefore = requestCount
  const findings: Finding[] = []

  const periods = await fetchAllRows<PeriodRow>(({ from, to }) =>
    sb
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, closed_externally, closing_entry_id, opening_balance_entry_id, previous_period_id')
      .eq('company_id', company.id)
      .order('period_start', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )

  const chart = await fetchTrialBalanceChart(sb, company.id)
  const tbByPeriod = new Map<string, TrialBalanceRow[]>()
  const linesByPeriod = new Map<string, Line[]>()
  const periodSummaries: CompanyResult['periods'] = []

  const ibEntries = await fetchAllRows<IbEntry>(({ from, to }) =>
    sb.from('journal_entries').select('id, status, entry_date, fiscal_period_id, created_at, created_via, import_batch_id')
      .eq('company_id', company.id).eq('source_type', 'opening_balance')
      .order('id').range(from, to),
  )

  for (const p of periods) {
    const label = `${p.name} (${p.period_start}..${p.period_end})`
    try {
      await reconcilePeriod(sb, company, p, label, chart, ibEntries, tbByPeriod, linesByPeriod, findings)
    } catch (err) {
      findings.push({
        period_id: p.id, period: label, check: 'report_error', cause: 'report_threw', amount: 0,
        detail: { message: err instanceof Error ? err.message : String(err) },
      })
    }
    const lines = linesByPeriod.get(p.id) ?? []
    periodSummaries.push({
      id: p.id, name: p.name, period_start: p.period_start, period_end: p.period_end,
      is_closed: p.is_closed, entries: new Set(lines.map((l) => l.e)).size,
    })
  }

  // Continuity needs every year's saldobalans, so it runs after the loop.
  for (const p of periods) {
    const label = `${p.name} (${p.period_start}..${p.period_end})`
    try {
      await checkContinuity(sb, company, p, label, periods, ibEntries, tbByPeriod, linesByPeriod, findings)
    } catch (err) {
      findings.push({
        period_id: p.id, period: label, check: 'report_error', cause: 'continuity_threw', amount: 0,
        detail: { message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  if (company.vat_registered && company.moms_period && ['monthly', 'quarterly', 'yearly'].includes(company.moms_period)) {
    try {
      await checkVat(sb, company, periods, ibEntries, linesByPeriod, findings)
    } catch (err) {
      findings.push({
        period_id: '', period: '', check: 'report_error', cause: 'vat_threw', amount: 0,
        detail: { message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  return {
    company,
    periods: periodSummaries,
    findings,
    ms: Date.now() - started,
    requests: requestCount - requestsBefore,
  }
}

/** A storno or rättelse, with the entry it reverses or corrects. */
interface ChainChild {
  id: string
  status: string
  entry_date: string
  source_type: string | null
  reverses_id: string | null
  correction_of_id: string | null
}

/** The company's entries that reverse or correct one of `ids` (one level). */
async function fetchChainChildren(sb: SupabaseClient, companyId: string, ids: readonly string[]): Promise<ChainChild[]> {
  const children: ChainChild[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const [reversing, correcting] = await Promise.all([
      sb.from('journal_entries')
        .select('id, status, entry_date, source_type, reverses_id, correction_of_id')
        .eq('company_id', companyId).in('reverses_id', chunk),
      sb.from('journal_entries')
        .select('id, status, entry_date, source_type, reverses_id, correction_of_id')
        .eq('company_id', companyId).in('correction_of_id', chunk),
    ])
    for (const result of [reversing, correcting]) {
      if (result.error) throw new Error(`storno/rättelse chain: ${result.error.message}`)
      children.push(...((result.data ?? []) as ChainChild[]))
    }
  }
  return children
}

// ── Per fiscal year ───────────────────────────────────────────────────────

async function reconcilePeriod(
  sb: SupabaseClient,
  company: CompanyMeta,
  p: PeriodRow,
  label: string,
  chart: Awaited<ReturnType<typeof fetchTrialBalanceChart>>,
  ibEntries: IbEntry[],
  tbByPeriod: Map<string, TrialBalanceRow[]>,
  linesByPeriod: Map<string, Line[]>,
  findings: Finding[],
): Promise<void> {
  const push = (check: Check, cause: string, amount: number, detail: Record<string, unknown>) =>
    findings.push({ period_id: p.id, period: label, check, cause, amount: r2(amount), detail })

  // Saldobalans exactly as /api/reports/trial-balance serves it.
  const tb = await generateTrialBalance(sb, company.id, p.id, { closingEntry: 'include', chart })
  tbByPeriod.set(p.id, tb.rows)

  // Huvudbok exactly as /api/reports/general-ledger serves it.
  const gl = await generateGeneralLedger(sb, company.id, p.id)
  const lines: Line[] = []
  for (const account of gl.accounts) {
    for (const l of account.lines) {
      lines.push({ a: account.account_number, d: l.date, e: l.journal_entry_id, s: l.source_type, debit: l.debit, credit: l.credit })
    }
  }
  linesByPeriod.set(p.id, lines)

  if (tb.rows.length === 0 && lines.length === 0) return

  const classOf = new Map<string, number>()
  for (const r of tb.rows) classOf.set(r.account_number, r.account_class)
  const cls = (a: string) => classOf.get(a) ?? (parseInt(a.charAt(0)) || 0)

  // Verifikat dated outside the year they are booked in.
  const outside = new Map<string, { date: string; source_type: string; gross: number }>()
  for (const l of lines) {
    if (l.d < p.period_start || l.d > p.period_end) {
      const o = outside.get(l.e) ?? { date: l.d, source_type: l.s, gross: 0 }
      o.gross = r2(o.gross + l.debit)
      outside.set(l.e, o)
    }
  }
  if (outside.size > 0) {
    const gross = [...outside.values()].reduce((s, o) => s + o.gross, 0)
    push('entry_outside_year', 'entry_date_outside_fiscal_year', gross, {
      entries: outside.size,
      examples: [...outside.entries()].slice(0, 10).map(([id, o]) => ({ id, ...o })),
    })
  }

  // ── ledger_balance: debet = kredit, split into IB and period ──
  const sum = (f: (r: TrialBalanceRow) => number) => r2(tb.rows.reduce((s, r) => s + f(r), 0))
  const ibImbalance = sum((r) => r.opening_debit - r.opening_credit)
  const periodImbalance = sum((r) => r.period_debit - r.period_credit)
  const ubImbalance = r2(tb.totalDebit - tb.totalCredit)

  // ── Balansräkning from the same saldobalans (what generateBalanceSheet does) ──
  const bs = await balanceSheetFromTrialBalance(sb, company.id, p.id, tb.rows)
  const bsDiff = r2(bs.total_assets - bs.total_equity_liabilities)
  if (off(ubImbalance) || off(bsDiff)) {
    // Earlier years whose result is still on their result accounts. The
    // derived IB carries those on the closing account
    // (prior_opening_balance_lines), so a match here means the carry missed
    // them: lines dated outside every fiscal year.
    const untransferred: Array<{ period_id: string; pl_net: number }> = []
    for (const [periodId, rows] of tbByPeriod) {
      if (periodId === p.id) continue
      const plNet = r2(rows.filter((r) => r.account_class >= 3 && r.account_class <= 8).reduce((s, r) => s + r.closing_credit - r.closing_debit, 0))
      if (off(plNet)) untransferred.push({ period_id: periodId, pl_net: plNet })
    }
    const untransferredSum = r2(untransferred.reduce((s, u) => s + u.pl_net, 0))
    // The derived IB keeps the earliest IB verifikat per ACCOUNT unless the
    // account has activity before it, so an IB verifikat on top of history
    // (or two IB verifikat) can leave part of one in it. It also reads by
    // DATE, while every year's saldobalans reads by fiscal_period_id.
    const priorIbEntries = ibEntries.filter((e) => e.status === 'posted' && e.entry_date < p.period_start)
    const priorIb = priorIbEntries.length
    const earliestIb = priorIbEntries.map((e) => e.entry_date).sort()[0]
    // Years are processed in date order, so every other year loaded so far
    // is earlier: its lines dated from this year on are missing from the
    // derived IB, and this year's lines dated before it are in it twice.
    let misdated = lines.filter((l) => l.d < p.period_start).length
    let historyBeforeIb = false
    for (const [periodId, periodLines] of linesByPeriod) {
      if (periodId === p.id) continue
      for (const l of periodLines) {
        if (l.d >= p.period_start) misdated++
        if (earliestIb && l.s !== 'opening_balance' && l.d < earliestIb) historyBeforeIb = true
      }
    }
    const cause = off(periodImbalance)
      ? 'period_entries_unbalanced'
      : untransferred.length > 0 && !off(bsDiff - untransferredSum)
        ? 'untransferred_prior_result'
        : p.opening_balance_entry_id
          ? 'ib_verifikat_unbalanced_in_balance_classes'
          : misdated > 0
            ? 'entry_outside_fiscal_year'
            : priorIb > 1
              ? 'derived_ib_mixes_several_ib_verifikat'
              : priorIb === 1 && historyBeforeIb
                ? 'derived_ib_mixes_ib_verifikat_and_history'
                : untransferred.length > 0
                  ? 'untransferred_prior_result_partial'
                  : 'derived_ib_unbalanced'
    push('ledger_balance', cause, bsDiff, {
      tb_ub_debit_minus_credit: ubImbalance,
      tb_ib_debit_minus_credit: ibImbalance,
      tb_period_debit_minus_credit: periodImbalance,
      bs_total_assets: bs.total_assets,
      bs_total_equity_liabilities: bs.total_equity_liabilities,
      has_ob_entry: Boolean(p.opening_balance_entry_id),
      posted_ib_verifikat_before_year: priorIb,
      misdated_lines_affecting_ib: misdated,
      history_before_ib_verifikat: historyBeforeIb,
      untransferred_sum: untransferredSum,
      untransferred,
      diagnosis: bs.imbalance_diagnosis?.message,
    })
  }

  // ── tb_vs_gl: per account IB, debet, kredit, UB ──
  const glByAccount = new Map(gl.accounts.map((a) => [a.account_number, a]))
  const tbByAccount = new Map(tb.rows.map((r) => [r.account_number, r]))
  const tbGlDiffs: Array<Record<string, unknown>> = []
  let tbGlMax = 0
  for (const account of new Set([...glByAccount.keys(), ...tbByAccount.keys()])) {
    const t = tbByAccount.get(account)
    const g = glByAccount.get(account)
    const tIb = t ? r2(t.opening_debit - t.opening_credit) : 0
    const tUb = t ? r2(t.closing_debit - t.closing_credit) : 0
    const fields = {
      ib: [tIb, g?.opening_balance ?? 0],
      debit: [t?.period_debit ?? 0, g?.total_debit ?? 0],
      credit: [t?.period_credit ?? 0, g?.total_credit ?? 0],
      ub: [tUb, g?.closing_balance ?? 0],
    } as const
    const diffs: Record<string, number> = {}
    for (const [k, [tv, gv]] of Object.entries(fields)) {
      if (off(tv - gv)) {
        diffs[k] = r2(tv - gv)
        tbGlMax = Math.max(tbGlMax, Math.abs(tv - gv))
      }
    }
    if (Object.keys(diffs).length > 0) tbGlDiffs.push({ account, ...diffs })
  }
  if (tbGlDiffs.length > 0) {
    push('tb_vs_gl', 'unexplained', tbGlMax, { accounts: tbGlDiffs.slice(0, 50), count: tbGlDiffs.length })
  }

  // ── bs_vs_tb: totals by account number, independent of the chart's class ──
  let assetsByNumber = 0
  let class2ByNumber = 0
  let otherByNumber = 0
  for (const r of tb.rows) {
    const net = r.closing_debit - r.closing_credit
    if (firstDigit(r.account_number) === '1') assetsByNumber += net
    else if (firstDigit(r.account_number) === '2') class2ByNumber -= net
    else otherByNumber -= net
  }
  const syntheticResult = bs.equity_liability_sections.find((s) => s.title === 'Årets resultat')?.subtotal ?? 0
  const bsAssetDiff = r2(bs.total_assets - assetsByNumber)
  const bsEqLiabDiff = r2(bs.total_equity_liabilities - (class2ByNumber + otherByNumber))
  if (off(bsAssetDiff) || off(bsEqLiabDiff)) {
    const mismatched = tb.rows
      .filter((r) => String(r.account_class) !== firstDigit(r.account_number))
      .map((r) => ({ account: r.account_number, chart_class: r.account_class, ub: r2(r.closing_debit - r.closing_credit) }))
    push('bs_vs_tb', mismatched.length > 0 ? 'chart_class_differs_from_account_number' : 'unexplained', bsAssetDiff || bsEqLiabDiff, {
      assets_diff: bsAssetDiff, equity_liabilities_diff: bsEqLiabDiff, mismatched,
    })
  }

  // ── Resultaträkning and the ledger lines behind it ──
  const is = await generateIncomeStatement(sb, company.id, p.id)
  const isAmount = new Map<string, number>()
  for (const s of [...is.revenue_sections, ...is.expense_sections, ...is.financial_sections]) {
    for (const row of s.rows) isAmount.set(row.account_number, row.amount)
  }

  const closingIds = new Set<string>()
  {
    const { data, error } = await sb.rpc('result_closing_entry_ids', { p_company_id: company.id, p_fiscal_period_id: p.id })
    if (error) throw new Error(`result_closing_entry_ids: ${error.message}`)
    for (const id of (data ?? []) as string[]) closingIds.add(id)
  }
  // What 'exclude-all-year-end' leaves out, read from the one definition the
  // reports use: the year_end chain plus a resultatavslut booked elsewhere.
  const yearEnd = new Set<string>()
  {
    const { data, error } = await sb.rpc('year_end_chain_entry_ids', { p_company_id: company.id, p_fiscal_period_id: p.id })
    if (error) throw new Error(`year_end_chain_entry_ids: ${error.message}`)
    for (const id of (data ?? []) as string[]) yearEnd.add(id)
  }
  const inYearEndChain = (l: Line) => yearEnd.has(l.e)

  // is_vs_ledger: per class 3-8 account (8999 excluded, as the report does),
  // IB + movement outside the year-end chain, in the report's sign.
  const expectedPl = new Map<string, number>()
  for (const r of tb.rows) {
    const c = r.account_class
    if (c >= 3 && c <= 8 && !isAretsResultatAccount(r.account_number)) {
      expectedPl.set(r.account_number, (expectedPl.get(r.account_number) ?? 0) + (r.opening_credit - r.opening_debit))
    }
  }
  for (const l of lines) {
    const c = cls(l.a)
    if (c < 3 || c > 8 || isAretsResultatAccount(l.a) || inYearEndChain(l)) continue
    expectedPl.set(l.a, (expectedPl.get(l.a) ?? 0) + (l.credit - l.debit))
  }
  const isDiffs: Array<Record<string, unknown>> = []
  let expectedNet = 0
  for (const [account, creditNet] of expectedPl) {
    expectedNet += creditNet
    const c = cls(account)
    const expected = r2(c >= 4 && c <= 7 ? -creditNet : creditNet)
    const reported = isAmount.get(account) ?? 0
    if (off(expected - reported)) isDiffs.push({ account, expected, reported })
  }
  for (const [account, reported] of isAmount) {
    if (!expectedPl.has(account) && off(reported)) isDiffs.push({ account, expected: 0, reported })
  }
  if (isDiffs.length > 0 || off(is.net_result - expectedNet)) {
    push('is_vs_ledger', 'unexplained', is.net_result - expectedNet, {
      is_net_result: is.net_result, ledger_net: r2(expectedNet), accounts: isDiffs.slice(0, 50),
    })
  }

  // ── Resultatrapport vs resultaträkning ──
  const rr = await generateResultatrapport(sb, company.id, p.id)
  const rrDiff = r2(rr.net_result_current - is.net_result)
  if (off(rrDiff)) {
    let pl8999 = 0
    for (const l of lines) if (isAretsResultatAccount(l.a) && !inYearEndChain(l)) pl8999 += l.credit - l.debit
    let plIb = 0
    for (const r of tb.rows) {
      if (r.account_class >= 3 && r.account_class <= 8 && !isAretsResultatAccount(r.account_number)) plIb += r.opening_credit - r.opening_debit
    }
    const explained = r2(pl8999 - plIb)
    push('rr_vs_is', !off(rrDiff - pl8999) ? 'resultatrapport_includes_8999' : !off(rrDiff - explained) ? '8999_and_result_account_ib' : 'unexplained', rrDiff, {
      rr_net: rr.net_result_current, is_net: is.net_result, on_8999: r2(pl8999), result_account_ib: r2(plIb),
      unexplained: r2(rrDiff - explained),
    })
  }

  // ── Balansrapport vs balansräkning ──
  const br = await generateBalansrapport(sb, company.id, p.id)
  const brAssetDiff = r2(br.total_assets_ub - bs.total_assets)
  const brEqLiabDiff = r2(-br.total_equity_liabilities_ub - (bs.total_equity_liabilities - syntheticResult))
  const brResultDiff = r2(br.beraknat_resultat - syntheticResult)
  if (off(brAssetDiff) || off(brEqLiabDiff) || off(brResultDiff)) {
    const cause =
      !off(brAssetDiff) && !off(brEqLiabDiff) && !off(brResultDiff - ubImbalance)
        ? 'balansrapport_puts_imbalance_in_beraknat_resultat'
        : 'unexplained'
    push('br_vs_bs', cause, off(brAssetDiff) ? brAssetDiff : off(brEqLiabDiff) ? brEqLiabDiff : brResultDiff, {
      assets_diff: brAssetDiff, equity_liabilities_diff: brEqLiabDiff,
      br_beraknat_resultat: br.beraknat_resultat, bs_arets_resultat: syntheticResult, rr_net: rr.net_result_current,
      is_net: is.net_result, tb_imbalance: ubImbalance,
    })
  }

  // ── result_vs_equity ──
  // ΔEK on the balansräkning (Eget kapital + beräknat resultat, end minus
  // start) less owner/capital movements must equal the resultaträkning's
  // årets resultat. A result transfer is a verifikat with a result-account
  // line (class 3-8) and a line on årets resultat (2099/2019/2069, the set
  // result_closing_entry_ids uses); its årets-resultat lines are the result
  // reaching equity. Every other 20xx line is an owner/capital movement.
  const equityStart = r2(
    tb.rows.reduce((s, r) => {
      const net = r.opening_credit - r.opening_debit
      if (r.account_class === 2 && r.account_number.startsWith('20')) return s + net
      if (!(r.account_class >= 1 && r.account_class <= 2)) return s + net
      return s
    }, 0),
  )
  const equitySection = bs.equity_liability_sections.find((s) => s.title === 'Eget kapital')?.subtotal ?? 0
  const equityEnd = r2(equitySection + syntheticResult)
  const byEntry = new Map<string, Line[]>()
  for (const l of lines) {
    const list = byEntry.get(l.e)
    if (list) list.push(l)
    else byEntry.set(l.e, [l])
  }
  let ownerMovements = 0
  let transferred = 0
  const transfersOutsideRpc: string[] = []
  const parts = {
    year_end_entries_left_out_of_resultatrakning: 0,
    resultatavslut_outside_year_end_inside_resultatrakning: 0,
    result_transfer_other: 0,
    on_8999_outside_result_transfer: 0,
    non_standard_accounts: 0,
    result_account_ib: 0,
  }
  for (const [entryId, entryLines] of byEntry) {
    const isPl = (l: Line) => cls(l.a) >= 3 && cls(l.a) <= 8
    const ye = entryLines.some(inYearEndChain)
    const equityLine = (l: Line) => cls(l.a) === 2 && l.a.startsWith('20')
    const net8999 = entryLines.filter((l) => isAretsResultatAccount(l.a)).reduce((sum, l) => sum + (l.credit - l.debit), 0)
    const plNet = entryLines.filter(isPl).reduce((sum, l) => sum + (l.credit - l.debit), 0)
    // A result transfer moves the year's result into equity. Through 8999
    // (the SIE/Fortnox omföring): the amount is what leaves 8999, whatever
    // else the verifikat books (skatt, vinstdisposition through 2099).
    // Straight from the result accounts (our own resultatavslut, a shape
    // match of result_closing_entry_ids, the year's linked closing): the
    // amount is what leaves the result accounts. Every 20xx line beyond the
    // transferred amount is an owner or intra-equity movement.
    let transferAmount: number | null = null
    if (entryLines.some((l) => isAretsResultatAccount(l.a)) && entryLines.some(equityLine)) {
      transferAmount = -net8999
    } else if (
      entryLines.some(isPl) && entryLines.some(equityLine) &&
      (closingIds.has(entryId) || entryId === p.closing_entry_id || ye)
    ) {
      transferAmount = -plNet
    }
    const transfer = transferAmount !== null
    if (transfer && !closingIds.has(entryId)) transfersOutsideRpc.push(entryId)
    let contribution = transferAmount ?? 0
    transferred += transferAmount ?? 0
    ownerMovements -= transferAmount ?? 0
    let plOther = 0
    let yearEndPl = 0
    let on8999 = 0
    for (const l of entryLines) {
      const net = l.credit - l.debit
      const c = cls(l.a)
      if (equityLine(l)) {
        ownerMovements += net
      } else if (c === 1 || c === 2) {
        continue
      } else if (isAretsResultatAccount(l.a)) {
        if (transfer) contribution += net
        else on8999 += net
      } else if (c >= 3 && c <= 8) {
        if (ye) {
          if (transfer) contribution += net
          else yearEndPl += net
        }
        plOther += Math.abs(net)
      } else if (transfer) {
        contribution += net
      } else {
        parts.non_standard_accounts += net
      }
    }
    if (transfer && off(contribution)) {
      if (!ye && plOther > 0) parts.resultatavslut_outside_year_end_inside_resultatrakning += contribution
      else parts.result_transfer_other += contribution
    }
    // A year_end verifikat that only moves the result accounts onto 8999 nets
    // to nothing here; anything else it books is left out of the report.
    if (off(yearEndPl + on8999)) {
      parts.year_end_entries_left_out_of_resultatrakning += yearEndPl
      parts.on_8999_outside_result_transfer += on8999
    }
  }
  for (const r of tb.rows) {
    if (r.account_class >= 3 && r.account_class <= 8 && !isAretsResultatAccount(r.account_number)) {
      parts.result_account_ib -= r.opening_credit - r.opening_debit
    }
  }
  const residual = r2(equityEnd - equityStart - ownerMovements - is.net_result)
  if (off(residual)) {
    const explained = r2(Object.values(parts).reduce((s, v) => s + v, 0))
    const rounded = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r2(v)]))
    const nonZero = Object.entries(rounded).filter(([, v]) => off(v)).map(([k]) => k)
    const cause = off(residual - explained) ? 'unexplained' : nonZero.join('+')
    push('result_vs_equity', cause, residual, {
      is_net_result: is.net_result, equity_start: equityStart, equity_end: equityEnd,
      owner_movements: r2(ownerMovements), result_transferred_to_equity: r2(transferred),
      ...rounded, unexplained: r2(residual - explained), is_closed: p.is_closed,
      transfers_not_in_result_closing_entry_ids: transfersOutsideRpc.slice(0, 10),
    })
  }
}

// ── continuity: IB(year) = UB(year before) ────────────────────────────────

async function checkContinuity(
  sb: SupabaseClient,
  company: CompanyMeta,
  p: PeriodRow,
  label: string,
  periods: PeriodRow[],
  ibEntries: IbEntry[],
  tbByPeriod: Map<string, TrialBalanceRow[]>,
  linesByPeriod: Map<string, Line[]>,
  findings: Finding[],
): Promise<void> {
  const rows = tbByPeriod.get(p.id)
  if (!rows) return
  const prev = await resolvePreviousFiscalPeriod<{ id: string; period_end: string }>(sb, company.id, p, 'id, period_end')

  const ib = new Map<string, number>()
  const plIb: Array<{ account: string; ib: number }> = []
  for (const r of rows) {
    const net = r2(r.opening_debit - r.opening_credit)
    const d = firstDigit(r.account_number)
    if (d === '1' || d === '2') ib.set(r.account_number, net)
    else if (off(net)) plIb.push({ account: r.account_number, ib: net })
  }
  if (plIb.length > 0) {
    findings.push({
      period_id: p.id, period: label, check: 'continuity', cause: 'result_account_has_opening_balance',
      amount: r2(plIb.reduce((s, x) => s + x.ib, 0)),
      detail: { accounts: plIb.slice(0, 50), ob_entry: p.opening_balance_entry_id },
    })
  }

  if (!prev) return
  const prevRows = tbByPeriod.get(prev.id)
  if (!prevRows) return
  const prevPeriod = periods.find((x) => x.id === prev.id)

  const ub = new Map<string, number>()
  let prevResult = 0
  for (const r of prevRows) {
    const net = r2(r.closing_debit - r.closing_credit)
    const d = firstDigit(r.account_number)
    if (d === '1' || d === '2') ub.set(r.account_number, net)
    else prevResult -= net
  }
  // A year left unclosed opens the next on the form's closing account
  // (prior_opening_balance_lines): read it as closed, as the app's check does.
  if (off(prevResult) && isEntityType(company.entity_type)) {
    const { closing } = resultClosingAccounts(company.entity_type)
    ub.set(closing, r2((ub.get(closing) ?? 0) - prevResult))
  }

  const diffs: Array<{ account: string; prev_ub: number; ib: number; diff: number }> = []
  for (const account of new Set([...ib.keys(), ...ub.keys()])) {
    const a = ub.get(account) ?? 0
    const b = ib.get(account) ?? 0
    if (off(a - b)) diffs.push({ account, prev_ub: a, ib: b, diff: r2(b - a) })
  }

  // The app's own continuity check (year-end readiness) for comparison.
  let appCheck: { valid: boolean; discrepancies: number } | null = null
  try {
    const result = await validateBalanceContinuity(sb, company.id, p.id)
    appCheck = { valid: result.valid, discrepancies: result.discrepancies.length }
  } catch (err) {
    appCheck = null
    findings.push({
      period_id: p.id, period: label, check: 'report_error', cause: 'continuity_check_threw', amount: 0,
      detail: { message: err instanceof Error ? err.message : String(err) },
    })
  }

  if (diffs.length === 0) {
    if (appCheck && !appCheck.valid) {
      findings.push({
        period_id: p.id, period: label, check: 'continuity', cause: 'app_continuity_check_disagrees', amount: 0,
        detail: { app_discrepancies: appCheck.discrepancies },
      })
    }
    return
  }

  const total = r2(diffs.reduce((s, x) => s + x.diff, 0))
  const equityDiff = r2(diffs.filter((x) => x.account.startsWith('20')).reduce((s, x) => s + x.diff, 0))
  const nonEquity = diffs.filter((x) => !x.account.startsWith('20'))
  const outsideIntoP = (linesByPeriod.get(p.id) ?? []).filter((l) => l.d < p.period_start).length
  const outsideIntoPrev = (linesByPeriod.get(prev.id) ?? []).filter((l) => l.d > (prevPeriod?.period_end ?? '9999')).length

  // Evidence for the cause.
  let obInfo: Record<string, unknown> | null = null
  let prevChangedAfterOb = false
  if (p.opening_balance_entry_id) {
    const { data: ob } = await sb
      .from('journal_entries')
      .select('id, entry_date, created_at, source_type, created_via, import_batch_id, status')
      .eq('id', p.opening_balance_entry_id)
      .eq('company_id', company.id)
      .maybeSingle()
    obInfo = ob as Record<string, unknown> | null
    if (ob) {
      const { data: later } = await sb
        .from('journal_entries')
        .select('id')
        .eq('company_id', company.id)
        .eq('fiscal_period_id', prev.id)
        .in('status', ['posted', 'reversed'])
        .gt('created_at', (ob as { created_at: string }).created_at)
        .limit(1)
      prevChangedAfterOb = (later ?? []).length > 0
    }
  }

  // Posted IB verifikat per year: the saldobalans counts every unlinked one
  // as period activity, the derived IB keeps only the earliest per account.
  const postedIb = (periodId: string) => ibEntries.filter((e) => e.fiscal_period_id === periodId && e.status === 'posted')
  const ibInYear = postedIb(p.id)
  const ibInPrev = postedIb(prev.id)
  const obImported = Boolean((obInfo as { import_batch_id?: string | null } | null)?.import_batch_id)

  let cause: string
  if (outsideIntoP > 0 || outsideIntoPrev > 0) cause = 'entry_outside_fiscal_year'
  else if (ibInYear.length > 1 || ibInPrev.length > 1) cause = 'several_ib_verifikat_in_one_year'
  else if (nonEquity.length === 0 && !off(equityDiff - prevResult) && off(prevResult)) cause = 'ib_carries_result_not_closed_in_prior_year'
  else if (p.opening_balance_entry_id && prevChangedAfterOb) cause = 'prior_year_changed_after_ib_was_booked'
  else if (p.opening_balance_entry_id && obImported) cause = 'imported_ib_differs_from_prior_ub'
  else if (p.opening_balance_entry_id) cause = 'ib_verifikat_differs_from_prior_ub'
  else cause = 'derived_ib_differs'

  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
  findings.push({
    period_id: p.id, period: label, check: 'continuity', cause, amount: diffs[0].diff,
    detail: {
      accounts: diffs.slice(0, 50), count: diffs.length, net_of_diffs: total, equity_diff: equityDiff,
      prior_year_result_left_on_result_accounts: r2(prevResult), prior_period_id: prev.id,
      prior_closed: prevPeriod?.is_closed ?? null, ob_entry: obInfo, prior_changed_after_ob: prevChangedAfterOb,
      lines_dated_before_year: outsideIntoP, prior_lines_dated_after_year: outsideIntoPrev,
      ib_verifikat_in_year: ibInYear.length, ib_verifikat_in_prior_year: ibInPrev.length,
      app_check: appCheck,
    },
  })
}

// ── vat_vs_26xx ───────────────────────────────────────────────────────────

const RUTA49_BOXES = new Set<string>(RUTA_49_TERMS.map((t) => t.box))

/** Accounts whose balance reaches ruta 49 for this company. */
function ruta49Accounts(dyn: DynamicVatAccounts): Set<string> {
  const set = new Set<string>()
  for (const [account, mapping] of Object.entries(ACCOUNT_RUTA)) {
    if (!dyn.explicitAccounts.has(account) && RUTA49_BOXES.has(mapping.box)) set.add(account)
  }
  for (const [account, mapping] of dyn.mappingByAccount) {
    if (RUTA49_BOXES.has(mapping.box)) set.add(account)
  }
  return set
}

function vatPeriods(company: CompanyMeta, periods: PeriodRow[], dates: string[]): Array<{ start: string; end: string; label: string }> {
  if (periods.length === 0 || dates.length === 0) return []
  const type = company.moms_period as VatPeriodType
  if (type === 'yearly') {
    return periods.map((p) => ({ start: p.period_start, end: p.period_end, label: `helår ${p.period_start}..${p.period_end}` }))
  }
  const out: Array<{ start: string; end: string; label: string }> = []
  const first = periods[0].period_start
  const last = periods[periods.length - 1].period_end
  const step = type === 'monthly' ? 1 : 3
  let y = Number(first.slice(0, 4))
  let m = Number(first.slice(5, 7))
  m = type === 'monthly' ? m : Math.floor((m - 1) / 3) * 3 + 1
  const sorted = [...dates].sort()
  for (;;) {
    const period = type === 'monthly' ? m : (m - 1) / 3 + 1
    const { start, end } = calculatePeriodDates(type, y, period)
    if (start > last) break
    // Only periods with a verifikat in them can carry VAT.
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < start) lo = mid + 1
      else hi = mid
    }
    if (lo < sorted.length && sorted[lo] <= end) out.push({ start, end, label: `${type} ${start}..${end}` })
    m += step
    if (m > 12) { m -= 12; y += 1 }
  }
  return out
}

async function checkVat(
  sb: SupabaseClient,
  company: CompanyMeta,
  periods: PeriodRow[],
  ibEntries: IbEntry[],
  linesByPeriod: Map<string, Line[]>,
  findings: Finding[],
): Promise<void> {
  const allLines: Line[] = []
  for (const lines of linesByPeriod.values()) for (const l of lines) allLines.push(l)

  // Entries the declaration leaves out by rule, independent of its SQL.
  const kontantmetodReversals = new Set(
    (await fetchAllRows<{ id: string; journal_entry_id: string }>(({ from, to }) =>
      sb.from('kontantmetod_cutoff_entries').select('id, journal_entry_id')
        .eq('company_id', company.id).in('kind', ['receivable_reversal', 'payable_reversal'])
        .order('id').range(from, to),
    )).map((r) => r.journal_entry_id),
  )
  const closingIdsAll = periods.map((p) => p.closing_entry_id).filter((x): x is string => Boolean(x))
  const postedClosing = new Set<string>()
  if (closingIdsAll.length > 0) {
    const { data } = await sb.from('journal_entries').select('id, status').eq('company_id', company.id).in('id', closingIdsAll)
    for (const row of (data ?? []) as Array<{ id: string; status: string }>) if (row.status === 'posted') postedClosing.add(row.id)
  }

  // Opening-balance chains: every balance IB (no class 3-8 line) plus the
  // stornos and rättelser of it, each with its root.
  const ibLines = await fetchLinesByEntryIds<{ id: string; journal_entry_id: string; account_number: string; debit_amount: number; credit_amount: number }>(
    sb, ibEntries.map((e) => e.id), 'id, journal_entry_id, account_number, debit_amount, credit_amount',
  )
  const withResultLine = new Set(ibLines.filter((l) => '345678'.includes(l.account_number.charAt(0))).map((l) => l.journal_entry_id))
  const rootOf = new Map<string, string>()
  const chainEntry = new Map<string, { status: string; entry_date: string }>()
  for (const e of ibEntries) {
    if (withResultLine.has(e.id)) continue
    rootOf.set(e.id, e.id)
    chainEntry.set(e.id, { status: e.status, entry_date: e.entry_date })
  }
  let frontier = [...rootOf.keys()]
  while (frontier.length > 0) {
    const next: string[] = []
    const inFrontier = new Set(frontier)
    for (const row of await fetchChainChildren(sb, company.id, frontier)) {
      if (row.source_type === 'opening_balance' || rootOf.has(row.id)) continue
      const parent = row.reverses_id && inFrontier.has(row.reverses_id) ? row.reverses_id : row.correction_of_id
      if (!parent) continue
      rootOf.set(row.id, rootOf.get(parent) ?? parent)
      chainEntry.set(row.id, { status: row.status, entry_date: row.entry_date })
      next.push(row.id)
    }
    frontier = next
  }
  const chainLines = await fetchLinesByEntryIds<{ id: string; journal_entry_id: string; account_number: string; debit_amount: number; credit_amount: number }>(
    sb, [...rootOf.keys()], 'id, journal_entry_id, account_number, debit_amount, credit_amount',
  )

  const linesByEntry = new Map<string, Line[]>()
  for (const l of allLines) {
    const list = linesByEntry.get(l.e)
    if (list) list.push(l)
    else linesByEntry.set(l.e, [l])
  }

  const dates = [...allLines.map((l) => l.d), ...[...chainEntry.values()].map((e) => e.entry_date)]
  // A sale or a purchase books a result account; a momsredovisning (alone or
  // combined with other balance reclassifications) does not, öresavrundning
  // on 3740 aside.
  const businessLine = (a: string) => /^[3-7]/.test(a) && a !== '3740'
  // BAS moms accounts proper: utgående 2610-2639, ingående 2640-2649. The
  // rest of 26xx is the redovisningskonto range (2650-2659), punktskatter
  // (2660-2669) and OSS (2670-2679), none of which a momsdeklaration ruta
  // reads by law.
  const vatAccount = isDeclarationVatAccount
  const settlementAccount = (a: string) => a >= '2650' && a <= '2659'

  for (const vp of vatPeriods(company, periods, dates)) {
    const ledger = await loadVatDeclarationLedger(sb, company.id, vp.start, vp.end)
    const r49 = ledger.rutor.ruta49
    const contributing = ruta49Accounts(ledger.dynamicVatAccounts)
    const shaped = new Set(ledger.settlementShapedEntries.map((e) => e.id))
    const countedRoots = new Set(ledger.countedOpeningBalances.map((e) => e.id))

    const counted = new Map<string, { debit: number; credit: number }>()
    const excluded: Record<string, number> = { tagged_settlement: 0, shaped_settlement: 0, kontantmetod_reversal: 0, closing_entry: 0, opening_balance: 0 }
    const unmapped = new Map<string, number>()
    let on2650Business = 0
    const impureShaped: Array<{ id: string; ruta49_effect: number; result_accounts_net: number; accounts: string[] }> = []

    const inPeriod = allLines.filter((l) => l.d >= vp.start && l.d <= vp.end)
    const seenShaped = new Set<string>()
    for (const l of inPeriod) {
      const net = l.credit - l.debit
      const reason =
        l.s === 'vat_settlement' ? 'tagged_settlement'
          : rootOf.has(l.e) ? 'opening_balance'
            : kontantmetodReversals.has(l.e) ? 'kontantmetod_reversal'
              : postedClosing.has(l.e) ? 'closing_entry'
                : shaped.has(l.e) ? 'shaped_settlement'
                  : null
      if (reason) {
        if (vatAccount(l.a)) excluded[reason] += net
        if (reason === 'shaped_settlement' && !seenShaped.has(l.e)) {
          seenShaped.add(l.e)
          const entryLines = linesByEntry.get(l.e) ?? []
          const foreign = [...new Set(entryLines.map((x) => x.a).filter(businessLine))]
          if (foreign.length > 0) {
            const effect = entryLines.filter((x) => contributing.has(x.a)).reduce((s, x) => s + (x.credit - x.debit), 0)
            const resultNet = entryLines.filter((x) => businessLine(x.a)).reduce((s, x) => s + (x.credit - x.debit), 0)
            impureShaped.push({ id: l.e, ruta49_effect: r2(effect), result_accounts_net: r2(resultNet), accounts: foreign.slice(0, 8) })
          }
        }
        continue
      }
      const t = counted.get(l.a) ?? { debit: 0, credit: 0 }
      t.debit += l.debit
      t.credit += l.credit
      counted.set(l.a, t)
      if (!contributing.has(l.a)) {
        if (settlementAccount(l.a)) {
          const entryLines = linesByEntry.get(l.e) ?? []
          const reclass = entryLines.some((x) => x.a === '1650' || x.a === '1630')
          if (!reclass && entryLines.some((x) => businessLine(x.a))) on2650Business += net
        } else if (vatAccount(l.a)) {
          unmapped.set(l.a, (unmapped.get(l.a) ?? 0) + net)
        }
      }
    }

    // Counted opening balances: in the declaration, not movement.
    const ibTotals = new Map<string, { debit: number; credit: number }>()
    for (const l of chainLines) {
      const entry = chainEntry.get(l.journal_entry_id)
      if (!entry || entry.entry_date < vp.start || entry.entry_date > vp.end) continue
      if (!['posted', 'reversed'].includes(entry.status)) continue
      if (!countedRoots.has(rootOf.get(l.journal_entry_id) ?? '')) continue
      const t = ibTotals.get(l.account_number) ?? { debit: 0, credit: 0 }
      t.debit += Number(l.debit_amount) || 0
      t.credit += Number(l.credit_amount) || 0
      ibTotals.set(l.account_number, t)
    }

    const movement49 = rutorFromTotals(counted, ledger.dynamicVatAccounts).ruta49
    const ib49 = rutorFromTotals(ibTotals, ledger.dynamicVatAccounts).ruta49
    const residual = r2(r49 - movement49 - ib49)
    const unmappedTotal = r2([...unmapped.values()].reduce((s, v) => s + v, 0))
    const impureTotal = r2(impureShaped.reduce((s, x) => s + x.result_accounts_net, 0))

    // The momsrapport's own warning (VAT_ACCOUNT_WITHOUT_RUTA) must name
    // exactly the moms accounts the ledger shows outside every ruta, with
    // the same amounts on the account's own side, counted IB included.
    const outsideRutor = new Map(unmapped)
    for (const [account, t] of ibTotals) {
      if (vatAccount(account) && !contributing.has(account)) {
        outsideRutor.set(account, (outsideRutor.get(account) ?? 0) + t.credit - t.debit)
      }
    }
    const warned = new Map(
      vatAccountsWithoutRuta(ledger.totals, ledger.dynamicVatAccounts).map((a) => [a.account_number, a.amount]),
    )
    const warningDiffs: Array<{ account: string; ledger: number; warned: number }> = []
    for (const account of new Set([...outsideRutor.keys(), ...warned.keys()])) {
      const net = outsideRutor.get(account) ?? 0
      const ledgerAmount = r2(account < '2640' ? net : -net)
      const warnedAmount = warned.get(account) ?? 0
      if (off(ledgerAmount - warnedAmount)) warningDiffs.push({ account, ledger: ledgerAmount, warned: warnedAmount })
    }

    const causes: string[] = []
    if (off(residual)) causes.push('unexplained')
    if (warningDiffs.length > 0) causes.push('vat_warning_disagrees_with_ledger')
    if (off(unmappedTotal)) causes.push('vat_on_account_outside_rutor')
    if (off(on2650Business)) causes.push('vat_booked_on_2650_in_business_verifikat')
    if (off(impureTotal)) causes.push('mixed_momsredovisning_verifikat_dropped_whole')
    if (off(ib49)) causes.push('opening_balance_counted_as_period_vat')
    if (causes.length === 0) continue

    const amount = off(residual) ? residual : off(unmappedTotal) ? unmappedTotal : off(on2650Business) ? r2(on2650Business) : off(impureTotal) ? impureTotal : ib49
    const fiscal = periods.find((p) => p.period_start <= vp.start && vp.start <= p.period_end)
    findings.push({
      period_id: fiscal?.id ?? '', period: vp.label, check: 'vat_vs_26xx', cause: causes.join('+'), amount: r2(amount),
      detail: {
        ruta49: r49, movement_ruta49_accounts: r2(movement49), counted_opening_balance: r2(ib49), residual,
        unmapped_26xx: Object.fromEntries([...unmapped].map(([a, v]) => [a, r2(v)]).filter(([, v]) => off(v as number))),
        on_2650_in_business_verifikat: r2(on2650Business),
        warned_accounts: [...warned.keys()],
        warning_diffs: warningDiffs,
        dropped_business_verifikat: impureShaped.slice(0, 20),
        excluded_26xx: Object.fromEntries(Object.entries(excluded).map(([k, v]) => [k, r2(v)])),
        shaped_entries: ledger.settlementShapedEntries.length,
      },
    })
  }
}

// ── Driver ────────────────────────────────────────────────────────────────

async function loadCompanies(sb: SupabaseClient, only: string[] | null): Promise<CompanyMeta[]> {
  const companies = await fetchAllRows<{ id: string; name: string; org_number: string | null; entity_type: string | null; archived_at: string | null }>(({ from, to }) => {
    let q = sb.from('companies').select('id, name, org_number, entity_type, archived_at').order('id').range(from, to)
    if (only) q = q.in('id', only)
    return q
  })
  const settings = await fetchAllRows<{ company_id: string; moms_period: string | null; vat_registered: boolean | null; accounting_method: string | null; is_sandbox: boolean | null; entity_type: string | null }>(({ from, to }) =>
    sb.from('company_settings').select('company_id, moms_period, vat_registered, accounting_method, is_sandbox, entity_type').order('id').range(from, to),
  )
  const resets = await fetchAllRows<{ id: string; source_company_id: string }>(({ from, to }) =>
    sb.from('company_migration_resets').select('id, source_company_id').order('id').range(from, to),
  )
  const settingsBy = new Map(settings.map((s) => [s.company_id, s]))
  const resetSources = new Set(resets.map((r) => r.source_company_id))
  return companies.map((c) => {
    const s = settingsBy.get(c.id)
    return {
      id: c.id,
      name: c.name,
      org_number: c.org_number,
      entity_type: c.entity_type ?? s?.entity_type ?? null,
      archived: Boolean(c.archived_at),
      sandbox: s?.is_sandbox === true,
      migration_reset_source: resetSources.has(c.id),
      moms_period: s?.moms_period ?? null,
      vat_registered: s?.vat_registered ?? null,
      accounting_method: s?.accounting_method ?? null,
    }
  })
}

function csvCell(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function summarize(outDir: string): void {
  const dir = join(outDir, 'companies')
  const results: CompanyResult[] = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CompanyResult)

  const rows = [['company_id', 'org_number', 'company', 'archived', 'sandbox', 'reset_source', 'entity_type', 'period_id', 'period', 'check', 'cause', 'amount', 'detail'].join(',')]
  const byKey = new Map<string, { companies: Set<string>; live: Set<string>; findings: number; abs: number; max: number }>()
  let companiesChecked = 0
  let periodsChecked = 0
  for (const r of results) {
    companiesChecked++
    periodsChecked += r.periods.length
    for (const f of r.findings) {
      rows.push([
        r.company.id, r.company.org_number ?? '', r.company.name, r.company.archived, r.company.sandbox, r.company.migration_reset_source,
        r.company.entity_type ?? '', f.period_id, f.period, f.check, f.cause, f.amount.toFixed(2), f.detail,
      ].map(csvCell).join(','))
      const key = `${f.check}\t${f.cause}`
      const agg = byKey.get(key) ?? { companies: new Set(), live: new Set(), findings: 0, abs: 0, max: 0 }
      agg.companies.add(r.company.id)
      if (!r.company.archived && !r.company.sandbox && !r.company.migration_reset_source) agg.live.add(r.company.id)
      agg.findings++
      agg.abs += Math.abs(f.amount)
      agg.max = Math.max(agg.max, Math.abs(f.amount))
      byKey.set(key, agg)
    }
  }
  writeFileSync(join(outDir, 'findings.csv'), rows.join('\n') + '\n')

  const lines = [
    '# Report reconciliation',
    '',
    `Companies checked: ${companiesChecked}. Fiscal years checked: ${periodsChecked}. Findings: ${rows.length - 1}.`,
    '',
    '| check | cause | findings | companies | live companies | sum abs SEK | max abs SEK |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...[...byKey.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => {
        const [check, cause] = key.split('\t')
        return `| ${check} | ${cause} | ${v.findings} | ${v.companies.size} | ${v.live.size} | ${v.abs.toFixed(2)} | ${v.max.toFixed(2)} |`
      }),
    '',
  ]
  writeFileSync(join(outDir, 'summary.md'), lines.join('\n'))
  console.log(lines.join('\n'))
}

async function main(): Promise<void> {
  const outDir = arg('out')
  if (!outDir) {
    console.error('Usage: --out <dir> [--env-file <path>] [--concurrency N] [--company <uuid>[,<uuid>]] [--limit N] [--force] [--summarize-only]')
    process.exit(1)
  }
  const companiesDir = join(outDir, 'companies')
  mkdirSync(companiesDir, { recursive: true })
  if (process.argv.includes('--summarize-only')) {
    summarize(outDir)
    return
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  console.error(`Target: ${url} (read-only)`)
  const sb = readOnly(createClient(url, key, { auth: { persistSession: false }, global: { fetch: retryingFetch } }))

  const only = arg('company')?.split(',').filter(Boolean) ?? null
  let companies = await loadCompanies(sb, only)
  const limit = arg('limit') ? Number(arg('limit')) : null
  if (limit) companies = companies.slice(0, limit)
  const force = process.argv.includes('--force')
  const todo = companies.filter((c) => force || !existsSync(join(companiesDir, `${c.id}.json`)))
  const concurrency = Number(arg('concurrency') ?? 3)
  console.error(`${companies.length} companies, ${todo.length} to run, concurrency ${concurrency}`)

  let done = 0
  let next = 0
  const startedAt = Date.now()
  async function worker(): Promise<void> {
    for (;;) {
      const company = todo[next++]
      if (!company) return
      const { count } = await sb
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .in('status', ['posted', 'reversed'])
      const result: CompanyResult = (count ?? 0) === 0
        ? { company, periods: [], findings: [], ms: 0, requests: 0 }
        : await reconcileCompany(sb, company).catch((err) => ({
          company, periods: [], ms: 0, requests: 0,
          findings: [{ period_id: '', period: '', check: 'report_error' as Check, cause: 'company_threw', amount: 0, detail: { message: err instanceof Error ? err.message : String(err) } }],
        }))
      writeFileSync(join(companiesDir, `${company.id}.json`), JSON.stringify(result))
      done++
      if (result.findings.length > 0 || done % 50 === 0) {
        const rate = done / ((Date.now() - startedAt) / 1000)
        console.error(`[${done}/${todo.length}] ${company.id} entries=${count ?? 0} findings=${result.findings.length} ${result.ms}ms req=${requestCount} ${rate.toFixed(2)}/s`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  summarize(outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
