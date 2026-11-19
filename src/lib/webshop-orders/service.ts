/**
 * Webshop orders for the machine doors (v1 and MCP, lib/operations/
 * webshop-orders.ts): list the synced order rows, read one with the booking
 * the dialog would prefill, and book one with the caller's own lines.
 *
 * The booking itself is bookWebshopOrder() (./book-order.ts), the dashboard
 * dialog's own write path: same guards, same race-free claim, same
 * orderunderlag on the verifikat. What this file adds is what an agent has
 * no dialog for: the defaults the dialog fills in (entry date, period,
 * description) and a dry run that refuses exactly what the commit would,
 * without writing, so a staged booking previews the verifikat it posts.
 */
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { assertLinesWellFormed, findFiscalPeriod, validateBalance } from '@/lib/bookkeeping/engine'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import {
  AccountsNotInChartError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type {
  CreateJournalEntryLineInput,
  WebshopOrder,
  WebshopPlatform,
  WebshopStoreSettings,
} from '@/types'
import {
  assertOrderBookable,
  bookWebshopOrder,
  loadWebshopOrder,
  resolveOrderFx,
  type BookWebshopOrderOutcome,
} from './book-order'
import {
  WEBSHOP_PREFILL_ACCOUNTS,
  buildOrderBooking,
  orderBookingDescription,
  resolveBookingWarnings,
  resolvePaymentAccount,
  routeOrder,
  unsupportedSwedishRates,
  type OrderBooking,
} from './booking-lines'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function typedFailure(err: unknown): Failure {
  return { ok: false, code: (err as { code: string }).code, error: err }
}

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

const WARNING_TEXT: Record<string, { sv: string; en: string }> = {
  country_outside_sweden: {
    sv: 'Ordern har ett land utanför Sverige som butiken inte har valt konton för. Välj konton efter hur försäljningen beskattas (OSS, export eller VOEC); de föreslagna kontona är för svensk försäljning.',
    en: 'The order has a country outside Sweden that the store has not chosen accounts for. Choose accounts by how the sale is taxed (OSS, export or VOEC); the suggested accounts are for Swedish sales.',
  },
  // The booking dialog's own texts (messages webshop_orders.warning_*).
  country_unknown: {
    sv: 'Ordern saknar leveransland, och butiken har valt konton för försäljning utanför Sverige. Förslaget använder de svenska kontona; kontrollera vart ordern gick innan den bokförs.',
    en: 'The order has no destination country, and the store has chosen accounts for sales outside Sweden. The suggestion uses the Swedish accounts; check where the order went before booking it.',
  },
  zero_rate_foreign: {
    sv: 'Ordern har momsfri försäljning till kund utanför Sverige. Förslaget använder 3004 (övrig momsfri); export- eller EU-försäljning ska normalt bokas på 31xx/33xx-konton. Justera raderna vid behov.',
    en: 'The order has VAT-free sales to a customer outside Sweden. The suggestion uses 3004 (other VAT-free); export or EU sales normally belong on 31xx/33xx accounts. Adjust the lines if needed.',
  },
  foreign_vat: {
    sv: 'Ordern är i utländsk valuta med moms. Kontrollera att svensk utgående moms är rätt: vid EU-försäljning över tröskelvärdet (OSS) ska momsen inte redovisas via 2611-serien.',
    en: 'The order is in a foreign currency with VAT. Verify that Swedish output VAT is correct: for EU sales above the threshold (OSS), VAT should not be reported through the 2611 series.',
  },
  unsupported_vat_rate: {
    sv: 'Ordern har en momssats som inte är svensk. Förslaget lägger den på 25 %-kontona och måste ändras.',
    en: 'The order has a VAT rate that is not Swedish. The suggestion puts it on the 25 % accounts and must be changed.',
  },
  vat_breakdown_missing: {
    sv: 'Butiken skickade ingen momsuppdelning. Momssatsen i förslaget är härledd ur beloppen och måste kontrolleras.',
    en: 'The store sent no VAT breakdown. The VAT rate in the suggestion is inferred from the amounts and must be checked.',
  },
  vat_breakdown_gap: {
    sv: 'Orderns belopp skiljer sig från momsuppdelningen med mer än öresavrundning, och skillnaden går inte att lägga på en enda momssats. Förslaget tar inte med skillnaden och balanserar inte: lägg till rader för den innan ordern bokförs.',
    en: 'The order total differs from its VAT breakdown by more than öre rounding, and the difference cannot be put on a single VAT rate. The suggestion leaves the difference out and does not balance: add lines for it before booking the order.',
  },
  invoice_mode_method: {
    sv: 'Betalsättet är markerat som fakturaflöde för butiken. Överväg Skapa faktura i stället för att bokföra direkt.',
    en: 'This payment method is marked as invoice flow for the store. Consider Create invoice instead of booking directly.',
  },
}

function warning(code: keyof typeof WARNING_TEXT): OperationWarning {
  return { code, message_sv: WARNING_TEXT[code].sv, message_en: WARNING_TEXT[code].en }
}

/**
 * The advisories a person booking this order should read: never blocking,
 * the same hints the booking dialog shows plus the ones only an unattended
 * caller needs (a destination outside Sweden, a non-Swedish VAT rate, an
 * inferred VAT split).
 */
export function webshopOrderWarnings(
  order: WebshopOrder,
  settings: WebshopStoreSettings | null,
): OperationWarning[] {
  const out: OperationWarning[] = []
  const country = order.customer_country?.toUpperCase()
  // The store's country rules answer the question for the buckets they
  // cover; the hint stays for the rest, and for platforms they do not apply to.
  const routing = routeOrder(order, settings)
  if (country && country !== 'SE' && (routing.country === null || routing.unroutedRates.length > 0)) {
    out.push(warning('country_outside_sweden'))
  }
  for (const code of resolveBookingWarnings(order, settings)) {
    // Same advisory as country_outside_sweden above, under the code agents
    // already know.
    if (code !== 'country_not_routed') out.push(warning(code))
  }
  if (order.vat_breakdown.length === 0) out.push(warning('vat_breakdown_missing'))
  else if (unsupportedSwedishRates(routing).length > 0) out.push(warning('unsupported_vat_rate'))
  if (order.row_type === 'order' && resolvePaymentAccount(order, settings).invoiceMode) {
    out.push(warning('invoice_mode_method'))
  }
  if (suggestedBooking(order, settings)?.gap?.booked === null) out.push(warning('vat_breakdown_gap'))
  return out
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListWebshopOrdersInput {
  booked?: 'booked' | 'unbooked'
  platform?: WebshopPlatform
  row_type?: 'order' | 'refund'
  from?: string
  to?: string
  country?: string
  limit?: number
  offset?: number
}

const DEFAULT_LIMIT = 50

export async function listWebshopOrders(
  ctx: OperationContext,
  input: ListWebshopOrdersInput,
): Promise<OperationOutcome<{ orders: WebshopOrder[]; total: number }>> {
  const limit = input.limit ?? DEFAULT_LIMIT
  const offset = input.offset ?? 0
  let query = ctx.supabase
    .from('webshop_orders')
    .select('*', { count: 'exact' })
    .eq('company_id', ctx.companyId)
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (input.platform) query = query.eq('platform', input.platform)
  if (input.row_type) query = query.eq('row_type', input.row_type)
  if (input.from) query = query.gte('order_date', input.from)
  if (input.to) query = query.lte('order_date', input.to)
  if (input.country) query = query.eq('customer_country', input.country.toUpperCase())
  // Same split as the Orders page: "booked" is every closed exit (booked
  // here or marked as booked outside), "unbooked" the open set.
  if (input.booked === 'booked') {
    query = query.or('journal_entry_id.not.is.null,manually_booked_at.not.is.null')
  }
  if (input.booked === 'unbooked') {
    query = query.is('journal_entry_id', null).is('manually_booked_at', null)
  }
  const { data, error, count } = await query
  if (error) {
    ctx.log.error('failed to list webshop orders', error)
    return { ok: false, code: 'WEBSHOP_ORDER_READ_FAILED' }
  }
  return { ok: true, data: { orders: (data ?? []) as WebshopOrder[], total: count ?? 0 } }
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export interface WebshopOrderSuggestion {
  entry_date: string
  fiscal_period_id: string | null
  description: string
  payment_account: string
  payment_account_mapped: boolean
  /** Null while a non-SEK order has no exchange rate: booking is blocked until it resolves. */
  lines: CreateJournalEntryLineInput[] | null
}

async function loadStoreSettings(
  ctx: OperationContext,
  order: Pick<WebshopOrder, 'platform' | 'store_scope'>,
): Promise<WebshopStoreSettings | null> {
  const { data } = await ctx.supabase
    .from('webshop_store_settings')
    .select('*')
    .eq('company_id', ctx.companyId)
    .eq('platform', order.platform)
    .eq('store_scope', order.store_scope)
    .maybeSingle()
  return (data as WebshopStoreSettings | null) ?? null
}

/**
 * The dialog's prefill, or null while a non-SEK order has no exchange rate
 * (the builder refuses to guess one, and the dialog shows no lines either).
 */
function suggestedLines(
  order: WebshopOrder,
  settings: WebshopStoreSettings | null,
): CreateJournalEntryLineInput[] | null {
  return suggestedBooking(order, settings)?.lines ?? null
}

function suggestedBooking(order: WebshopOrder, settings: WebshopStoreSettings | null): OrderBooking | null {
  try {
    return buildOrderBooking({ order, settings })
  } catch {
    // Only a non-SEK order without an exchange rate throws: no prefill yet.
    return null
  }
}

function defaultEntryDate(order: Pick<WebshopOrder, 'paid_date' | 'order_date'>): string {
  return (order.paid_date ?? order.order_date).slice(0, 10)
}

export async function getWebshopOrder(
  ctx: OperationContext,
  input: { webshop_order_id: string },
): Promise<
  OperationOutcome<{ order: WebshopOrder; suggestion: WebshopOrderSuggestion; warnings: OperationWarning[] }>
> {
  const order = await loadWebshopOrder(ctx.supabase, ctx.companyId, input.webshop_order_id)
  if (!order) return { ok: false, code: 'WEBSHOP_ORDER_NOT_FOUND', details: { webshop_order_id: input.webshop_order_id } }
  const settings = await loadStoreSettings(ctx, order)
  const payment = resolvePaymentAccount(order, settings)
  const entryDate = defaultEntryDate(order)
  return {
    ok: true,
    data: {
      order,
      suggestion: {
        entry_date: entryDate,
        fiscal_period_id: await findFiscalPeriod(ctx.supabase, ctx.companyId, entryDate),
        description: orderBookingDescription(order),
        payment_account: payment.account,
        payment_account_mapped: payment.mapped,
        lines: suggestedLines(order, settings),
      },
      warnings: webshopOrderWarnings(order, settings),
    },
  }
}

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------

export interface BookWebshopOrderOperationInput {
  webshop_order_id: string
  lines: CreateJournalEntryLineInput[]
  entry_date?: string
  fiscal_period_id?: string
  description?: string
  voucher_series?: string
  notes?: string
}

export interface BookWebshopOrderResult {
  webshop_order_id: string
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  underlag_archived: boolean
}

/**
 * Everything the commit would refuse, checked without writing: the order's
 * state, its exchange rate, the lines, the period and its locks, and the
 * accounts. A prefill account the commit adds to the chart itself
 * (ensureWebshopPrefillAccounts) is not refused here, so the dry run and the
 * commit agree.
 */
async function prepareBooking(
  ctx: OperationContext,
  input: BookWebshopOrderOperationInput,
): Promise<
  | Failure
  | {
      ok: true
      order: WebshopOrder
      fiscalPeriodId: string
      entryDate: string
      description: string
    }
> {
  const { supabase, companyId } = ctx
  const order = await loadWebshopOrder(supabase, companyId, input.webshop_order_id)
  if (!order) return { ok: false, code: 'WEBSHOP_ORDER_NOT_FOUND', details: { webshop_order_id: input.webshop_order_id } }

  const guard = await assertOrderBookable(supabase, companyId, order)
  if (guard) return { ok: false, code: guard.code, ...(guard.details ? { details: guard.details } : {}) }

  const resolved = await resolveOrderFx(supabase, companyId, order, ctx.log, { persist: false })
  if (!resolved) return { ok: false, code: 'WEBSHOP_ORDER_FX_UNRESOLVED', details: { currency: order.currency } }

  try {
    assertLinesWellFormed(input.lines)
  } catch (err) {
    return typedFailure(err)
  }
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    return typedFailure(new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft'))
  }

  const entryDate = input.entry_date ?? defaultEntryDate(resolved)
  let fiscalPeriodId = input.fiscal_period_id ?? null
  if (fiscalPeriodId) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!period) return typedFailure(new FiscalPeriodNotFoundError())
    if (entryDate < period.period_start || entryDate > period.period_end) {
      return typedFailure(
        new EntryDateOutsideFiscalPeriodError(entryDate, period.name, period.period_start, period.period_end),
      )
    }
  } else {
    fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
    if (!fiscalPeriodId) return typedFailure(new FiscalPeriodNotFoundError())
  }

  const lock = await checkPeriodLock(supabase, companyId, entryDate)
  if (lock.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: lock.reason, fiscal_period_id: lock.fiscal_period_id, entry_date: entryDate },
    }
  }

  const unresolvable = (
    await findUnresolvableAccounts(
      supabase,
      companyId,
      input.lines.map((l) => l.account_number),
    )
  ).filter((n) => !WEBSHOP_PREFILL_ACCOUNTS.includes(n))
  if (unresolvable.length > 0) return typedFailure(new AccountsNotInChartError(unresolvable))

  return {
    ok: true,
    order: resolved,
    fiscalPeriodId,
    entryDate,
    description: input.description ?? orderBookingDescription(resolved),
  }
}

