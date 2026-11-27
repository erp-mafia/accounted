/**
 * A bank row linked onto ONE verifikat that already exists teaches its bank
 * text as a counterparty template, from that verifikat's lines (crm#1746).
 *
 * Before this, only two doors taught a counterpart: a categorize booking and
 * ingest's confident auto-booking. Every door that books a row by linking it
 * to a posted verifikat taught nothing, so a migrated company whose rows were
 * reconciled onto imported vouchers, or an agent that creates the verifikat
 * and then links the row, got no proposal for a counterpart it pays every
 * month. The SIE learner keys its templates on voucher text, which is rarely
 * the bank's text.
 *
 * Writes through insertOrUpdateTemplate, the one template store, with the
 * SIE learner's multi-line reading of a verifikat (verifikatTemplateShape),
 * so pension plus särskild löneskatt is learned as one template. Nothing is
 * stored before the evidence holds.
 *
 * Who chose the pair decides the evidence:
 *   - explicit: a person or an agent named this verifikat for this row (the
 *     reconciliation page, a named pair, the duplicate dialog, v1 and MCP
 *     link, bulk booking onto an existing verifikat with one row). Taught at
 *     once, like a categorize booking.
 *   - automatic: the matcher chose it (runReconciliation, a confirmed
 *     suggestion, the auto-link after an invoice is linked to its voucher,
 *     proposals applied in bulk). Taught only once the same bank text has
 *     been linked onto a verifikat of the same accounts and moms before: an
 *     earlier link that would have taught the same shape, or a template
 *     already holding that shape. Repetition is the evidence one system match lacks
 *     (accounted#36). An automatic link never changes a template's accounts.
 *
 * Never taught, whoever linked:
 *   - a bank text that names no one (namesCounterparty, crm#1707, PH 118), a
 *     bookkeeping routine ("Lön", "Moms": the SIE learner's skip list) or a
 *     payment to Skatteverket;
 *   - a verifikat that clears a receivable or a payable (151x, 244x) at all:
 *     its other side is an invoice's, and learned it proposes a clearing with
 *     no invoice behind it;
 *   - a verifikat an invoice or supplier invoice points at, or a row that
 *     settles one: in kontantmetoden that verifikat books the cost or the
 *     revenue itself, and learned it would book next month's row directly
 *     while next month's invoice is registered too (double cost);
 *   - a samlingsverifikat: a verifikat other rows hold too, or a row anchored
 *     to more than this verifikat (a split, a residual booking);
 *   - a verifikat not posted, or not one a person or an import made (manual,
 *     import): salary runs, invoice flows and the rest have their own door;
 *   - a verifikat whose bank side is not this row: several money ledgers, or
 *     a bank net other than the row's amount.
 *   - a verifikat with fiktiv moms its replay would book on other accounts
 *     (import VAT, domestic or 12 % reverse charge without a basis pair: #997).
 *
 * Learning never fails a link: every read or write error is logged and the
 * link stands. Existing links are not replayed (no backfill).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  calculateConfidence,
  findTemplateByKey,
  insertOrUpdateTemplate,
  isRoutineVoucherText,
  learnedMoms,
  learnsOtherMoms,
  namesCounterparty,
  normalizeCounterpartyName,
  samePairButBankLedger,
  templateAccountSet,
  verifikatTemplateShape,
  type TemplateUpsertParams,
  type VerifikatTemplateShape,
} from '@/lib/bookkeeping/counterparty-templates'
import { clearsAnInvoice } from '@/lib/bookkeeping/invoice-clearing'
import { BANK_LEG_PLACEHOLDER, isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { ledgerLineAmountIn } from '@/lib/bookkeeping/ledger-line-amount'
import { isSkatteverketPayment } from '@/lib/bookkeeping/skatteverket-payment'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import { addMonthsIso } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { readBankLegHolders } from '@/lib/transactions/voucher-bank-leg'
import { chunk } from '@/lib/utils'
import type { CategorizationTemplateSource, TemplateVatTreatment } from '@/types'

const log = createLogger('transactions/link-learning')

/** Who chose the pair: a person or an agent (explicit), or the matcher (automatic). */
export type LinkTeaching = 'explicit' | 'automatic'

export interface BankLinkToLearn {
  transactionId: string
  journalEntryId: string
}

export type LinkLearningSkip =
  | 'transaction_not_found'
  | 'no_counterparty'
  | 'invoice_settlement'
  | 'several_verifikat'
  | 'samlingsverifikat'
  | 'entry_not_learnable'
  | 'clearing_account'
  | 'bank_leg_mismatch'
  | 'no_pattern'

