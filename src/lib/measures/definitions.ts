/**
 * The measures. Each one delegates its value to the report a person sees and
 * says which figure of that report it equals (`equals`); the parity tests in
 * __tests__/parity.test.ts hold every measure to it. No figure is computed
 * here that the report does not compute: the code below only picks the
 * report's figure, names its parts, and refuses when the report cannot be
 * read.
 *
 * Accounts are reached through account roles (lib/bookkeeping/account-roles)
 * or through the report's own account selection, never spelled: the SE pack
 * answers BAS, another country's pack its own chart.
 */
import { toHandle } from '@/lib/handles'
import { roundOre } from '@/lib/money'
import {
  AccountRoleError,
  resolveAccountRole,
  type AccountRole,
  type AccountRoleScope,
} from '@/lib/bookkeeping/account-roles'
import { isBankCashAccount } from '@/lib/cash-accounts/invoice-payee-rules'
import { generateARLedger, type ARLedgerReport } from '@/lib/reports/ar-ledger'
import { buildReportDataStatus } from '@/lib/reports/data-status'
import { NETTOOMSATTNING_RANGES, inAccountRanges } from '@/lib/reports/income-definitions'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { calculateCashPosition, cashPositionRows, fetchKpiAccountOverrides } from '@/lib/reports/kpi'
import { generateSupplierLedger, type SupplierLedgerReport } from '@/lib/reports/supplier-ledger'
import { fetchTrialBalanceChart, generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  RUTA_49_TERMS,
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  computeVatDeclaration,
  loadVatDeclarationLedger,
  vatRutaContributions,
  type ComputedVatDeclaration,
} from '@/lib/reports/vat-declaration'
import type { IncomeStatementReport, IncomeStatementSection, TrialBalanceRow } from '@/types'
import {
  flattenLines,
  ledgerForAccounts,
  sortLines,
  tiesOut,
  type AccountLedger,
} from './explain'
import { fiscalPeriodContaining, requireFiscalPeriodContaining } from './params'
import {
  MeasureRefusal,
  type AnyMeasureDefinition,
  type MeasureBreakdown,
  type MeasureCaveat,
  type MeasureComputation,
  type MeasureContext,
  type MeasureContributor,
  type MeasureDefinition,
  type MeasureDocument,
  type MeasureFiscalPeriod,
  type MeasureJournalLine,
  type ResolvedScope,
} from './types'

// ──────────────────────────────────────────────────────────────────
// Shared reads
// ──────────────────────────────────────────────────────────────────

function scopeOf<K extends ResolvedScope['kind']>(scope: ResolvedScope, kind: K): Extract<ResolvedScope, { kind: K }> {
  if (scope.kind !== kind) throw new Error(`measure scope: expected ${kind}, got ${scope.kind}`)
  return scope as Extract<ResolvedScope, { kind: K }>
}

/** companies.jurisdiction, the only per-company input the account-role resolver takes. */
async function jurisdictionOf(ctx: MeasureContext): Promise<AccountRoleScope> {
  const { data, error } = await ctx.supabase
    .from('companies')
    .select('jurisdiction')
    .eq('id', ctx.companyId)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`company jurisdiction read failed: ${error.message}`), { code: error.code })
  return { jurisdiction: ((data as { jurisdiction?: string | null } | null)?.jurisdiction ?? '') as string }
}

/** The account a role resolves to for the company, or a refusal: never a Swedish default for another country. */
function roleAccount(scope: AccountRoleScope, role: AccountRole, nameSv: string): string {
  try {
    return resolveAccountRole(scope, role)
  } catch (err) {
    if (!(err instanceof AccountRoleError)) throw err
    throw new MeasureRefusal(
      'MEASURE_ACCOUNT_ROLE_UNAVAILABLE',
      `${nameSv} kan inte beräknas: bolagets land (${err.jurisdiction || 'okänt'}) har inget konto för rollen ${role}. Inget värde har räknats fram.`,
      { role, jurisdiction: err.jurisdiction, reason: err.code },
    )
  }
}

/** The balance sheet's trial balance at a date: every posted entry up to it, resultatavslut included. */
interface BalanceSource {
  fiscalPeriod: MeasureFiscalPeriod
  rows: TrialBalanceRow[]
  /** The report trust signals over the fiscal year up to the date, read beside the balance. */
  dataStatus: MeasureComputation['data_status']
}

async function balanceAt(ctx: MeasureContext, asOf: string): Promise<BalanceSource> {
  const fiscalPeriod = await requireFiscalPeriodContaining(ctx, asOf)
  const [tb, dataStatus] = await Promise.all([
    // The same call generateBalanceSheet makes for /reports/balance-sheet?as_of=.
    generateTrialBalance(ctx.supabase, ctx.companyId, fiscalPeriod.id, { closingEntry: 'include', toDate: asOf }),
    buildReportDataStatus(ctx.supabase, ctx.companyId, { periodId: fiscalPeriod.id, toDate: asOf }),
  ])
  return { fiscalPeriod, rows: tb.rows, dataStatus }
}

/** An account's closing balance on its normal side: debit minus credit for an asset, the reverse for a liability. */
function normalBalance(row: Pick<TrialBalanceRow, 'closing_debit' | 'closing_credit'> | undefined, side: 'debit' | 'credit'): number {
  if (!row) return 0
  const net = row.closing_debit - row.closing_credit
  return roundOre(side === 'debit' ? net : -net)
}

function openingBalance(row: TrialBalanceRow | undefined, side: 'debit' | 'credit'): number {
  if (!row) return 0
  const net = row.opening_debit - row.opening_credit
  return roundOre(side === 'debit' ? net : -net)
}

function balancePeriod(source: BalanceSource, asOf: string): MeasureComputation['period'] {
  return { start: source.fiscalPeriod.period_start, end: asOf, fiscal_period_id: source.fiscalPeriod.id }
}

