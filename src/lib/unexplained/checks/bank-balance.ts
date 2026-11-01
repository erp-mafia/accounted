/**
 * The bank check: what the bank reports for each bank account against the
 * booked balance of the account it books on, on the day the bank reported it.
 *
 * The bank's side is the booked balance the last PSD2 balance refresh stored
 * on the cash account (cash_accounts.balance), dated by the bank's own day
 * for it when the bank gave one, else by the fetch (bankBalanceDay): the
 * figure the reconciliation page prints as "Banken visar". The ledger side is
 * the balance sheet's figure for that account at the end of that day (the
 * trial balance with the closing entry, as the bank_balance measure reads
 * it). Comparing on the bank's own date keeps a balance fetched days ago, or
 * a close of yesterday, from showing every later verifikat as a difference.
 *
 * Basis: 1930 Företagskonto (every bank account) is reconciled against the
 * bank statement, Phase 1 of the bokslut (swedish-year-end-closing).
 *
 * The explanation lists the bank's transactions on that account up to that
 * day that have no verifikat (lib/transactions/unbooked.ts, the one
 * definition behind every "unbooked" figure): money the bank has moved and
 * the books have not. What they do not cover is the residual.
 */
import { isBankCashAccount } from '@/lib/cash-accounts/invoice-payee-rules'
import { supersededTwins } from '@/lib/cash-accounts/twins'
import { toHandle } from '@/lib/handles'
import { tiesOut } from '@/lib/measures/explain'
import { fiscalPeriodContaining } from '@/lib/measures/params'
import { roundOre } from '@/lib/money'
import { bankBalanceDay, bookedBalancesAt } from '@/lib/reconciliation/bank-balance-check'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { cannotCheck, companyFacts, kronor, noFiscalPeriod, sourceFailed, statusFor, sumOre } from '../shared'
import type { CheckBreakdown, CheckContext, CheckDefinition, CheckItem, CheckNextAction, CheckRun, CheckSide, CheckSource, CheckSubject } from '../types'

const TOLERANCE = 0.005

/** Explanation rows read per account before the list stops and says so. */
const MAX_UNBOOKED_ROWS = 2000

const BANK_SOURCE: CheckSource = {
  report: 'Bankens rapporterade saldo (kontoregistret, senaste saldohämtningen)',
  v1_path: '/cash-accounts',
  mcp_tool: 'gnubok_list_cash_accounts',
  screen: '/reconciliation',
}

const LEDGER_SOURCE: CheckSource = {
  report: 'Balansräkning, bankkontots rad per dagen banken rapporterade saldot',
  v1_path: '/reports/balance-sheet',
  mcp_tool: 'gnubok_get_balance_sheet',
  screen: '/reports/balance-sheet',
}

interface CashAccountRow {
  id: string
  name: string | null
  ledger_account: string
  currency: string
  iban: string | null
  balance: number | string | null
  balance_updated_at: string | null
  balance_reference: unknown
  is_primary: boolean
  created_at: string
}

interface BankSource {
  cashAccountId: string
  account: string
  reported: number
  booked: number
}

function subjectOf(row: CashAccountRow): CheckSubject {
  return {
    kind: 'bank_account',
    cash_account_id: row.id,
    handle: toHandle('cash_account', row.id),
    account_number: row.ledger_account,
    name: row.name ?? `Bankkonto ${row.ledger_account}`,
  }
}

function sidesOf(reported: number | null, booked: number | null, account: string): CheckSide[] {
  return [
    { key: 'bank', label_sv: 'Saldo enligt banken', label_en: 'Balance according to the bank', amount: reported, source: BANK_SOURCE },
    {
      key: 'ledger',
      label_sv: `Bokfört saldo på ${account}`,
      label_en: `Booked balance on ${account}`,
      amount: booked,
      source: LEDGER_SOURCE,
    },
  ]
}