export type LinkLearningResult =
  | { outcome: 'learned' | 'reapproved' | 'awaiting_repetition' | 'conflicts_template' | 'write_failed' | 'failed' }
  | { outcome: 'skipped'; reason: LinkLearningSkip }

/** Verifikat a person or an import made: the ones a link may learn from. */
const LEARNABLE_SOURCES = new Set(['manual', 'import'])

/** A ledger money moves on: 19xx, or a company card's ledger. */
function isMoneyAccount(account: string): boolean {
  return isCashLedger(account) || isCardLedgerAccount(account)
}

/**
 * How many months back an earlier link still counts as the repetition, the
 * window the SIE learner reads history in.
 */
const REPETITION_MONTHS = 24

/**
 * The earlier links read for the repetition: the most recent ones, one page.
 * A sample by design: a monthly payment's previous link is among a company's
 * last thousand links unless it links more than that in a month.
 */
const REPETITION_SAMPLE = 1000

const TX_COLUMNS =
  'id, date, amount, currency, merchant_name, original_description, description, counterparty_account, journal_entry_id, reconciliation_method, invoice_id, supplier_invoice_id, transaction_voucher_links(journal_entry_id, role)'

interface LinkTxRow {
  id: string
  date: string
  amount: number | string
  currency: string | null
  merchant_name: string | null
  original_description: string | null
  description: string | null
  counterparty_account?: string | null
  journal_entry_id: string | null
  reconciliation_method?: string | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
}

interface EntryRow {
  id: string
  status: string
  source_type: string | null
}

interface LineRow {
  journal_entry_id: string
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  currency?: string | null
  amount_in_currency?: number | string | null
  dimensions?: Record<string, string> | null
}

/** A link that would teach: its key, its bank text and the shape its verifikat teaches. */
interface LearnableLink {
  transactionId: string
  journalEntryId: string
  date: string
  rawName: string
  key: string
  shape: VerifikatTemplateShape
}

type Assessment = { ok: true; link: LearnableLink } | { ok: false; reason: LinkLearningSkip }

/**
 * Learn from bank rows just linked onto existing verifikat. Never throws:
 * a failure is logged and every link not yet answered reads 'failed'. The
 * result is keyed by transaction id.
 */
export async function learnFromBankLinks(
  supabase: SupabaseClient,
  companyId: string,
  links: BankLinkToLearn[],
  teaching: LinkTeaching,
): Promise<Map<string, LinkLearningResult>> {
  const results = new Map<string, LinkLearningResult>()
  if (links.length === 0) return results
  try {
    await learn(supabase, companyId, links, teaching, results)
  } catch (err) {
    log.error('learning from bank links failed; the links stand', {
      companyId,
      teaching,
      links: links.length,
      error: err instanceof Error ? err.message : String(err),
    })
    for (const link of links) {
      if (!results.has(link.transactionId)) results.set(link.transactionId, { outcome: 'failed' })
    }
  }
  return results
}

/** learnFromBankLinks for one link. */
export async function learnFromBankLink(
  supabase: SupabaseClient,
  companyId: string,
  link: BankLinkToLearn,
  teaching: LinkTeaching,
): Promise<LinkLearningResult> {
  const results = await learnFromBankLinks(supabase, companyId, [link], teaching)
  return results.get(link.transactionId) ?? { outcome: 'failed' }
}

async function learn(
  supabase: SupabaseClient,
  companyId: string,
  links: BankLinkToLearn[],
  teaching: LinkTeaching,
  results: Map<string, LinkLearningResult>,
): Promise<void> {
  const txRows = await readTransactions(supabase, companyId, links.map((l) => l.transactionId))
  const assessed = await assessLinks(supabase, companyId, links, txRows)

  const learnable: LearnableLink[] = []
  for (const link of links) {
    const assessment = assessed.get(link.transactionId)
    if (!assessment) continue
    if (assessment.ok) learnable.push(assessment.link)
    else results.set(link.transactionId, { outcome: 'skipped', reason: assessment.reason })
  }
  // Oldest first, so a later row of the same run finds the template an
  // earlier one taught, and an earlier link is the repetition of a later one.
  learnable.sort(compareLinks)

  const earlier = teaching === 'automatic' && learnable.length > 0
    ? await readEarlierLinks(supabase, companyId, learnable)
    : new Map<string, LearnableLink[]>()

  for (const link of learnable) {
    results.set(link.transactionId, await teach(supabase, companyId, link, teaching, earlier))
  }

  const counts: Record<string, number> = {}
  for (const result of results.values()) {
    const label = result.outcome === 'skipped' ? `skipped:${result.reason}` : result.outcome
    counts[label] = (counts[label] ?? 0) + 1
  }
  log.info('learned from bank links', { companyId, teaching, links: links.length, ...counts })
}