/**
 * The tie-out of a balance measure: each account's huvudbok (opening plus
 * lines up to the date) equals its contributor, and the contributors add up
 * to the value.
 */
function balanceBreakdown(
  value: number,
  contributors: MeasureContributor[],
  ledgers: Map<string, AccountLedger>,
  side: 'debit' | 'credit',
): MeasureBreakdown {
  const problems: string[] = []
  for (const c of contributors) {
    const ledger = ledgers.get(c.account_number!)
    const closing = ledger ? (side === 'debit' ? ledger.closing : -ledger.closing) : 0
    if (!tiesOut(closing, c.amount, (ledger?.lines.length ?? 0) + 1)) {
      problems.push(`account ${c.account_number}: huvudbok ${roundOre(closing)} vs balance ${c.amount}`)
    }
  }
  const sum = contributors.reduce((acc, c) => acc + c.amount, 0)
  if (!tiesOut(sum, value, contributors.length)) problems.push(`contributors sum ${roundOre(sum)} vs value ${value}`)
  return {
    contributors,
    drilldown: { kind: 'journal_lines', items: flattenLines(ledgers.values()) },
    reconciles: problems.length === 0,
    ...(problems.length > 0 ? { reconciliation_note: problems.join('; ') } : {}),
  }
}

const NO_CAVEATS: MeasureCaveat[] = []

// ──────────────────────────────────────────────────────────────────
// Balance measures (as_of)
// ──────────────────────────────────────────────────────────────────

/** A balance measure on one account role, read off the balance sheet's trial balance. */
function roleBalanceMeasure(spec: {
  id: 'accounts_receivable' | 'accounts_payable'
  role: AccountRole
  side: 'debit' | 'credit'
  name_sv: string
  name_en: string
  definition: string
  definition_sv: string
}): MeasureDefinition<BalanceSource & { account: string }> {
  return {
    id: spec.id,
    name_sv: spec.name_sv,
    name_en: spec.name_en,
    definition: spec.definition,
    definition_sv: spec.definition_sv,
    unit: 'SEK',
    dimension: 'as_of',
    equals: {
      report: 'Balansräkning',
      figure: `the row of the ${spec.role} role account (asset_sections / equity_liability_sections), as_of = the measure's as_of`,
      v1_path: '/reports/balance-sheet',
      mcp_tool: 'gnubok_get_balance_sheet',
    },
    async compute(ctx, scope) {
      const { asOf } = scopeOf(scope, 'as_of')
      const account = roleAccount(await jurisdictionOf(ctx), spec.role, spec.name_sv)
      const source = await balanceAt(ctx, asOf)
      const row = source.rows.find((r) => r.account_number === account)
      return {
        result: {
          value: normalBalance(row, spec.side),
          count: null,
          as_of: asOf,
          period: balancePeriod(source, asOf),
          caveats: NO_CAVEATS,
          data_status: source.dataStatus,
        },
        source: { ...source, account },
      }
    },
    async explain(ctx, scope, { result, source }) {
      const { asOf } = scopeOf(scope, 'as_of')
      const row = source.rows.find((r) => r.account_number === source.account)
      const contributors: MeasureContributor[] = [
        {
          kind: 'account',
          account_number: source.account,
          name: row?.account_name ?? source.account,
          amount: normalBalance(row, spec.side),
          opening_balance: openingBalance(row, spec.side),
          role: spec.role,
        },
      ]
      const ledgers = await ledgerForAccounts(ctx, source.fiscalPeriod.id, [source.account], { toDate: asOf })
      return balanceBreakdown(result.value, contributors, ledgers, spec.side)
    },
  }
}

const accountsReceivable = roleBalanceMeasure({
  id: 'accounts_receivable',
  role: 'accounts_receivable',
  side: 'debit',
  name_sv: 'Kundfordringar',
  name_en: 'Accounts receivable',
  definition:
    'Booked balance (debit minus credit) of the receivables control account at the end of as_of_date: the account the accounts_receivable role resolves to for the company\'s jurisdiction (BAS 1510 in the Swedish pack), every posted entry up to the date, opening balance included. The ledger figure, not the invoice register: open customer invoices are unpaid_customer_invoices, and a difference between the two is what the receivables reconciliation investigates.',
  definition_sv:
    'Bokfört saldo (debet minus kredit) på kundfordringskontot vid dagens slut för as_of_date: kontot för rollen accounts_receivable (BAS 1510 i den svenska kontoplanen), alla bokförda verifikat till och med datumet, ingående balans inräknad. Bokföringens siffra, inte fakturaregistrets: obetalda kundfakturor är måttet unpaid_customer_invoices.',
})

const accountsPayable = roleBalanceMeasure({
  id: 'accounts_payable',
  role: 'accounts_payable',
  side: 'credit',
  name_sv: 'Leverantörsskulder',
  name_en: 'Accounts payable',
  definition:
    'Booked balance (credit minus debit) of the payables control account at the end of as_of_date: the account the accounts_payable role resolves to for the company\'s jurisdiction (BAS 2440 in the Swedish pack), every posted entry up to the date, opening balance included. The ledger figure, not the supplier invoice register: open supplier invoices are unpaid_supplier_invoices.',
  definition_sv:
    'Bokfört saldo (kredit minus debet) på leverantörsskuldkontot vid dagens slut för as_of_date: kontot för rollen accounts_payable (BAS 2440 i den svenska kontoplanen), alla bokförda verifikat till och med datumet, ingående balans inräknad. Bokföringens siffra, inte leverantörsfakturaregistrets: obetalda leverantörsfakturor är måttet unpaid_supplier_invoices.',
})

interface BankAccountRef {
  account: string
  cashAccountId?: string
  role?: AccountRole
}

