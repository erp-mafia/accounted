import type { SupabaseClient } from '@supabase/supabase-js'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import type { BusinessEventCategory } from '@/lib/posting/categories'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { roundOre } from '@/lib/money'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import { matchPairs, unmatchLink, type AppliedLink, type SkippedPair } from './actions'
import { parseAccountKey } from './schemas'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'

const log = createLogger('reconciliation/residual')

/**
 * Residual booking: the worksheet selection (N bank rows against one
 * verifikat) misses by a few kronor, and the remainder is a real event the
 * books lack: a bank fee, interest, öresavrundning. This books that remainder
 * as its own small verifikat on the bank account and settles the selection in
 * the same gesture: the rows point at the main verifikat as usual, and the
 * residual verifikat is anchored to the first row through
 * transaction_voucher_links, which the bridge treats as a link.
 *
 * Bank accounts only: Skatteverket posts ränta and avgifter as rows of their
 * own on the skattekonto, so a skattekonto pair that does not close is a
 * wrong booking, never a missing fee.
 */

export type ResidualKind = 'bank_fee' | 'rounding' | 'interest_income' | 'interest_expense'

export const RESIDUAL_KINDS: Record<
  ResidualKind,
  { account: string; label_sv: string; label_en: string; direction: 'out' | 'in' | 'any' }
> = {
  // Money that left the bank without a booking: expenses.
  bank_fee: { account: '6570', label_sv: 'Bankavgift', label_en: 'Bank fee', direction: 'out' },
  interest_expense: { account: '8410', label_sv: 'Räntekostnad', label_en: 'Interest expense', direction: 'out' },
  // Money that reached the bank without a booking: income.
  interest_income: { account: '8310', label_sv: 'Ränteintäkt', label_en: 'Interest income', direction: 'in' },
  // Either way, öre-level.
  rounding: { account: '3740', label_sv: 'Öresavrundning', label_en: 'Rounding', direction: 'any' },
}

export type ResidualErrorCode =
  | 'RESIDUAL_UNSUPPORTED_KIND'
  | 'RESIDUAL_ROWS_NOT_FOUND'
  | 'RESIDUAL_ROW_NOT_OPEN'
  | 'RESIDUAL_ENTRY_NOT_FOUND'
  | 'RESIDUAL_ENTRY_NOT_POSTED'
  | 'RESIDUAL_ZERO'
  | 'RESIDUAL_TOO_LARGE'
  | 'RESIDUAL_DIRECTION'
  | 'RESIDUAL_NO_PERIOD'
  | 'RESIDUAL_LINK_FAILED'
  | 'RESIDUAL_INVALID_DATE'
  | 'RESIDUAL_FOREIGN_CURRENCY'

export class ReconciliationResidualError extends Error {
  readonly code: ResidualErrorCode
  constructor(message: string, code: ResidualErrorCode) {
    super(message)
    this.name = 'ReconciliationResidualError'
    this.code = code
  }
}

/** The business event category of each residual kind; öresavrundning names none. */
export const RESIDUAL_CATEGORY: Readonly<Record<ResidualKind, BusinessEventCategory | null>> = {
  bank_fee: 'expense.bank_fees',
  interest_income: 'finance.banking',
  interest_expense: 'finance.banking',
  rounding: null,
}

/**
 * The business event of a residual verifikat, for the posting port (step
 * 2i): ledger.manual, the kind its source type names (a person booked it
 * from the worksheet in the same gesture as the link), filed under its
 * kind's category, dated the verifikat's date. The subject is the bank line
 * the residual verifikat is anchored to; the amount is the remainder booked,
 * its sign the direction, and the rule source names RESIDUAL_KINDS, the
 * account each kind books on. Pure: built only while POSTING_EVENTS is on.
 */