async function teach(
  supabase: SupabaseClient,
  companyId: string,
  link: LearnableLink,
  teaching: LinkTeaching,
  earlier: Map<string, LearnableLink[]>,
): Promise<LinkLearningResult> {
  if (teaching === 'explicit') {
    // As a categorize booking: one occurrence, a correction when the stored
    // template books otherwise (insertOrUpdateTemplate decides).
    const written = await insertOrUpdateTemplate(supabase, companyId, upsertParams(link, 1, 'user_approved'))
    return { outcome: written ? 'learned' : 'write_failed' }
  }

  const existing = await findTemplateByKey(supabase, companyId, link.key)
  if (existing) {
    // A template already holding this shape is the earlier occurrence; one
    // holding another is the person's or an earlier booking's, and the
    // matcher never overrides it.
    // The same pair and the same moms too, the verifikat's whole moms read
    // off its own lines (learnedMoms), so a verifikat with moms never counts
    // for a template without. insertOrUpdateTemplate then counts
    // it and never reads it as a correction.
    // The stored pattern stays: the matcher's link only counts.
    const counted = { ...upsertParams(link, 1, 'auto_learned'), linePattern: undefined }
    if (
      templateAccountSet(existing) !== link.shape.accountSet ||
      !samePairButBankLedger(existing, link.shape.debitAccount, link.shape.creditAccount) ||
      learnsOtherMoms(existing, upsertParams(link, 1, 'auto_learned'))
    ) {
      return { outcome: 'conflicts_template' }
    }
    const written = await insertOrUpdateTemplate(supabase, companyId, { ...counted, momsAsTemplate: true }, existing)
    return { outcome: written ? 'reapproved' : 'write_failed' }
  }

  const repeated = (earlier.get(link.key) ?? []).some(
    (before) =>
      before.transactionId !== link.transactionId &&
      before.journalEntryId !== link.journalEntryId &&
      before.shape.accountSet === link.shape.accountSet &&
      shapeMoms(before.shape) === shapeMoms(link.shape) &&
      compareLinks(before, link) < 0,
  )
  if (!repeated) return { outcome: 'awaiting_repetition' }
  // Both links are the evidence.
  const written = await insertOrUpdateTemplate(supabase, companyId, upsertParams(link, 2, 'auto_learned'), null)
  return { outcome: written ? 'learned' : 'write_failed' }
}

function upsertParams(link: LearnableLink, occurrenceCount: number, source: CategorizationTemplateSource): TemplateUpsertParams {
  const { debitAccount, creditAccount, vatTreatment, vatAccount, linePattern } = link.shape
  return {
    counterpartyName: link.key,
    aliases: [link.rawName.toLowerCase()],
    debitAccount,
    creditAccount,
    vatTreatment,
    vatAccount,
    linePattern,
    category: null,
    occurrenceCount,
    confidence: calculateConfidence(occurrenceCount),
    lastSeenDate: link.date,
    source,
  }
}

/** The moms a shape teaches (learnedMoms): two links with other moms are not a repetition. */
function shapeMoms(shape: VerifikatTemplateShape): string {
  return learnedMoms({ vat_treatment: shape.vatTreatment as TemplateVatTreatment | null, line_pattern: shape.linePattern })
}

function compareLinks(a: Pick<LearnableLink, 'date' | 'transactionId'>, b: Pick<LearnableLink, 'date' | 'transactionId'>): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.transactionId === b.transactionId) return 0
  return a.transactionId < b.transactionId ? -1 : 1
}

/** The bank text a template is keyed on: the immutable bank original first, as upsertCounterpartyTemplate reads it. */
function bankText(tx: LinkTxRow): string | null {
  return tx.merchant_name || tx.original_description || tx.description || null
}