const bankBalance: MeasureDefinition<BalanceSource & { accounts: BankAccountRef[] }> = {
  id: 'bank_balance',
  name_sv: 'Banksaldo (bokfört)',
  name_en: 'Bank balance (booked)',
  definition:
    'Booked balance (debit minus credit) at the end of as_of_date of each bank account, summed: the giro and bank accounts of the company\'s cash account register, plus the account the bank role resolves to (BAS 1930 in the Swedish pack). Per account in the explanation. The balance in the books, not the balance the bank reports: bank transactions without a verifikat are not in it (data_status counts them). Kassa (till) and payment-provider clearing accounts are not bank accounts; liquid_funds includes the till.',
  definition_sv:
    'Bokfört saldo (debet minus kredit) vid dagens slut för as_of_date på varje bankkonto, summerat: bolagets bank- och girokonton i kontoregistret plus kontot för rollen bank (BAS 1930 i den svenska kontoplanen). Per konto i förklaringen. Saldot i bokföringen, inte det banken visar: banktransaktioner utan verifikat ingår inte.',
  unit: 'SEK',
  dimension: 'as_of',
  equals: {
    report: 'Balansräkning',
    figure: 'the sum of the rows of these bank accounts in the group Kassa och bank, as_of = the measure\'s as_of',
    v1_path: '/reports/balance-sheet',
    mcp_tool: 'gnubok_get_balance_sheet',
  },
  async compute(ctx, scope) {
    const { asOf } = scopeOf(scope, 'as_of')
    const roleBank = roleAccount(await jurisdictionOf(ctx), 'bank', bankBalance.name_sv)
    const { data: register, error } = await ctx.supabase
      .from('cash_accounts')
      .select('id, ledger_account')
      .eq('company_id', ctx.companyId)
      .order('ledger_account', { ascending: true })
    if (error) throw Object.assign(new Error(`cash accounts read failed: ${error.message}`), { code: error.code })
    const byAccount = new Map<string, BankAccountRef>()
    for (const row of (register ?? []) as Array<{ id: string; ledger_account: string }>) {
      if (!isBankCashAccount(row) || byAccount.has(row.ledger_account)) continue
      byAccount.set(row.ledger_account, { account: row.ledger_account, cashAccountId: row.id })
    }
    const registered = byAccount.size
    byAccount.set(roleBank, { ...(byAccount.get(roleBank) ?? { account: roleBank }), role: 'bank' })
    const accounts = [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account))

    const source = await balanceAt(ctx, asOf)
    const rows = new Map(source.rows.map((r) => [r.account_number, r]))
    const value = roundOre(accounts.reduce((sum, a) => sum + normalBalance(rows.get(a.account), 'debit'), 0))
    const caveats: MeasureCaveat[] =
      registered === 0
        ? [
            {
              code: 'BANK_REGISTER_EMPTY',
              message_sv: `Bolaget har inga bankkonton i kontoregistret. Banksaldot avser kontot för rollen bank (${roleBank}); bankkonton på andra konton ingår inte.`,
              message_en: `The company has no bank accounts in its cash account register. The balance is the bank role account (${roleBank}) only; bank accounts booked on other accounts are not included.`,
            },
          ]
        : NO_CAVEATS
    return {
      result: { value, count: null, as_of: asOf, period: balancePeriod(source, asOf), caveats, data_status: source.dataStatus },
      source: { ...source, accounts },
    }
  },
  async explain(ctx, scope, { result, source }) {
    const { asOf } = scopeOf(scope, 'as_of')
    const rows = new Map(source.rows.map((r) => [r.account_number, r]))
    const contributors = source.accounts.map((a): MeasureContributor => {
      const row = rows.get(a.account)
      return {
        kind: 'account',
        account_number: a.account,
        name: row?.account_name ?? a.account,
        amount: normalBalance(row, 'debit'),
        opening_balance: openingBalance(row, 'debit'),
        ...(a.role ? { role: a.role } : {}),
        ...(a.cashAccountId ? { cash_account_id: a.cashAccountId } : {}),
      }
    })
    const ledgers = await ledgerForAccounts(
      ctx,
      source.fiscalPeriod.id,
      source.accounts.map((a) => a.account),
      { toDate: asOf },
    )
    return balanceBreakdown(result.value, contributors, ledgers, 'debit')
  },
}

const liquidFunds: MeasureDefinition<BalanceSource & { overrides: string[] | undefined }> = {
  id: 'liquid_funds',
  name_sv: 'Likvida medel',
  name_en: 'Liquid funds',
  definition:
    'Kassa och bank: the closing balance (debit minus credit) at the end of as_of_date of every account in the cash and bank group (BAS 19xx in the Swedish pack), or of the accounts the company chose for the KPI "Kassa" when it overrode them (a caveat says so). Includes the till and every bank account, booked balances only. Equals the cash position of the KPI report (nyckeltal) over the fiscal year up to the date.',
  definition_sv:
    'Kassa och bank: utgående saldo (debet minus kredit) vid dagens slut för as_of_date på alla konton i gruppen kassa och bank (BAS 19xx i den svenska kontoplanen), eller på de konton bolaget valt för nyckeltalet Kassa. Bokförda saldon. Samma siffra som Kassa i nyckeltalsrapporten.',
  unit: 'SEK',
  dimension: 'as_of',
  equals: {
    report: 'Nyckeltal (KPI-rapporten)',
    figure: 'cash_position (MCP) / cashPosition (v1) for the fiscal year up to as_of',
    v1_path: '/reports/kpi',
    mcp_tool: 'gnubok_get_kpi_report',
  },
  async compute(ctx, scope) {
    const { asOf } = scopeOf(scope, 'as_of')
    const [source, overridesByKpi] = await Promise.all([
      balanceAt(ctx, asOf),
      fetchKpiAccountOverrides(ctx.supabase, ctx.companyId),
    ])
    const overrides = overridesByKpi['cashPosition']
    const caveats: MeasureCaveat[] =
      overrides && overrides.length > 0
        ? [
            {
              code: 'KPI_CASH_ACCOUNTS_CHOSEN',
              message_sv: `Bolaget har valt egna konton för nyckeltalet Kassa (${overrides.join(', ')}); likvida medel summerar de kontona.`,
              message_en: `The company chose its own accounts for the KPI "Kassa" (${overrides.join(', ')}); liquid funds sums those accounts.`,
            },
          ]
        : NO_CAVEATS
    return {
      result: {
        value: calculateCashPosition(source.rows, overrides),
        count: null,
        as_of: asOf,
        period: balancePeriod(source, asOf),
        caveats,
        data_status: source.dataStatus,
      },
      source: { ...source, overrides },
    }
  },
  async explain(ctx, scope, { result, source }) {
    const { asOf } = scopeOf(scope, 'as_of')
    const rows = cashPositionRows(source.rows, source.overrides)
    const contributors = rows.map(
      (row): MeasureContributor => ({
        kind: 'account',
        account_number: row.account_number,
        name: row.account_name,
        amount: normalBalance(row, 'debit'),
        opening_balance: openingBalance(row, 'debit'),
      }),
    )
    const ledgers = await ledgerForAccounts(
      ctx,
      source.fiscalPeriod.id,
      rows.map((r) => r.account_number),
      { toDate: asOf },
    )
    return balanceBreakdown(result.value, contributors, ledgers, 'debit')
  },
}