function bookFailure(outcome: Extract<BookWebshopOrderOutcome, { ok: false }>, ctx: OperationContext): Failure {
  switch (outcome.kind) {
    case 'not_found':
      return { ok: false, code: 'WEBSHOP_ORDER_NOT_FOUND' }
    case 'not_bookable':
      return {
        ok: false,
        code: outcome.failure.code,
        ...(outcome.failure.details ? { details: outcome.failure.details } : {}),
      }
    case 'fx_unresolved':
      return { ok: false, code: 'WEBSHOP_ORDER_FX_UNRESOLVED', details: { currency: outcome.currency } }
    case 'claimed_elsewhere':
      return { ok: false, code: 'WEBSHOP_ORDER_ALREADY_BOOKED' }
    case 'claim_error':
      return { ok: false, code: 'WEBSHOP_ORDER_BOOKING_FAILED' }
    case 'engine_error':
      if (isBookkeepingError(outcome.error)) return typedFailure(outcome.error)
      ctx.log.error(`webshop order ${outcome.stage} failed`, outcome.error as Error)
      return {
        ok: false,
        code: 'WEBSHOP_ORDER_BOOKING_FAILED',
        messageSv: getErrorMessage(outcome.error, { context: 'transaction' }),
      }
  }
}

export async function bookWebshopOrderWithLines(
  ctx: OperationContext,
  input: BookWebshopOrderOperationInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookWebshopOrderResult>> {
  const prepared = await prepareBooking(ctx, input)
  if (!prepared.ok) return prepared
  const { order, fiscalPeriodId, entryDate, description } = prepared

  if (options.dryRun) {
    const settings = await loadStoreSettings(ctx, order)
    return {
      ok: true,
      dryRun: true,
      preview: {
        webshop_order_id: order.id,
        order_number: order.order_number,
        platform: order.platform,
        row_type: order.row_type,
        customer_country: order.customer_country,
        currency: order.currency,
        total: order.total,
        total_sek: order.total_sek,
        journal_entry: toEntryPreview({
          fiscal_period_id: fiscalPeriodId,
          entry_date: entryDate,
          description,
          source_type: 'webshop_order',
          source_id: order.id,
          voucher_series: input.voucher_series,
          notes: input.notes,
          lines: input.lines,
        }),
        warnings: webshopOrderWarnings(order, settings).map((w) => w.code),
        will: 'post this verifikat (source_type webshop_order) linked to the order, and archive the orderunderlag on it',
      },
    }
  }

  const outcome = await bookWebshopOrder(
    ctx.supabase,
    ctx.companyId,
    ctx.userId,
    order.id,
    {
      fiscal_period_id: fiscalPeriodId,
      entry_date: entryDate,
      description,
      lines: input.lines,
      voucher_series: input.voucher_series,
      notes: input.notes,
    },
    ctx.log,
  )
  if (!outcome.ok) return bookFailure(outcome, ctx)

  return {
    ok: true,
    created: true,
    data: {
      webshop_order_id: order.id,
      journal_entry_id: outcome.journalEntryId,
      voucher_series: outcome.journalEntry?.voucher_series ?? null,
      voucher_number: outcome.journalEntry?.voucher_number ?? null,
      entry_date: entryDate,
      underlag_archived: outcome.underlagArchived,
    },
    ...(outcome.underlagArchived
      ? {}
      : {
          warnings: [
            {
              code: 'WEBSHOP_ORDER_UNDERLAG_NOT_ARCHIVED',
              message_sv: 'Verifikatet bokfördes men orderunderlaget kunde inte arkiveras. Bifoga ett underlag från listan Saknar underlag.',
              message_en: 'The voucher was booked but the order underlag could not be archived. Attach one from the missing-underlag list.',
            },
          ],
        }),
  }
}