async function readTransactions(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Map<string, LinkTxRow>> {
  const rows = new Map<string, LinkTxRow>()
  for (const part of chunk([...new Set(ids)], ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('transactions')
      .select(TX_COLUMNS)
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw new Error(`transactions read failed: ${error.message}`)
    for (const row of (data ?? []) as unknown as LinkTxRow[]) rows.set(row.id, row)
  }
  return rows
}

/**
 * Every rule above for each link, on reads only: the verifikat, its lines,
 * the rows holding it and the invoices pointing at it, read once per chunk.
 */
async function assessLinks(
  supabase: SupabaseClient,
  companyId: string,
  links: BankLinkToLearn[],
  txRows: Map<string, LinkTxRow>,
): Promise<Map<string, Assessment>> {
  const out = new Map<string, Assessment>()
  const pending: Array<{ link: BankLinkToLearn; tx: LinkTxRow; rawName: string; key: string }> = []

  // Row-only rules first: most rows that teach nothing stop before a read.
  for (const link of links) {
    const tx = txRows.get(link.transactionId)
    if (!tx) {
      out.set(link.transactionId, { ok: false, reason: 'transaction_not_found' })
      continue
    }
    const rawName = bankText(tx)
    const key = rawName && namesCounterparty(rawName) ? normalizeCounterpartyName(rawName) : ''
    if (
      !rawName ||
      key.length < 2 ||
      isRoutineVoucherText(key) ||
      isSkatteverketPayment({
        amount: Number(tx.amount),
        merchant_name: tx.merchant_name,
        original_description: tx.original_description,
        description: tx.description ?? '',
        counterparty_account: tx.counterparty_account ?? null,
      })
    ) {
      out.set(link.transactionId, { ok: false, reason: 'no_counterparty' })
      continue
    }
    if (tx.invoice_id || tx.supplier_invoice_id) {
      out.set(link.transactionId, { ok: false, reason: 'invoice_settlement' })
      continue
    }
    const anchors = new Set<string>()
    if (tx.journal_entry_id) anchors.add(tx.journal_entry_id)
    for (const row of tx.transaction_voucher_links ?? []) anchors.add(row.journal_entry_id)
    if (anchors.size !== 1 || !anchors.has(link.journalEntryId)) {
      out.set(link.transactionId, { ok: false, reason: 'several_verifikat' })
      continue
    }
    pending.push({ link, tx, rawName, key })
  }
  if (pending.length === 0) return out

  const entryIds = [...new Set(pending.map((p) => p.link.journalEntryId))]
  const [entries, lines, invoiceVerifikat, holders] = await Promise.all([
    readEntries(supabase, companyId, entryIds),
    readLines(supabase, entryIds),
    readInvoiceVerifikat(supabase, companyId, entryIds),
    readBankLegHolders(supabase, companyId, entryIds),
  ])
  if (!holders.ok) throw new Error('bank leg holders read failed')

  for (const { link, tx, rawName, key } of pending) {
    const jeId = link.journalEntryId
    if (invoiceVerifikat.has(jeId)) {
      out.set(link.transactionId, { ok: false, reason: 'invoice_settlement' })
      continue
    }
    if ((holders.holders.get(jeId) ?? []).some((holder) => holder.transactionId !== tx.id)) {
      out.set(link.transactionId, { ok: false, reason: 'samlingsverifikat' })
      continue
    }
    const entry = entries.get(jeId)
    if (!entry || entry.status !== 'posted' || !LEARNABLE_SOURCES.has(entry.source_type ?? '')) {
      out.set(link.transactionId, { ok: false, reason: 'entry_not_learnable' })
      continue
    }
    const verdict = shapeOfLink(tx, lines.get(jeId) ?? [])
    if (!verdict.ok) {
      out.set(link.transactionId, verdict)
      continue
    }
    out.set(link.transactionId, {
      ok: true,
      link: { transactionId: tx.id, journalEntryId: jeId, date: tx.date, rawName, key, shape: verdict.shape },
    })
  }
  return out
}

/** The verifikat's lines as the shape this row teaches, or why they teach nothing. */
function shapeOfLink(
  tx: LinkTxRow,
  lines: LineRow[],
): { ok: true; shape: VerifikatTemplateShape } | { ok: false; reason: LinkLearningSkip } {
  if (clearsAnInvoice(lines.map((line) => line.account_number))) return { ok: false, reason: 'clearing_account' }

  const money = lines.filter((line) => isMoneyAccount(line.account_number))
  if (new Set(money.map((line) => line.account_number)).size !== 1) return { ok: false, reason: 'bank_leg_mismatch' }
  const currency = tx.currency || 'SEK'
  let bankNet = 0
  for (const line of money) {
    const amount = ledgerLineAmountIn(line, currency)
    if (amount === null) return { ok: false, reason: 'bank_leg_mismatch' }
    bankNet += amount
  }
  if (Math.abs(roundOre(bankNet) - Number(tx.amount)) > 0.005) return { ok: false, reason: 'bank_leg_mismatch' }

  const shape = verifikatTemplateShape(
    lines.map((line) => ({
      // A card row learns the bank placeholder on its bank leg, as a
      // categorize booking does (learnableBankPair).
      account: isCardLedgerAccount(line.account_number) ? BANK_LEG_PLACEHOLDER : line.account_number,
      amount: roundOre((Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)),
      ...(line.dimensions && Object.keys(line.dimensions).length > 0 ? { dimensions: line.dimensions } : {}),
    })),
  )
  return shape ? { ok: true, shape } : { ok: false, reason: 'no_pattern' }
}

async function readEntries(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Map<string, EntryRow>> {
  const rows = new Map<string, EntryRow>()
  for (const part of chunk(ids, ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, source_type')
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw new Error(`journal entries read failed: ${error.message}`)
    for (const row of (data ?? []) as EntryRow[]) rows.set(row.id, row)
  }
  return rows
}

async function readLines(supabase: SupabaseClient, entryIds: string[]): Promise<Map<string, LineRow[]>> {
  const byEntry = new Map<string, LineRow[]>()
  for (const part of chunk(entryIds, ID_READ_CHUNK)) {
    const rows = await fetchAllRows<LineRow>(({ from, to }) =>
      supabase
        .from('journal_entry_lines')
        .select('journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency, dimensions')
        .in('journal_entry_id', part)
        .order('id')
        .range(from, to),
    )
    for (const row of rows) {
      const list = byEntry.get(row.journal_entry_id) ?? []
      list.push(row)
      byEntry.set(row.journal_entry_id, list)
    }
  }
  return byEntry
}

/**
 * The verifikat an invoice or supplier invoice points at: its booking, its
 * registration, its payment, or a payment row.
 */
async function readInvoiceVerifikat(supabase: SupabaseClient, companyId: string, entryIds: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  const reads: Array<{ table: string; column: string; scoped: boolean }> = [
    { table: 'invoices', column: 'journal_entry_id', scoped: true },
    { table: 'invoice_payments', column: 'journal_entry_id', scoped: false },
    { table: 'supplier_invoices', column: 'registration_journal_entry_id', scoped: true },
    { table: 'supplier_invoices', column: 'payment_journal_entry_id', scoped: true },
    { table: 'supplier_invoice_payments', column: 'journal_entry_id', scoped: false },
  ]
  for (const part of chunk(entryIds, ID_READ_CHUNK)) {
    const answers = await Promise.all(
      reads.map(({ table, column, scoped }) => {
        const query = supabase.from(table).select(column).in(column, part)
        return scoped ? query.eq('company_id', companyId) : query
      }),
    )
    answers.forEach(({ data, error }, i) => {
      if (error) throw new Error(`${reads[i].table} read failed: ${error.message}`)
      for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        const id = row[reads[i].column]
        if (typeof id === 'string') found.add(id)
      }
    })
  }
  return found
}

/**
 * Earlier links of the batch's bank texts that would have taught a shape
 * themselves, by key. The most recent links within REPETITION_MONTHS of the
 * earliest row, one page; the batch's own rows are among them (they are
 * linked already) and count for each other in date order.
 */
async function readEarlierLinks(
  supabase: SupabaseClient,
  companyId: string,
  learnable: LearnableLink[],
): Promise<Map<string, LearnableLink[]>> {
  const keys = new Set(learnable.map((l) => l.key))
  const dates = learnable.map((l) => l.date).sort()
  const { data, error } = await supabase
    .from('transactions')
    .select(TX_COLUMNS)
    .eq('company_id', companyId)
    .not('journal_entry_id', 'is', null)
    .not('reconciliation_method', 'is', null)
    .gte('date', addMonthsIso(dates[0], -REPETITION_MONTHS))
    .lte('date', dates[dates.length - 1])
    .order('date', { ascending: false })
    .limit(REPETITION_SAMPLE)
  if (error) throw new Error(`earlier links read failed: ${error.message}`)

  const candidates = new Map<string, LinkTxRow>()
  for (const row of (data ?? []) as unknown as LinkTxRow[]) {
    if (!row.journal_entry_id || !row.reconciliation_method) continue
    const rawName = bankText(row)
    if (!rawName || !keys.has(normalizeCounterpartyName(rawName))) continue
    candidates.set(row.id, row)
  }
  const out = new Map<string, LearnableLink[]>()
  if (candidates.size === 0) return out

  const assessed = await assessLinks(
    supabase,
    companyId,
    [...candidates.values()].map((row) => ({ transactionId: row.id, journalEntryId: row.journal_entry_id! })),
    candidates,
  )
  for (const assessment of assessed.values()) {
    if (!assessment.ok) continue
    const list = out.get(assessment.link.key) ?? []
    list.push(assessment.link)
    out.set(assessment.link.key, list)
  }
  return out
}