// ──────────────────────────────────────────────────────────────────
// Income statement measures (period, and result to date)
// ──────────────────────────────────────────────────────────────────

interface IncomeSource {
  fiscalPeriod: MeasureFiscalPeriod
  fromDate?: string
  toDate?: string
  report: IncomeStatementReport
}

/** The resultaträkning over the range, exactly as /reports/income-statement builds it. */
async function incomeStatementOver(
  ctx: MeasureContext,
  fiscalPeriod: MeasureFiscalPeriod,
  fromDate: string | undefined,
  toDate: string | undefined,
): Promise<IncomeSource> {
  const report = await generateIncomeStatement(ctx.supabase, ctx.companyId, fiscalPeriod.id, {
    ...(fromDate !== undefined ? { fromDate } : {}),
    ...(toDate !== undefined ? { toDate } : {}),
  })
  return { fiscalPeriod, fromDate, toDate, report }
}

/** One income statement row as a contributor, with the side its amount is read on and its sign in the measure. */
interface IncomePart {
  contributor: MeasureContributor
  side: 'credit' | 'debit'
  sign: 1 | -1
}

/**
 * The rows of the report's sections as contributors. A row's amount is on
 * its section's side (credit - debit for revenue and finansiella poster,
 * debit - credit for expenses); `sign` is how it counts in the measure (an
 * expense counts negative in the result).
 */
function sectionParts(
  sections: IncomeStatementSection[],
  side: 'credit' | 'debit',
  sign: 1 | -1,
  keep?: (account: string) => boolean,
): IncomePart[] {
  return sections.flatMap((section) =>
    section.rows
      .filter((row) => !keep || keep(row.account_number))
      .map((row) => ({
        contributor: {
          kind: 'account' as const,
          account_number: row.account_number,
          name: row.account_name,
          amount: roundOre(sign * row.amount),
        },
        side,
        sign,
      })),
  )
}

/**
 * The tie-out of an income statement measure: each account's huvudbok lines
 * in the range, bokslut entries left out as the resultaträkning leaves them
 * out, equal its row; the contributors add up to the value.
 */
async function incomeBreakdown(
  ctx: MeasureContext,
  source: IncomeSource,
  value: number,
  parts: IncomePart[],
): Promise<MeasureBreakdown> {
  const ledgers = await ledgerForAccounts(
    ctx,
    source.fiscalPeriod.id,
    parts.map((p) => p.contributor.account_number!),
    { fromDate: source.fromDate, toDate: source.toDate },
    { excludeYearEnd: true },
  )
  const problems: string[] = []
  for (const { contributor, side, sign } of parts) {
    const lines = ledgers.get(contributor.account_number!)?.lines ?? []
    const net = lines.reduce((sum, l) => sum + (side === 'credit' ? l.credit - l.debit : l.debit - l.credit), 0)
    const rowAmount = sign * contributor.amount
    if (!tiesOut(net, rowAmount, lines.length + 1)) {
      problems.push(`account ${contributor.account_number}: huvudbok lines ${roundOre(net)} vs report row ${rowAmount}`)
    }
  }
  const contributors = parts.map((p) => p.contributor)
  const sum = contributors.reduce((acc, c) => acc + c.amount, 0)
  if (!tiesOut(sum, value, contributors.length)) problems.push(`contributors sum ${roundOre(sum)} vs value ${value}`)
  return {
    contributors,
    drilldown: { kind: 'journal_lines', items: flattenLines(ledgers.values()) },
    reconciles: problems.length === 0,
    ...(problems.length > 0 ? { reconciliation_note: problems.join('; ') } : {}),
  }
}

function incomePeriod(source: IncomeSource): MeasureComputation['period'] {
  return {
    start: source.fromDate ?? source.fiscalPeriod.period_start,
    end: source.toDate ?? source.fiscalPeriod.period_end,
    fiscal_period_id: source.fiscalPeriod.id,
  }
}

async function incomeComputation(ctx: MeasureContext, source: IncomeSource, value: number): Promise<MeasureComputation> {
  const period = incomePeriod(source)
  return {
    value,
    count: null,
    as_of: period.end,
    period,
    caveats: NO_CAVEATS,
    data_status: await buildReportDataStatus(ctx.supabase, ctx.companyId, {
      periodId: source.fiscalPeriod.id,
      ...(source.fromDate !== undefined ? { fromDate: source.fromDate } : {}),
      ...(source.toDate !== undefined ? { toDate: source.toDate } : {}),
    }),
  }
}

const INCOME_STATEMENT_EQUALS = (figure: string) => ({
  report: 'Resultaträkning',
  figure,
  v1_path: '/reports/income-statement',
  mcp_tool: 'gnubok_get_income_statement',
})