async function run(ctx: CheckContext): Promise<CheckRun<BankSource>[]> {
  const company: CheckSubject = { kind: 'company' }
  let rows: CashAccountRow[]
  let ledgerCurrency: string | null
  try {
    ledgerCurrency = (await companyFacts(ctx)).ledgerCurrency
    const { data, error } = await ctx.supabase
      .from('cash_accounts')
      .select('id, name, ledger_account, currency, iban, is_primary, created_at, balance, balance_updated_at, balance_reference')
      .eq('company_id', ctx.companyId)
      .eq('enabled', true)
      .order('ledger_account', { ascending: true })
    if (error) throw Object.assign(new Error(error.message), { code: error.code })
    // A reconnect duplicate is a copy of the same bank account, not a second balance.
    const banks = ((data ?? []) as CashAccountRow[]).filter((r) => isBankCashAccount(r))
    const twins = await supersededTwins(ctx.supabase, ctx.companyId, banks)
    rows = banks.filter((r) => !twins.has(r.id))
  } catch (err) {
    return [cannotCheck(company, ctx.today, sourceFailed('bank_balance_vs_bank', 'Kontoregistret', err))]
  }
  if (rows.length === 0) {
    return [
      cannotCheck(company, ctx.today, {
        code: 'NO_BANK_BALANCE',
        message_sv: 'Bolaget har inget bankkonto i kontoregistret, så det finns inget banksaldo att jämföra med.',
        message_en: 'The company has no bank account in its cash account register, so there is no bank balance to compare with.',
      }),
    ]
  }

  const perLedgerAccount = new Map<string, number>()
  for (const row of rows) perLedgerAccount.set(row.ledger_account, (perLedgerAccount.get(row.ledger_account) ?? 0) + 1)
  const balances = new Map<string, Promise<Map<string, number>>>()
  const balanceAt = (fiscalPeriodId: string, date: string) => {
    const key = `${fiscalPeriodId}|${date}`
    let pending = balances.get(key)
    if (!pending) {
      pending = bookedBalancesAt(ctx.supabase, ctx.companyId, fiscalPeriodId, date)
      balances.set(key, pending)
    }
    return pending
  }

  return Promise.all(
    rows.map(async (row): Promise<CheckRun<BankSource>> => {
      const subject = subjectOf(row)
      if ((perLedgerAccount.get(row.ledger_account) ?? 0) > 1) {
        return cannotCheck(subject, ctx.today, {
          code: 'SHARED_LEDGER_ACCOUNT',
          message_sv: `Flera bankkonton bokförs på ${row.ledger_account}, så kontots saldo kan inte jämföras med ett enskilt banksaldo. Ge varje bankkonto ett eget bokföringskonto.`,
          message_en: `Several bank accounts book on ${row.ledger_account}, so its balance cannot be compared with one bank balance. Give each bank account its own ledger account.`,
          details: { account_number: row.ledger_account },
        })
      }
      if (!ledgerCurrency || row.currency !== ledgerCurrency) {
        return cannotCheck(subject, ctx.today, {
          code: 'FOREIGN_CURRENCY_ACCOUNT',
          message_sv: `Kontot förs i ${row.currency} och bokföringen i ${ledgerCurrency ?? 'okänd valuta'}, så saldona är inte jämförbara.`,
          message_en: `The account is kept in ${row.currency} and the ledger in ${ledgerCurrency ?? 'an unknown currency'}, so the balances are not comparable.`,
          details: { currency: row.currency, ledger_currency: ledgerCurrency },
        })
      }
      if (row.balance === null || row.balance_updated_at === null) {
        return cannotCheck(subject, ctx.today, {
          code: 'NO_BANK_BALANCE',
          message_sv: `Banken har inte rapporterat något saldo för ${subject.kind === 'bank_account' ? subject.name : row.ledger_account}. Koppla kontot till banken, eller stäm av mot kontoutdraget.`,
          message_en: 'The bank has reported no balance for this account. Connect it to the bank, or reconcile against the bank statement.',
        })
      }
      const reported = roundOre(Number(row.balance))
      const day = bankBalanceDay(row.balance_updated_at, row.balance_reference)
      const asOf = day.date
      try {
        const period = await fiscalPeriodContaining(ctx, asOf)
        if (!period) return cannotCheck(subject, asOf, noFiscalPeriod(asOf), sidesOf(reported, null, row.ledger_account))
        const booked = (await balanceAt(period.id, asOf)).get(row.ledger_account) ?? 0
        const difference = roundOre(reported - booked)
        const status = statusFor(difference, TOLERANCE)
        return {
          subject,
          status,
          difference,
          as_of: asOf,
          summary_sv:
            status === 'ok'
              ? `Bokfört saldo på ${row.ledger_account} stämmer med bankens saldo ${asOf}.`
              : `Banken visade ${kronor(reported)} ${asOf} men ${row.ledger_account} har ${kronor(booked)} bokfört: differens ${kronor(difference)}.`,
          sides: sidesOf(reported, booked, row.ledger_account),
          refusal: null,
          facts: { balance_fetched_at: row.balance_updated_at, balance_type: day.type },
          source: { cashAccountId: row.id, account: row.ledger_account, reported, booked },
        }
      } catch (err) {
        return cannotCheck(subject, asOf, sourceFailed('bank_balance_vs_bank', 'Balansräkningen', err))
      }
    }),
  )
}

