import { createHash } from 'node:crypto'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { isLedgerCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { findFiscalPeriod, validateBalance } from '@/lib/bookkeeping/engine'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import { AccountsNotInChartError, FiscalPeriodNotFoundError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  WebshopOrder,
  WebshopPlatform,
  WebshopStoreSettings,
} from '@/types'
import { WEBSHOP_PREFILL_ACCOUNTS } from './booking-lines'
import { isCancelledWithoutRefund, whereWebshopOrderBooked } from './booking-status'
import { ensureWebshopPrefillAccounts } from './ensure-accounts'
import { readCompanyReleasedWebshopBookings, type ReleasedWebshopBooking } from './released-booking'
import { deriveUnattendedOrderLines } from './unattended-lines'

/**
 * Book a store's orders and refunds of one day and one payment method as ONE
 * verifikat (a gemensam verifikation, BFL 5 kap 6 §; BFNAR 2013:2 p. 6.1
 * counts similar affärshändelser on the same day), with a dagssammanställning
 * listing every order archived on it as underlag (day-underlag.tsx).
 *
 * The lines are the server's, never the caller's: each order's lines come
 * from deriveUnattendedOrderLines (the same derivation and refusals as the
 * bulk sweep), and the day's verifikat is their sum, one line per account and
 * side, so sales and refunds stay apart. An order that cannot be booked
 * unattended (unknown country, missing VAT split, residual) is left out and
 * reported; it stays in Att bokföra for the single-order dialog.
 *
 * The day is the order's paid date, else its order date, the same date a
 * single booking uses (both are Swedish calendar days, #58). Orders without a
 * payment method are not grouped; book them one by one.
 *
 * Race-free like the single booking (book-order.ts): draft -> conditional
 * claim of every order row -> commit. A row booked elsewhere between the read
 * and the claim makes the whole day lose (the summed lines include it), every
 * claimed row is released and the draft is cancelled before it gets a voucher
 * number. Each claimed row freezes like a single booking
 * (enforce_webshop_order_financial_freeze), and many rows may name the same
 * verifikat (the journal_entry_id index is not unique).
 *
 * An order a storno released (isWebshopBookingReleased) books with the day
 * when the day's verifikat lands in the series and fiscal year of the
 * reversed one (placeOrderBooking): the day takes the series of its first
 * released order, and one released elsewhere is left out for the
 * single-order dialog. Its claim moves its pointer from the reversed
 * verifikat, and a lost day gives that pointer back.
 */

/** Rows per day booking; prod's largest day and payment method held 20 (2026-10). */
export const MAX_DAY_ROWS = 500
/** Ids per claim update, so the filter stays well inside a request URL. */
const CLAIM_CHUNK = 100

export interface BookWebshopDayInput {
  platform: WebshopPlatform
  store_scope: string
  /** The Swedish calendar day: the orders' paid date, else their order date. */
  date: string
  /** The order's payment method as the store names it, e.g. shopify_payments or paypal. */
  payment_method: string
  /** The rows the approver saw; the booking is refused if any of them is gone or no longer books. */
  expected_order_ids?: string[]
  /** lines_sha256 of the verifikat the approver saw; the booking is refused if the lines differ. */
  expected_lines_sha256?: string
}

export interface DayOrderOut {
  webshop_order_id: string
  order_number: string
  row_type: 'order' | 'refund'
  total_sek: number
}

export interface SkippedOrderOut {
  webshop_order_id: string
  order_number: string
  row_type: 'order' | 'refund'
  code: string
  message_sv: string
  message_en: string
  details?: Record<string, unknown>
}

export interface BookWebshopDayResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  booked: DayOrderOut[]
  skipped: SkippedOrderOut[]
  underlag_document_id: string | null
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function typedFailure(err: unknown): Failure {
  return { ok: false, code: (err as { code: string }).code, error: err }
}

/**
 * The day's verifikat lines: every order's lines summed per account and side,
 * debits first, each side in account order. Sales and refunds on the same
 * account stay two lines, so the verifikat shows both and never nets to an
 * empty line. Balanced whenever every order's lines are.
 */
export function sumDayLines(
  perOrder: CreateJournalEntryLineInput[][],
  description: string,
): CreateJournalEntryLineInput[] {
  const sums = new Map<string, { debit: number; credit: number }>()
  for (const lines of perOrder) {
    for (const line of lines) {
      const sum = sums.get(line.account_number) ?? { debit: 0, credit: 0 }
      sum.debit = roundOre(sum.debit + (line.debit_amount || 0))
      sum.credit = roundOre(sum.credit + (line.credit_amount || 0))
      sums.set(line.account_number, sum)
    }
  }
  const accounts = [...sums.keys()].sort()
  const out: CreateJournalEntryLineInput[] = []
  for (const account of accounts) {
    const { debit } = sums.get(account)!
    if (debit > 0) out.push({ account_number: account, debit_amount: debit, credit_amount: 0, line_description: description })
  }
  for (const account of accounts) {
    const { credit } = sums.get(account)!
    if (credit > 0) out.push({ account_number: account, debit_amount: 0, credit_amount: credit, line_description: description })
  }
  return out
}

/**
 * A fingerprint of the day's verifikat lines. A staged booking pins it, so
 * an order the store changed after the review (an amount, a VAT split, the
 * country its rules book on) refuses the approval instead of posting figures
 * nobody saw.
 */
export function dayLinesSha256(lines: CreateJournalEntryLineInput[]): string {
  const canonical = lines.map((l) => [l.account_number, l.debit_amount || 0, l.credit_amount || 0])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/**
 * Everything an order's lines are derived from (the columns the claim
 * verification reads back). Compared after the claim
 * (which freezes the row's financial fields), so a sync that changed a row
 * between its derivation and its claim loses the day instead of posting
 * stale lines against a row that now says something else.
 */
type DerivationRow = Pick<
  WebshopOrder,
  | 'id'
  | 'row_type'
  | 'currency'
  | 'total'
  | 'total_tax'
  | 'total_sek'
  | 'exchange_rate'
  | 'vat_breakdown'
  | 'paid_date'
  | 'order_date'
  | 'payment_method'
  | 'is_paid'
  | 'customer_country'
  | 'ships_nothing'
  | 'status'
  | 'refunded_total'
>

function derivationFingerprint(row: DerivationRow): string {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return JSON.stringify([
    row.row_type,
    row.currency,
    num(row.total),
    num(row.total_tax),
    num(row.total_sek),
    num(row.exchange_rate),
    (row.vat_breakdown ?? []).map((b) => [num(b.rate), num(b.net), num(b.tax)]),
    row.paid_date,
    row.order_date,
    row.payment_method,
    row.is_paid,
    row.customer_country,
    row.ships_nothing ?? false,
    // The store's cancel is a guard input, not a line input: only whether
    // it refuses the order counts, so a status that moves on does not.
    isCancelledWithoutRefund(row),
  ])
}

export function webshopDayDescription(date: string, storeLabel: string, paymentMethod: string): string {
  return `Dagsförsäljning ${date} ${storeLabel} (${paymentMethod})`
}

/**
 * The business event of a booked day (kind sale.webshop_order, the kind of
 * the source type), for the posting port: recorded while POSTING_EVENTS is
 * shadow or strict, never built while it is off. Pure. The order rows name
 * the verifikat through journal_entry_id; the verifikat has no single source
 * row.
 */
export function webshopDayBusinessEvent(
  date: string,
  grossSek: number,
  vatSek: number,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  return {
    kind: 'sale.webshop_order',
    category: 'income.sales',
    occurredOn: date,
    currency: 'SEK',
    amount: Math.abs(grossSek),
    amountSek: Math.abs(grossSek),
    taxAmounts: vatSek !== 0 ? [{ tax: 'vat', treatment: null, amount_sek: Math.abs(vatSek) }] : [],
    evidence: {
      direction: grossSek < 0 ? 'out' : 'in',
      link_basis: linkBasis.link_basis,
      link_evidence: linkBasis.link_evidence ?? undefined,
    },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('webshopOrder'),
    jurisdiction: 'SE',
  }
}

/**
 * The unbooked, paid rows of the day and payment method, oldest first:
 * unbooked as the lists read it (whereWebshopOrderBooked), so a row a storno
 * released is among them.
 */
async function loadDayRows(
  ctx: OperationContext,
  input: BookWebshopDayInput,
  releasedEntryIds: readonly string[],
): Promise<WebshopOrder[] | null> {
  // Two reads instead of one OR: a row belongs to its paid date, and to its
  // order date only when it has none.
  const base = () =>
    whereWebshopOrderBooked(
      ctx.supabase
        .from('webshop_orders')
        .select('*')
        .eq('company_id', ctx.companyId)
        .eq('platform', input.platform)
        .eq('store_scope', input.store_scope)
        .eq('payment_method', input.payment_method)
        .eq('is_paid', true)
        .is('invoice_id', null),
      'unbooked',
      releasedEntryIds,
    )
  const [byPaid, byOrder] = await Promise.all([
    base().eq('paid_date', input.date).limit(MAX_DAY_ROWS + 1),
    base().is('paid_date', null).eq('order_date', input.date).limit(MAX_DAY_ROWS + 1),
  ])
  if (byPaid.error || byOrder.error) {
    ctx.log.error('failed to read the webshop day', (byPaid.error ?? byOrder.error) as Error)
    return null
  }
  let rows: WebshopOrder[] = [...((byPaid.data ?? []) as WebshopOrder[]), ...((byOrder.data ?? []) as WebshopOrder[])]
  // The pinned rows are filtered here, not in the query: up to 500 ids would
  // not fit a request URL.
  if (input.expected_order_ids) {
    const expected = new Set(input.expected_order_ids)
    rows = rows.filter((row) => expected.has(row.id))
  }
  return rows.sort(
    (a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.order_number.localeCompare(b.order_number),
  )
}

function skippedOut(order: WebshopOrder, code: string, details?: Record<string, unknown>): SkippedOrderOut {
  const entry = getErrorEntry(code)
  return {
    webshop_order_id: order.id,
    order_number: order.order_number,
    row_type: order.row_type,
    code,
    message_sv: entry?.message_sv ?? code,
    message_en: entry?.message_en ?? code,
    ...(details ? { details } : {}),
  }
}

/** The order's gross in SEK as its payment line books it (FX already resolved). */
function orderGrossSek(order: WebshopOrder): number {
  return isLedgerCurrency(order.currency.toUpperCase()) ? roundOre(order.total) : roundOre(order.total_sek ?? 0)
}

/** The order's VAT in SEK at its rate; only the business event's tax amount reads it. */
function orderVatSek(order: WebshopOrder): number {
  return isLedgerCurrency(order.currency.toUpperCase())
    ? roundOre(order.total_tax)
    : sekOfForeign(order.total_tax, order.exchange_rate ?? 0)
}

async function archiveDaySummary(
  ctx: OperationContext,
  args: {
    input: BookWebshopDayInput
    storeLabel: string
    orders: WebshopOrder[]
    lines: CreateJournalEntryLineInput[]
    entry: JournalEntry | null
    entryId: string
  },
): Promise<string | null> {
  try {
    const { buildDayUnderlagModel, renderWebshopDayUnderlagPdf } = await import('./day-underlag')
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('company_name, org_number')
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    const model = buildDayUnderlagModel({
      platform: args.input.platform,
      storeLabel: args.storeLabel,
      date: args.input.date,
      paymentMethod: args.input.payment_method,
      orders: args.orders,
      lines: args.lines,
      voucherLabel: args.entry?.voucher_series && args.entry.voucher_number ? formatVoucher(args.entry) : null,
    })
    const { bytes, filename } = await renderWebshopDayUnderlagPdf({
      model,
      company: (settings ?? {}) as { company_name?: string | null; org_number?: string | null },
      generatedAt: todayIsoStockholm(),
    })
    const document = await uploadDocument(
      ctx.supabase,
      ctx.userId,
      ctx.companyId,
      { name: filename, buffer: bytes.buffer, type: 'application/pdf' },
      // The day's own summary on the day's own verifikat.
      { upload_source: 'system', journal_entry_id: args.entryId, linkBasis: linkBasisColumns('system_derived'), extractionOwner: 'none' },
    )
    return document.id
  } catch (err) {
    ctx.log.error('failed to archive the webshop day summary', err as Error, { journalEntryId: args.entryId })
    return null
  }
}

export async function bookWebshopDay(
  ctx: OperationContext,
  input: BookWebshopDayInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookWebshopDayResult>> {
  const { supabase, companyId, userId, log } = ctx
  const dryRun = options.dryRun === true

  let released: Map<string, ReleasedWebshopBooking>
  try {
    released = await readCompanyReleasedWebshopBookings(supabase, companyId)
  } catch (err) {
    log.error('failed to read the released webshop bookings', err as Error)
    return { ok: false, code: 'WEBSHOP_ORDER_READ_FAILED' }
  }
  const rows = await loadDayRows(ctx, input, Array.from(released.keys()))
  if (!rows) return { ok: false, code: 'WEBSHOP_ORDER_READ_FAILED' }
  if (rows.length > MAX_DAY_ROWS) {
    return { ok: false, code: 'WEBSHOP_DAY_TOO_MANY_ROWS', details: { max: MAX_DAY_ROWS } }
  }
  if (rows.length === 0) {
    return {
      ok: false,
      code: input.expected_order_ids ? 'WEBSHOP_DAY_CHANGED' : 'WEBSHOP_DAY_EMPTY',
      details: { date: input.date, payment_method: input.payment_method },
    }
  }

  // A failed read aborts: falling back to no settings would book every order
  // on 1686 and the Swedish accounts against the store's own choices.
  const { data: settingsData, error: settingsError } = await supabase
    .from('webshop_store_settings')
    .select('*')
    .eq('company_id', companyId)
    .eq('platform', input.platform)
    .eq('store_scope', input.store_scope)
    .maybeSingle()
  if (settingsError) {
    log.error('webshop day settings read failed', settingsError)
    return { ok: false, code: 'WEBSHOP_ORDER_READ_FAILED' }
  }
  const settings = (settingsData as WebshopStoreSettings | null) ?? null

  // Read here for the released rows' placement; a day without a period is
  // refused below, after its rows are known.
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, input.date)

  const included: Array<{ order: WebshopOrder; lines: CreateJournalEntryLineInput[] }> = []
  const skipped: SkippedOrderOut[] = []
  // The series of the day's first released row, which the day is booked in.
  let releasedSeries: string | undefined
  for (const order of rows) {
    // A released row books again in its reversed verifikat's series and
    // fiscal year (placeOrderBooking); one released elsewhere waits for the
    // single-order dialog.
    const from = order.journal_entry_id ? released.get(order.journal_entry_id) : undefined
    if (from && fiscalPeriodId) {
      const series = releasedSeries ?? from.voucher_series
      if (from.fiscal_period_id !== fiscalPeriodId || from.voucher_series !== series) {
        skipped.push(
          skippedOut(order, 'WEBSHOP_ORDER_REBOOK_OTHER_SERIES_OR_YEAR', {
            journal_entry_id: from.id,
            voucher_series: from.voucher_series,
            fiscal_period_id: from.fiscal_period_id,
          }),
        )
        continue
      }
    }
    const derived = await deriveUnattendedOrderLines({
      supabase,
      companyId,
      order,
      settings,
      log,
      persistFx: !dryRun,
    })
    if (!derived.ok) {
      skipped.push(skippedOut(order, derived.code ?? 'WEBSHOP_ORDER_BOOKING_FAILED'))
      continue
    }
    if (from) releasedSeries ??= from.voucher_series
    included.push({ order: derived.order, lines: derived.lines })
  }

  // The approver saw these rows and no others: every one must still book.
  if (input.expected_order_ids) {
    const includedIds = new Set(included.map((i) => i.order.id))
    const missing = input.expected_order_ids.filter((id) => !includedIds.has(id))
    if (missing.length > 0) return { ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { webshop_order_ids: missing } }
  }
  if (included.length === 0) {
    return { ok: false, code: 'WEBSHOP_DAY_NOTHING_BOOKABLE', details: { skipped } }
  }

  const storeLabel = included[0].order.store_label || input.store_scope
  const description = webshopDayDescription(input.date, storeLabel, input.payment_method)
  const lines = sumDayLines(included.map((i) => i.lines), description)
  const balance = validateBalance(lines)
  if (!balance.valid || lines.length === 0) {
    log.error('webshop day lines do not balance', undefined, { totalDebit: balance.totalDebit, totalCredit: balance.totalCredit })
    return { ok: false, code: 'WEBSHOP_DAY_BOOKING_FAILED' }
  }
  const linesSha256 = dayLinesSha256(lines)
  if (input.expected_lines_sha256 && input.expected_lines_sha256 !== linesSha256) {
    return { ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { lines_sha256: linesSha256 } }
  }

  if (!fiscalPeriodId) return typedFailure(new FiscalPeriodNotFoundError())
  const lock = await checkPeriodLock(supabase, companyId, input.date)
  if (lock.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: lock.reason, fiscal_period_id: lock.fiscal_period_id, entry_date: input.date },
    }
  }

  // Our own prefill accounts are added to the chart at commit
  // (ensureWebshopPrefillAccounts), so the dry run does not refuse them.
  const unresolvable = (
    await findUnresolvableAccounts(supabase, companyId, lines.map((l) => l.account_number))
  ).filter((n) => !WEBSHOP_PREFILL_ACCOUNTS.includes(n))
  if (unresolvable.length > 0) return typedFailure(new AccountsNotInChartError(unresolvable))

  const refundCount = included.filter((i) => i.order.row_type === 'refund').length
  const entryInput: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: input.date,
    description,
    source_type: 'webshop_order',
    // A released row's series; otherwise the default for webshop orders.
    ...(releasedSeries ? { voucher_series: releasedSeries } : {}),
    notes: `${included.length - refundCount} ordrar och ${refundCount} återbetalningar. Underlag: dagssammanställning med varje order.`,
    lines,
  }
  const booked: DayOrderOut[] = included.map(({ order }) => ({
    webshop_order_id: order.id,
    order_number: order.order_number,
    row_type: order.row_type,
    total_sek: orderGrossSek(order),
  }))
  const skippedWarning: OperationWarning[] =
    skipped.length > 0
      ? [
          {
            code: 'WEBSHOP_DAY_ORDERS_SKIPPED',
            message_sv: `${skipped.length} ordrar ingår inte och ligger kvar under Att bokföra. Bokför dem en och en.`,
            message_en: `${skipped.length} orders are not included and stay in To book. Book them one by one.`,
          },
        ]
      : []

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        platform: input.platform,
        store_scope: input.store_scope,
        store_label: storeLabel,
        date: input.date,
        payment_method: input.payment_method,
        order_ids: included.map((i) => i.order.id),
        lines_sha256: linesSha256,
        booked,
        skipped,
        journal_entry: toEntryPreview(entryInput),
        warnings: skippedWarning.map((w) => w.code),
        will: 'post one verifikat (source_type webshop_order) for these orders, link every order to it, and archive the dagssammanställning on it',
      },
    }
  }

  await ensureWebshopPrefillAccounts(supabase, companyId, userId, lines.map((l) => l.account_number), log)

  let grossSek = 0
  let vatSek = 0
  for (const { order } of included) {
    grossSek = roundOre(grossSek + orderGrossSek(order))
    vatSek = roundOre(vatSek + orderVatSek(order))
  }

  let draft: JournalEntry
  try {
    draft = await postingPort.draftJournalEntry({
      supabase,
      companyId,
      userId,
      // Built only while the port is on: off, the call is the one it was.
      event: () => webshopDayBusinessEvent(input.date, grossSek, vatSek, linkBasisColumns('user_created')),
      input: entryInput,
    })
  } catch (err) {
    if (isBookkeepingError(err)) return typedFailure(err)
    log.error('webshop day draft failed', err as Error)
    return { ok: false, code: 'WEBSHOP_DAY_BOOKING_FAILED' }
  }

  const cancelDraft = async () => {
    const { error } = await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', draft.id).eq('status', 'draft')
    if (error) log.error('webshop day draft cleanup failed', error, { entryId: draft.id })
  }
  // A row never booked is claimed from no verifikat, a released row from the
  // reversed verifikat it names.
  const claimGroups = new Map<string | null, string[]>()
  for (const { order } of included) {
    const from = order.journal_entry_id ?? null
    claimGroups.set(from, [...(claimGroups.get(from) ?? []), order.id])
  }
  // Release every row this booking claimed: a released row gets its reversed
  // verifikat back, never nothing, the rest no verifikat. journal_entry_id is
  // not in the freeze trigger's protected list, and the draft is not posted,
  // so the unlink passes.
  const releaseClaims = async () => {
    for (const [from, groupIds] of claimGroups) {
      for (let i = 0; i < groupIds.length; i += CLAIM_CHUNK) {
        const { error } = await supabase
          .from('webshop_orders')
          .update({ journal_entry_id: from })
          .in('id', groupIds.slice(i, i + CLAIM_CHUNK))
          .eq('company_id', companyId)
          .eq('journal_entry_id', draft.id)
        if (error) log.error('webshop day claim release failed', error, { entryId: draft.id })
      }
    }
  }

  // The claim guards both links plus the manual mark, like the single
  // booking: a concurrent booking, invoice or mark on any row loses the day.
  const ids = included.map((i) => i.order.id)
  let claimedCount = 0
  for (const [from, groupIds] of claimGroups) {
    for (let i = 0; i < groupIds.length; i += CLAIM_CHUNK) {
      const claim = supabase
        .from('webshop_orders')
        .update({ journal_entry_id: draft.id })
        .in('id', groupIds.slice(i, i + CLAIM_CHUNK))
        .eq('company_id', companyId)
      const { data: claimed, error: claimError } = await (from
        ? claim.eq('journal_entry_id', from)
        : claim.is('journal_entry_id', null)
      )
        .is('invoice_id', null)
        .is('manually_booked_at', null)
        .select('id')
      if (claimError) {
        log.error('webshop day claim failed', claimError, { entryId: draft.id })
        await releaseClaims()
        await cancelDraft()
        return { ok: false, code: 'WEBSHOP_DAY_BOOKING_FAILED' }
      }
      claimedCount += claimed?.length ?? 0
    }
  }
  if (claimedCount !== ids.length) {
    await releaseClaims()
    await cancelDraft()
    return { ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { claimed: claimedCount, expected: ids.length } }
  }

  // Claimed rows are frozen now; check they still say what their lines were
  // derived from. A sync between the read and the claim loses the day.
  const derivedFrom = new Map(included.map(({ order }) => [order.id, derivationFingerprint(order)]))
  const { data: claimedRows, error: verifyError } = await supabase
    .from('webshop_orders')
    .select('id, row_type, currency, total, total_tax, total_sek, exchange_rate, vat_breakdown, paid_date, order_date, payment_method, is_paid, customer_country, ships_nothing, status, refunded_total')
    .eq('company_id', companyId)
    .eq('journal_entry_id', draft.id)
  const changed = ((claimedRows ?? []) as unknown as DerivationRow[])
    .filter((row) => derivedFrom.get(row.id) !== derivationFingerprint(row))
    .map((row) => row.id)
  if (verifyError || (claimedRows ?? []).length !== ids.length || changed.length > 0) {
    if (verifyError) log.error('webshop day claim verification failed', verifyError, { entryId: draft.id })
    await releaseClaims()
    await cancelDraft()
    return verifyError
      ? { ok: false, code: 'WEBSHOP_DAY_BOOKING_FAILED' }
      : { ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { webshop_order_ids: changed } }
  }

  let committed: JournalEntry | null
  try {
    committed = await postingPort.commitJournalEntry({ supabase, companyId, userId, entryId: draft.id })
  } catch (err) {
    // A commit whose answer was lost may still have posted: a posted voucher
    // keeps its links (the freeze trigger refuses the unlink anyway).
    const { data: landed } = await supabase
      .from('journal_entries')
      .select('id, status, voucher_series, voucher_number')
      .eq('id', draft.id)
      .maybeSingle()
    if ((landed as { status?: string } | null)?.status === 'posted') {
      log.warn('webshop day commit answered an error but the voucher is posted', { entryId: draft.id })
      committed = landed as JournalEntry
    } else {
      await releaseClaims()
      await cancelDraft()
      if (isBookkeepingError(err)) return typedFailure(err)
      log.error('webshop day commit failed', err as Error, { entryId: draft.id })
      return { ok: false, code: 'WEBSHOP_DAY_BOOKING_FAILED' }
    }
  }

  const entryId = committed?.id ?? draft.id
  const underlagId = await archiveDaySummary(ctx, {
    input,
    storeLabel,
    orders: included.map((i) => i.order),
    lines,
    entry: committed,
    entryId,
  })

  const warnings: OperationWarning[] = [...skippedWarning]
  if (!underlagId) {
    warnings.push({
      code: 'WEBSHOP_DAY_UNDERLAG_NOT_ARCHIVED',
      message_sv: 'Verifikatet bokfördes men dagssammanställningen kunde inte arkiveras. Bifoga ett underlag från listan Saknar underlag.',
      message_en: 'The voucher was booked but the day summary could not be archived. Attach one from the missing-underlag list.',
    })
  }

  return {
    ok: true,
    created: true,
    data: {
      journal_entry_id: entryId,
      voucher_series: committed?.voucher_series ?? null,
      voucher_number: committed?.voucher_number ?? null,
      entry_date: input.date,
      booked,
      skipped,
      underlag_document_id: underlagId,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