const netRevenue: MeasureDefinition<IncomeSource> = {
  id: 'net_revenue',
  name_sv: 'Omsättning (nettoomsättning)',
  name_en: 'Net revenue (nettoomsättning)',
  definition:
    'Nettoomsättning over the range: sales including egna uttag, fakturerade kostnader and sidointäkter, net of intäktskorrigeringar (BAS 3000-3799), excluding VAT, before bokslut entries. Not other operating income (aktiverat arbete, övriga rörelseintäkter). Range: period_id and optional from_date/to_date inside it; default the fiscal year that contains today.',
  definition_sv:
    'Nettoomsättning för perioden: försäljning inklusive egna uttag, fakturerade kostnader och sidointäkter, minus intäktskorrigeringar (BAS 3000-3799), exklusive moms, före bokslutstransaktioner. Övriga rörelseintäkter ingår inte. Standard: räkenskapsåret som omfattar dagens datum.',
  unit: 'SEK',
  dimension: 'period',
  equals: INCOME_STATEMENT_EQUALS('nettoomsattning, same period_id/from_date/to_date'),
  async compute(ctx, scope) {
    const s = scopeOf(scope, 'period')
    const source = await incomeStatementOver(ctx, s.fiscalPeriod, s.fromDate, s.toDate)
    return { result: await incomeComputation(ctx, source, source.report.nettoomsattning ?? 0), source }
  },
  async explain(ctx, _scope, { result, source }) {
    const parts = sectionParts(source.report.revenue_sections, 'credit', 1, (account) =>
      inAccountRanges(account, NETTOOMSATTNING_RANGES),
    )
    return incomeBreakdown(ctx, source, result.value, parts)
  },
}

const operatingExpenses: MeasureDefinition<IncomeSource> = {
  id: 'operating_expenses',
  name_sv: 'Kostnader (rörelsekostnader)',
  name_en: 'Operating expenses',
  definition:
    'Operating expenses over the range: every expense account of the operating result (BAS classes 4-7: goods, external costs, personnel, depreciation booked outside bokslut), debit minus credit, excluding VAT, before bokslut entries. Not finansiella poster (interest) or skatt. Range: period_id and optional from_date/to_date inside it; default the fiscal year that contains today.',
  definition_sv:
    'Rörelsekostnader för perioden: alla kostnadskonton i rörelseresultatet (BAS klass 4-7), debet minus kredit, exklusive moms, före bokslutstransaktioner. Finansiella poster och skatt ingår inte. Standard: räkenskapsåret som omfattar dagens datum.',
  unit: 'SEK',
  dimension: 'period',
  equals: INCOME_STATEMENT_EQUALS('total_expenses, same period_id/from_date/to_date'),
  async compute(ctx, scope) {
    const s = scopeOf(scope, 'period')
    const source = await incomeStatementOver(ctx, s.fiscalPeriod, s.fromDate, s.toDate)
    return { result: await incomeComputation(ctx, source, source.report.total_expenses), source }
  },
  async explain(ctx, _scope, { result, source }) {
    return incomeBreakdown(ctx, source, result.value, sectionParts(source.report.expense_sections, 'debit', 1))
  },
}

const resultToDate: MeasureDefinition<IncomeSource> = {
  id: 'result_to_date',
  name_sv: 'Resultat hittills i år',
  name_en: 'Result year to date',
  definition:
    'Result of the fiscal year from its first day to the end of as_of_date: operating income minus operating expenses plus finansiella poster (BAS 3000-8998), before bokslut entries (skatt, bokslutsdispositioner and year-end depreciation are not deducted), so it is not årets resultat once bokslut is booked. as_of_date defaults to today.',
  definition_sv:
    'Räkenskapsårets resultat från första dagen till och med as_of_date: rörelseintäkter minus rörelsekostnader plus finansiella poster (BAS 3000-8998), före bokslutstransaktioner (skatt och bokslutsdispositioner är inte avdragna). Standard: dagens datum.',
  unit: 'SEK',
  dimension: 'as_of',
  equals: INCOME_STATEMENT_EQUALS('net_result with period_id = the fiscal year containing as_of and to_date = as_of'),
  async compute(ctx, scope) {
    const { asOf } = scopeOf(scope, 'as_of')
    const fiscalPeriod = await requireFiscalPeriodContaining(ctx, asOf)
    const source = await incomeStatementOver(ctx, fiscalPeriod, undefined, asOf)
    return { result: await incomeComputation(ctx, source, source.report.net_result), source }
  },
  async explain(ctx, _scope, { result, source }) {
    const parts = [
      ...sectionParts(source.report.revenue_sections, 'credit', 1),
      ...sectionParts(source.report.expense_sections, 'debit', -1),
      // Finansiella poster are read credit - debit (the 'mixed' sections).
      ...sectionParts(source.report.financial_sections, 'credit', 1),
    ]
    return incomeBreakdown(ctx, source, result.value, parts)
  },
}

// ──────────────────────────────────────────────────────────────────
// Moms att betala (vat_period)
// ──────────────────────────────────────────────────────────────────

const VAT_LINE_PAGE = 500
/** Pages per account the drill-down reads before it stops and says so. */
const VAT_LINE_MAX_PAGES = 10