export function residualBusinessEvent(args: {
  kind: ResidualKind
  transactionId: string
  entryDate: string
  /** The remainder as booked, signed: negative money left the bank. */
  residual: number
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  const amount = roundOre(Math.abs(args.residual))
  const linkEvidence = args.linkBasis.link_evidence ?? null
  return {
    kind: 'ledger.manual',
    category: RESIDUAL_CATEGORY[args.kind],
    occurredOn: args.entryDate,
    subject: { type: 'transaction', id: args.transactionId },
    // The verifikat's own amount: its lines are in the ledger currency.
    currency: 'SEK',
    amount,
    amountSek: amount,
    evidence: {
      direction: args.residual < 0 ? 'out' : 'in',
      link_basis: args.linkBasis.link_basis,
      link_evidence: linkEvidence ?? undefined,
    },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('reconciliationResidual'),
    jurisdiction: 'SE',
  }
}

/** Above this, a "residual" is a missing booking, not a fee: refuse so the user books it properly. */
export const RESIDUAL_MAX_AMOUNT = 5000

export interface ResidualInput {
  external_ids: string[]
  journal_entry_id: string
  kind: ResidualKind
  /** Defaults to the latest selected transaction's date. */
  entry_date?: string
  /** Defaults to "<kind label>: <main verifikat description>". */
  description?: string
}

export interface ResidualPreview {
  account_key: string
  kind: ResidualKind
  counter_account: string
  ledger_account: string
  currency: string
  transactions_total: number
  entry_net: number
  /** transactions_total - entry_net: negative = the bank paid more than booked. */
  residual_amount: number
  entry_date: string
  description: string
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
}

export type ResidualResult =
  | { dry_run: true; would_book: ResidualPreview }
  | {
      dry_run: false
      residual_journal_entry_id: string
      residual_amount: number
      applied: AppliedLink[]
      skipped: SkippedPair[]
    }

interface TxRow {
  id: string
  date: string
  amount: number | string
  description: string | null
  journal_entry_id: string | null
  is_ignored: boolean | null
  cash_account_id: string | null
}

export async function bookResidualAndLink(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  input: ResidualInput,
  options: { dryRun?: boolean } = {},
): Promise<ResidualResult | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return null
  if (parsed.kind !== 'bank') {
    throw new ReconciliationResidualError(
      'Restbelopp bokförs bara på bankkonton. På skattekontot är ränta och avgifter egna händelser: koppla dem i stället.',
      'RESIDUAL_UNSUPPORTED_KIND',
    )
  }
  const spec = RESIDUAL_KINDS[input.kind]
  if (!spec) {
    throw new ReconciliationResidualError('Okänd typ av restbelopp.', 'RESIDUAL_UNSUPPORTED_KIND')
  }
  if (input.entry_date && !ISO_DATE_RE.test(input.entry_date)) {
    throw new ReconciliationResidualError('Ogiltigt datum. Ange ÅÅÅÅ-MM-DD.', 'RESIDUAL_INVALID_DATE')
  }

  const { data: account } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account, currency')
    .eq('company_id', companyId)
    .eq('id', parsed.cashAccountId)
    .maybeSingle<{ id: string; ledger_account: string; currency: string | null }>()
  if (!account) return null
  const ledgerAccount = account.ledger_account
  const currency = account.currency ?? 'SEK'
  // The residual is the rows' sum minus the verifikat's bank leg. On a
  // foreign account the rows are in its currency and the lines in kronor, so
  // the difference mixes the two (+101 EUR against a 1,150 kr leg read as a
  // 1,049 kr residual), and a fee there is an amount in that currency, not a
  // kronor line. Refused before anything is read or booked (accounted#58).
  if (!isKronorCurrency(currency)) {
    throw new ReconciliationResidualError(
      `Restbelopp bokförs bara på bankkonton i kronor. Kontot är i ${currency}: bokför avgiften eller räntan som ett eget verifikat med beloppet i kronor och koppla transaktionerna till verifikaten.`,
      'RESIDUAL_FOREIGN_CURRENCY',
    )
  }

  const ids = [...new Set(input.external_ids)]
  if (ids.length === 0 || ids.length > 50) {
    throw new ReconciliationResidualError('Välj mellan 1 och 50 banktransaktioner.', 'RESIDUAL_ROWS_NOT_FOUND')
  }
  const { data: txRows, error: txError } = await supabase
    .from('transactions')
    .select('id, date, amount, description, journal_entry_id, is_ignored, cash_account_id')
    .eq('company_id', companyId)
    .in('id', ids)
  if (txError || !txRows || txRows.length !== ids.length) {
    throw new ReconciliationResidualError('Någon av banktransaktionerna hittades inte.', 'RESIDUAL_ROWS_NOT_FOUND')
  }
  const txs = txRows as TxRow[]
  if (txs.some((t) => t.journal_entry_id || t.is_ignored)) {
    throw new ReconciliationResidualError(
      'En av transaktionerna är redan kopplad eller ignorerad.',
      'RESIDUAL_ROW_NOT_OPEN',
    )
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, description, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )')
    .eq('id', input.journal_entry_id)
    .eq('company_id', companyId)
    .maybeSingle<{
      id: string
      status: string
      description: string | null
      lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
    }>()
  if (entryError || !entry) {
    throw new ReconciliationResidualError('Verifikatet hittades inte.', 'RESIDUAL_ENTRY_NOT_FOUND')
  }
  if (entry.status !== 'posted') {
    throw new ReconciliationResidualError('Verifikatet är inte bokfört.', 'RESIDUAL_ENTRY_NOT_POSTED')
  }
  const entryNet = roundOre(
    (entry.lines ?? [])
      .filter((l) => l.account_number === ledgerAccount)
      .reduce((s, l) => s + Number(l.debit_amount || 0) - Number(l.credit_amount || 0), 0),
  )
  const txTotal = roundOre(txs.reduce((s, t) => s + Number(t.amount || 0), 0))
  const residual = roundOre(txTotal - entryNet)

  if (Math.abs(residual) < 0.005) {
    throw new ReconciliationResidualError(
      'Summorna stämmer redan: koppla utan restbelopp.',
      'RESIDUAL_ZERO',
    )
  }
  if (Math.abs(residual) > RESIDUAL_MAX_AMOUNT) {
    throw new ReconciliationResidualError(
      `Restbeloppet är större än ${RESIDUAL_MAX_AMOUNT} kr. Det är en saknad bokföring, inte en avgift: bokför den som ett eget verifikat.`,
      'RESIDUAL_TOO_LARGE',
    )
  }
  const direction: 'out' | 'in' = residual < 0 ? 'out' : 'in'
  if (spec.direction !== 'any' && spec.direction !== direction) {
    throw new ReconciliationResidualError(
      direction === 'out'
        ? 'Banken har betalat ut mer än vad som är bokfört: restbeloppet är en kostnad (avgift eller räntekostnad), inte en intäkt.'
        : 'Banken har tagit emot mer än vad som är bokfört: restbeloppet är en intäkt (ränteintäkt), inte en kostnad.',
      'RESIDUAL_DIRECTION',
    )
  }

  const amount = roundOre(Math.abs(residual))
  // Expense: the bank line is a credit (money left), the counter account a debit.
  // Income: the bank line is a debit (money arrived), the counter a credit.
  const lines =
    direction === 'out'
      ? [
          { account_number: spec.account, debit_amount: amount, credit_amount: 0 },
          { account_number: ledgerAccount, debit_amount: 0, credit_amount: amount },
        ]
      : [
          { account_number: ledgerAccount, debit_amount: amount, credit_amount: 0 },
          { account_number: spec.account, debit_amount: 0, credit_amount: amount },
        ]

  const latestTxDate = txs.map((t) => t.date).sort().at(-1) ?? todayIsoStockholm()
  const entryDate = input.entry_date ?? latestTxDate
  const description =
    input.description?.trim() ||
    `${spec.label_sv}: ${entry.description?.trim() || txs[0].description?.trim() || 'avstämning'}`

  const preview: ResidualPreview = {
    account_key: accountKey,
    kind: input.kind,
    counter_account: spec.account,
    ledger_account: ledgerAccount,
    currency,
    transactions_total: txTotal,
    entry_net: entryNet,
    residual_amount: residual,
    entry_date: entryDate,
    description,
    lines,
  }
  if (options.dryRun) return { dry_run: true, would_book: preview }

  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new ReconciliationResidualError(
      `Det finns inget räkenskapsår för ${entryDate}.`,
      'RESIDUAL_NO_PERIOD',
    )
  }

  // Link first (reversible), then book. If the booking is refused (a lock, a
  // trigger), the links are undone so the selection is back where it was.
  // The rows may take the residual beyond the main verifikat's bank leg: the
  // residual verifikat booked right below is what explains it (the room
  // check, lib/transactions/voucher-bank-leg.ts, GitHub #3507).
  const linkResult = await matchPairs(
    supabase,
    companyId,
    userId,
    accountKey,
    { pairs: [{ external_ids: ids, journal_entry_ids: [entry.id] }] },
    { dryRun: false, bankLegOverrun: residual },
  )
  if (!linkResult || linkResult.applied.length !== ids.length) {
    // Undo whatever did link before reporting.
    for (const a of linkResult?.applied ?? []) {
      try {
        await unmatchLink(supabase, companyId, userId, accountKey, a.external_id)
      } catch {
        // best effort
      }
    }
    const first = linkResult?.skipped[0]
    throw new ReconciliationResidualError(
      first ? first.message : 'Kunde inte koppla transaktionerna till verifikatet.',
      'RESIDUAL_LINK_FAILED',
    )
  }

  let residualEntry: { id: string }
  try {
    // Posting port (step 2i): the engine gets the same input and, while
    // POSTING_EVENTS is on, the residual's event is linked before the number.
    residualEntry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () =>
        residualBusinessEvent({ kind: input.kind, transactionId: ids[0], entryDate, residual, linkBasis: linkBasisColumns('user_created') }),
      input: {
        fiscal_period_id: fiscalPeriodId,
        entry_date: entryDate,
        description,
        source_type: 'manual',
        lines,
      },
    })
  } catch (err) {
    for (const id of ids) {
      try {
        await unmatchLink(supabase, companyId, userId, accountKey, id)
      } catch {
        // best effort
      }
    }
    throw err
  }

  // Anchor the residual verifikat to the selection through the junction (the
  // rows' pointer column already holds the main verifikat). One row carries
  // the whole residual so Sum(allocated_amount) per verifikat equals its bank
  // side, the invariant bulk-book keeps.
  const { error: linkError } = await supabase.from('transaction_voucher_links').insert({
    user_id: userId,
    company_id: companyId,
    transaction_id: ids[0],
    journal_entry_id: residualEntry.id,
    allocated_amount: residual,
    role: 'other',
    // The residual verifikat was booked from this selection in the same act.
    ...linkBasisColumns('user_created'),
  })
  if (linkError) {
    log.error('residual verifikat booked but the junction link failed', linkError, {
      companyId,
      accountKey,
      residualEntryId: residualEntry.id,
    })
  }

  log.info('residual booked and linked', {
    companyId,
    accountKey,
    kind: input.kind,
    residual,
    residualEntryId: residualEntry.id,
    linked: ids.length,
  })

  return {
    dry_run: false,
    residual_journal_entry_id: residualEntry.id,
    residual_amount: residual,
    applied: linkResult.applied,
    skipped: linkResult.skipped,
  }
}