async function explain(ctx: CheckContext, run: CheckRun<BankSource>): Promise<CheckBreakdown> {
  const source = run.source
  if (!source || run.difference === null) return { parts: [], items: [], residual: null, reconciles: false }
  const rows = await fetchAllRows<{ id: string; date: string; description: string | null; amount: number | string; currency: string | null }>(
    ({ from, to }) =>
      ctx.supabase
        .from('open_bank_rows')
        .select('id, date, description, amount, currency')
        .eq('company_id', ctx.companyId)
        .eq('cash_account_id', source.cashAccountId)
        .lte('date', run.as_of)
        .order('date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { maxRows: MAX_UNBOOKED_ROWS },
  )
  const items: CheckItem[] = rows.map((row) => ({
    part: 'unbooked_transactions',
    item_type: 'transaction',
    transaction_id: row.id,
    handle: toHandle('transaction', row.id),
    date: row.date,
    label: row.description || 'Banktransaktion',
    // In the bank's balance, not in the books: it counts as it moved the bank.
    amount: roundOre(Number(row.amount) || 0),
    ...(row.currency ? { currency: row.currency } : {}),
  }))
  const explained = sumOre(items.map((i) => i.amount))
  const residual = roundOre(run.difference - explained)
  const reconciles = tiesOut(explained, run.difference, items.length + 1)
  const notes: string[] = []
  if (rows.length >= MAX_UNBOOKED_ROWS) notes.push(`Only the first ${MAX_UNBOOKED_ROWS} unbooked transactions were read.`)
  if (!reconciles) {
    notes.push(
      `Unbooked bank transactions explain ${explained} of ${run.difference}. The residual is usually a verifikat on ${source.account} with no bank transaction behind it (booked twice, or on the wrong account), a verifikat dated that day for a payment the bank had not booked when it reported the balance, an opening balance that differs from the bank's balance when its history starts (bank.opening_difference there), or bank transactions the feed has not delivered: gnubok_get_reconciliation_status with account_key bank:${source.cashAccountId} lists both sides.`,
    )
  }
  // Booking the unbooked rows cannot close a residual, so the step is the
  // account's reconciliation, not the uncategorized list (crm#1310).
  const nextAction: CheckNextAction | undefined = reconciles
    ? undefined
    : {
        message_sv:
          'Banktransaktionerna utan verifikat förklarar inte hela differensen. Gå igenom avstämningen för kontot: den visar båda sidorna, och bank.opening_difference visar om resten redan finns i ingående balansen eller i verifikat före bankens historik.',
        tool: 'gnubok_get_reconciliation_status',
        arguments: { account_key: `bank:${source.cashAccountId}` },
        screen: '/reconciliation',
      }
  return {
    parts: [
      {
        key: 'unbooked_transactions',
        label_sv: `Banktransaktioner utan verifikat till och med ${run.as_of}`,
        label_en: `Bank transactions without a verifikat through ${run.as_of}`,
        amount: explained,
        count: items.length,
      },
    ],
    items,
    residual,
    reconciles,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    ...(nextAction ? { next_action: nextAction } : {}),
  }
}

export const bankBalanceVsBank: CheckDefinition<BankSource> = {
  id: 'bank_balance_vs_bank',
  name_sv: 'Bokfört banksaldo mot bankens saldo',
  name_en: 'Booked bank balance against the bank\'s balance',
  definition:
    'Per bank account in the cash account register (giro and bank accounts; a reconnect duplicate counted once): the booked balance the bank reported at its last balance refresh (cash_accounts.balance) minus the booked balance (debit minus credit) of the ledger account the bank account books on, at the end of the bank\'s day for that balance (the day the bank gave with it, else the Stockholm day of the refresh), read as the balance sheet reads it. Zero means the books hold exactly what the bank held that day. Accounts without a reported balance, in another currency than the ledger, or sharing a ledger account cannot be checked.',
  definition_sv:
    'Per bankkonto i kontoregistret: saldot banken rapporterade vid senaste saldohämtningen minus bokfört saldo (debet minus kredit) på kontot bankkontot bokförs på, vid slutet av bankens dag för saldot (den dag banken angav, annars dagen saldot hämtades), så som balansräkningen läser det. Noll betyder att bokföringen har exakt det banken hade den dagen. Konton utan saldo från banken, i annan valuta än bokföringen eller som delar bokföringskonto kan inte kontrolleras.',
  basis:
    'Bank accounts (1920 Plusgiro, 1930 Företagskonto) are reconciled against the bank statement, Phase 1 of the bokslut (swedish-year-end-closing). A bank movement that is not booked also breaks BFL 5 kap. 2 § timing once it is old enough (see unbooked_bank_lines_overdue).',
  unit: 'SEK',
  tolerance: TOLERANCE,
  subject_kind: 'bank_account',
  compares: [BANK_SOURCE, LEDGER_SOURCE],
  next_action: {
    message_sv:
      'Bokför banktransaktionerna utan verifikat som förklaringen listar, och gå igenom avstämningen för kontot om en rest återstår.',
    tool: 'gnubok_list_uncategorized_transactions',
    screen: '/reconciliation',
  },
  run,
  explain,
}