async function vatLinesForAccount(
  ctx: MeasureContext,
  start: string,
  end: string,
  account: string,
): Promise<{ lines: MeasureJournalLine[]; complete: boolean }> {
  const lines: MeasureJournalLine[] = []
  let cursor: { date: string; voucher: number; entry: string; line: string } | null = null
  for (let page = 0; page < VAT_LINE_MAX_PAGES; page++) {
    // The ruta drill-down's RPC: it drops exactly the entries the
    // declaration's totals drop (momsredovisning, the closing entry).
    const { data, error } = await ctx.supabase.rpc('get_vat_ruta_source_lines', {
      p_company_id: ctx.companyId,
      p_start: start,
      p_end: end,
      p_accounts: [account],
      p_ruta_accounts: VAT_ACCOUNTS,
      p_net_accounts: VAT_SETTLEMENT_NET_ACCOUNTS,
      p_cursor_date: cursor?.date ?? null,
      p_cursor_voucher_number: cursor?.voucher ?? null,
      p_cursor_entry_id: cursor?.entry ?? null,
      p_cursor_line_id: cursor?.line ?? null,
      p_limit: VAT_LINE_PAGE + 1,
    })
    if (error) throw Object.assign(new Error(`get_vat_ruta_source_lines failed: ${error.message}`), { code: error.code })
    const rows = (Array.isArray(data) ? data : []) as Array<{
      line_id: string
      journal_entry_id: string
      voucher_number: number
      voucher_series: string | null
      entry_date: string
      description: string | null
      debit_amount: number | string
      credit_amount: number | string
    }>
    const pageRows = rows.slice(0, VAT_LINE_PAGE)
    for (const row of pageRows) {
      lines.push({
        journal_entry_id: row.journal_entry_id,
        handle: toHandle('journal_entry', row.journal_entry_id),
        voucher_series: row.voucher_series || 'A',
        voucher_number: row.voucher_number,
        date: row.entry_date,
        account_number: account,
        description: row.description || '',
        debit: roundOre(Number(row.debit_amount) || 0),
        credit: roundOre(Number(row.credit_amount) || 0),
      })
    }
    if (rows.length <= VAT_LINE_PAGE || pageRows.length === 0) return { lines, complete: true }
    const last = pageRows[pageRows.length - 1]
    cursor = { date: last.entry_date, voucher: last.voucher_number, entry: last.journal_entry_id, line: last.line_id }
  }
  return { lines, complete: false }
}

const RUTA_49_SIGN = new Map(RUTA_49_TERMS.map((term) => [term.box, term.sign]))

const vatPayable: MeasureDefinition<ComputedVatDeclaration> = {
  id: 'vat_payable',
  name_sv: 'Moms att betala eller få tillbaka',
  name_en: 'VAT payable or refundable',
  definition:
    'Ruta 49 of the momsdeklaration (SKV 4700) for one momsperiod: output VAT (rutor 10-12, 30-32, 60-62) minus deductible input VAT (ruta 48). Positive = VAT to pay to Skatteverket, negative = VAT to get back. Read from the ledger exactly as the VAT report reads it: momsredovisning verifikat and the closing entry are left out. Requires period_type, year and period (helårsmoms: year = the year the räkenskapsår ends).',
  definition_sv:
    'Ruta 49 i momsdeklarationen (SKV 4700) för en momsperiod: utgående moms (rutor 10-12, 30-32, 60-62) minus avdragsgill ingående moms (ruta 48). Positivt belopp = moms att betala, negativt = moms att få tillbaka. Läses ur bokföringen precis som momsrapporten: momsredovisningar och bokslutsverifikatet ingår inte. Kräver period_type, year och period.',
  unit: 'SEK',
  dimension: 'vat_period',
  equals: {
    report: 'Momsdeklaration (SKV 4700)',
    figure: 'rutor.ruta49, same period_type/year/period',
    v1_path: '/reports/vat-declaration',
    mcp_tool: 'gnubok_get_vat_report',
  },
  async compute(ctx, scope) {
    const s = scopeOf(scope, 'vat_period')
    const computed = await computeVatDeclaration(ctx.supabase, ctx.companyId, s.periodType, s.year, s.period, {
      ...(s.fiscalPeriodId !== undefined ? { fiscalPeriodId: s.fiscalPeriodId } : {}),
    })
    const { declaration } = computed
    const caveats: MeasureCaveat[] = []
    if (computed.periodSource === 'calendar_fallback') {
      caveats.push({
        code: 'VAT_PERIOD_CALENDAR_FALLBACK',
        message_sv: `Inget räkenskapsår slutar under ${s.year}, så helårsmomsen räknades på kalenderåret ${declaration.period.start} till ${declaration.period.end}. Kontrollera perioden vid brutet räkenskapsår.`,
        message_en: `No fiscal year ends in ${s.year}, so the yearly VAT was computed over the calendar year ${declaration.period.start} to ${declaration.period.end}. Check the period for a broken fiscal year.`,
      })
    }
    const unmapped = declaration.revenueAccountsWithoutRuta ?? []
    if (unmapped.length > 0) {
      const accounts = unmapped.map((a) => a.account_number).join(', ')
      caveats.push({
        code: 'VAT_REVENUE_ACCOUNTS_WITHOUT_RUTA',
        message_sv: `Intäktskonton med saldo i perioden saknar momskod och ingår inte i någon ruta (${accounts}). Om försäljningen där var momspliktig utan bokförd moms är ruta 49 för låg.`,
        message_en: `Revenue accounts with a balance in the period have no VAT code and reach no ruta (${accounts}). If those sales carried VAT that was not booked, ruta 49 is too low.`,
      })
    }
    const fiscalPeriod = await fiscalPeriodContaining(ctx, declaration.period.end)
    const dataStatus = fiscalPeriod && declaration.period.start >= fiscalPeriod.period_start
      ? await buildReportDataStatus(ctx.supabase, ctx.companyId, {
          periodId: fiscalPeriod.id,
          fromDate: declaration.period.start,
          toDate: declaration.period.end,
        })
      : null
    return {
      result: {
        value: declaration.rutor.ruta49,
        count: null,
        as_of: declaration.period.end,
        period: { start: declaration.period.start, end: declaration.period.end, fiscal_period_id: fiscalPeriod?.id ?? null },
        caveats,
        data_status: dataStatus,
      },
      source: computed,
    }
  },
  async explain(ctx, _scope, { result, source }) {
    const { start, end } = source.declaration.period
    const [ledger, chart] = await Promise.all([
      loadVatDeclarationLedger(ctx.supabase, ctx.companyId, start, end),
      fetchTrialBalanceChart(ctx.supabase, ctx.companyId),
    ])
    const names = new Map(chart.map((a) => [a.account_number, a.account_name]))
    const parts = vatRutaContributions(ledger.totals, ledger.dynamicVatAccounts).filter(
      (c) => RUTA_49_SIGN.has(c.box) && c.amount !== 0,
    )
    const contributors = parts.map(
      (c): MeasureContributor => ({
        kind: 'account',
        account_number: c.account_number,
        name: names.get(c.account_number) ?? c.account_number,
        amount: roundOre(RUTA_49_SIGN.get(c.box)! * c.amount),
        ruta: c.box.replace('ruta', ''),
      }),
    )
    const problems: string[] = []
    const lines: MeasureJournalLine[] = []
    for (const part of parts) {
      const read = await vatLinesForAccount(ctx, start, end, part.account_number)
      lines.push(...read.lines)
      if (!read.complete) {
        problems.push(`account ${part.account_number}: more than ${VAT_LINE_PAGE * VAT_LINE_MAX_PAGES} lines, drill-down cut`)
        continue
      }
      const net = read.lines.reduce((sum, l) => sum + (part.side === 'credit' ? l.credit - l.debit : l.debit - l.credit), 0)
      if (!tiesOut(net, roundOre(part.amount), read.lines.length + 1)) {
        problems.push(`account ${part.account_number}: lines ${roundOre(net)} vs ruta amount ${roundOre(part.amount)}`)
      }
    }
    const sum = contributors.reduce((acc, c) => acc + c.amount, 0)
    if (!tiesOut(sum, result.value, contributors.length)) problems.push(`contributors sum ${roundOre(sum)} vs ruta 49 ${result.value}`)
    return {
      contributors,
      drilldown: { kind: 'journal_lines', items: sortLines(lines) },
      reconciles: problems.length === 0,
      ...(problems.length > 0 ? { reconciliation_note: problems.join('; ') } : {}),
    }
  },
}

// ──────────────────────────────────────────────────────────────────
// Invoice registers (as_of)
// ──────────────────────────────────────────────────────────────────

function fxCaveat(count: number, kind: 'customer' | 'supplier'): MeasureCaveat[] {
  if (count === 0) return []
  const sv = kind === 'customer' ? 'kundfakturor' : 'leverantörsfakturor'
  const en = kind === 'customer' ? 'customer invoices' : 'supplier invoices'
  return [
    {
      code: 'UNCONVERTED_FX_EXCLUDED',
      message_sv: `${count} ${sv} i utländsk valuta saknar valutakurs och ingår inte i beloppet. Beloppet är för lågt tills kursen är satt.`,
      message_en: `${count} foreign-currency ${en} have no exchange rate and are not in the amount, which is too low until the rate is set.`,
    },
  ]
}

const unpaidCustomerInvoices: MeasureDefinition<ARLedgerReport> = {
  id: 'unpaid_customer_invoices',
  name_sv: 'Obetalda kundfakturor',
  name_en: 'Unpaid customer invoices',
  definition:
    'The open customer invoices in the invoice register (kundreskontra) at as_of_date: amount = their outstanding amount in SEK at each invoice\'s rate (credit notes net), count = the invoices with an amount outstanding. Sent, overdue and partly paid invoices, and paid ones still waiting for Skatteverket\'s ROT/RUT share. A past as_of_date rebuilds the register as it stood that day. The register figure; the booked receivables are accounts_receivable.',
  definition_sv:
    'Öppna kundfakturor i kundreskontran per as_of_date: belopp = utestående i kronor efter varje fakturas kurs (kreditfakturor nettade), antal = fakturor med utestående belopp. Ett tidigare datum återskapar reskontran som den såg ut den dagen. Fakturaregistrets siffra; bokförda kundfordringar är måttet accounts_receivable.',
  unit: 'SEK',
  dimension: 'as_of',
  equals: {
    report: 'Kundreskontra',
    figure: 'total_outstanding (amount) and unpaid_count (count), same as_of_date',
    v1_path: '/reports/ar-ledger',
    mcp_tool: 'gnubok_get_ar_ledger',
  },
  async compute(ctx, scope) {
    const { asOf, live } = scopeOf(scope, 'as_of')
    // strict: a failed read refuses instead of answering an empty reskontra.
    const report = await generateARLedger(ctx.supabase, ctx.companyId, live ? undefined : asOf, { strict: true })
    const caveats = fxCaveat(report.unconverted_fx_count, 'customer')
    if (report.register_coverage.has_pre_register_invoices) {
      caveats.push({
        code: 'INVOICE_REGISTER_INCOMPLETE',
        message_sv: `Fakturaregistret är komplett från ${report.register_coverage.covers_from ?? 'okänt datum'}. Kundfordringar från tidigare finns bara som verifikat och ingår inte; jämför med måttet accounts_receivable.`,
        message_en: `The invoice register is complete from ${report.register_coverage.covers_from ?? 'an unknown date'}. Receivables from before exist only as journal entries and are not in this figure; compare with accounts_receivable.`,
      })
    }
    return {
      result: {
        value: report.total_outstanding,
        count: report.unpaid_count,
        as_of: asOf,
        period: { start: asOf, end: asOf, fiscal_period_id: null },
        caveats,
        data_status: null,
      },
      source: report,
    }
  },
  async explain(_ctx, _scope, { result, source }) {
    const contributors = source.entries.map(
      (entry): MeasureContributor => ({
        kind: 'customer',
        customer_id: entry.customer_id,
        handle: toHandle('customer', entry.customer_id) ?? undefined,
        name: entry.customer_name,
        amount: entry.total_outstanding,
      }),
    )
    const documents = source.entries.flatMap((entry) =>
      entry.invoices
        .filter((invoice) => invoice.outstanding !== 0)
        .map(
          (invoice): MeasureDocument => ({
            invoice_id: invoice.invoice_id,
            handle: toHandle('invoice', invoice.invoice_id),
            number: invoice.invoice_number || null,
            customer_id: entry.customer_id,
            counterparty_name: entry.customer_name,
            invoice_date: invoice.invoice_date,
            due_date: invoice.due_date,
            days_overdue: invoice.days_overdue,
            currency: invoice.currency,
            outstanding: invoice.outstanding,
            outstanding_sek: invoice.outstanding_sek,
          }),
        ),
    )
    return documentBreakdown(result, contributors, documents, 'invoices')
  },
}

const unpaidSupplierInvoices: MeasureDefinition<SupplierLedgerReport> = {
  id: 'unpaid_supplier_invoices',
  name_sv: 'Obetalda leverantörsfakturor',
  name_en: 'Unpaid supplier invoices',
  definition:
    'The open supplier invoices in the supplier invoice register (leverantörsreskontra) at as_of_date: amount = their remaining amount in SEK at each invoice\'s rate, count = the open invoices. Registered, approved, overdue and partly paid invoices; disputed and credited ones are not included. A past as_of_date rebuilds the register as it stood that day. The register figure; the booked payables are accounts_payable.',
  definition_sv:
    'Öppna leverantörsfakturor i leverantörsreskontran per as_of_date: belopp = återstående i kronor efter varje fakturas kurs, antal = öppna fakturor. Ett tidigare datum återskapar reskontran som den såg ut den dagen. Registrets siffra; bokförda leverantörsskulder är måttet accounts_payable.',
  unit: 'SEK',
  dimension: 'as_of',
  equals: {
    report: 'Leverantörsreskontra',
    figure: 'total_outstanding (amount) and unpaid_count (count), same as_of_date',
    v1_path: '/reports/supplier-ledger',
    mcp_tool: 'gnubok_get_supplier_ledger',
  },
  async compute(ctx, scope) {
    const { asOf, live } = scopeOf(scope, 'as_of')
    // includeInvoices adds the per-invoice detail the explanation lists; it
    // changes no total (the parity test reads the report without it).
    const report = await generateSupplierLedger(ctx.supabase, ctx.companyId, live ? undefined : asOf, {
      strict: true,
      includeInvoices: true,
    })
    return {
      result: {
        value: report.total_outstanding,
        count: report.unpaid_count,
        as_of: asOf,
        period: { start: asOf, end: asOf, fiscal_period_id: null },
        caveats: fxCaveat(report.unconverted_fx_count, 'supplier'),
        data_status: null,
      },
      source: report,
    }
  },
  async explain(_ctx, _scope, { result, source }) {
    const contributors = source.entries.map(
      (entry): MeasureContributor => ({
        kind: 'supplier',
        supplier_id: entry.supplier_id,
        handle: toHandle('supplier', entry.supplier_id) ?? undefined,
        name: entry.supplier_name,
        amount: roundOre(entry.total_outstanding),
      }),
    )
    const documents = source.entries.flatMap((entry) =>
      (entry.invoices ?? []).map(
        (invoice): MeasureDocument => ({
          supplier_invoice_id: invoice.supplier_invoice_id,
          handle: toHandle('supplier_invoice', invoice.supplier_invoice_id),
          number: invoice.supplier_invoice_number ?? (invoice.arrival_number !== null ? String(invoice.arrival_number) : null),
          supplier_id: entry.supplier_id,
          counterparty_name: entry.supplier_name,
          invoice_date: invoice.invoice_date,
          due_date: invoice.due_date,
          days_overdue: invoice.days_overdue,
          currency: invoice.currency,
          outstanding: invoice.outstanding,
          outstanding_sek: roundOre(invoice.outstanding_sek),
        }),
      ),
    )
    return documentBreakdown(result, contributors, documents, 'supplier_invoices')
  },
}

/** The tie-out of an invoice measure: documents add up to their counterparty, counterparties to the value. */
function documentBreakdown(
  result: MeasureComputation,
  contributors: MeasureContributor[],
  documents: MeasureDocument[],
  kind: 'invoices' | 'supplier_invoices',
): MeasureBreakdown {
  const problems: string[] = []
  const byCounterparty = new Map<string, { sum: number; n: number }>()
  for (const doc of documents) {
    const key = doc.customer_id ?? doc.supplier_id ?? ''
    const entry = byCounterparty.get(key) ?? { sum: 0, n: 0 }
    entry.sum += doc.outstanding_sek ?? 0
    entry.n += 1
    byCounterparty.set(key, entry)
  }
  for (const c of contributors) {
    const key = c.customer_id ?? c.supplier_id ?? ''
    const docs = byCounterparty.get(key) ?? { sum: 0, n: 0 }
    if (!tiesOut(docs.sum, c.amount, docs.n)) problems.push(`${c.kind} ${key}: documents ${roundOre(docs.sum)} vs ${c.amount}`)
  }
  const sum = contributors.reduce((acc, c) => acc + c.amount, 0)
  if (!tiesOut(sum, result.value, contributors.length)) problems.push(`contributors sum ${roundOre(sum)} vs value ${result.value}`)
  const sorted = [...documents].sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || (a.number ?? '').localeCompare(b.number ?? ''),
  )
  return {
    contributors,
    drilldown: { kind, items: sorted },
    reconciles: problems.length === 0,
    ...(problems.length > 0 ? { reconciliation_note: problems.join('; ') } : {}),
  }
}

/** Every measure, in the order the list answers them. */
export const MEASURE_DEFINITIONS = [
  vatPayable,
  accountsReceivable,
  accountsPayable,
  bankBalance,
  liquidFunds,
  resultToDate,
  netRevenue,
  operatingExpenses,
  unpaidCustomerInvoices,
  unpaidSupplierInvoices,
] as const satisfies ReadonlyArray<AnyMeasureDefinition>
