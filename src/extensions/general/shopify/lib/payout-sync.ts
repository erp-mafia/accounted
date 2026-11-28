import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import type { Logger } from '@/lib/logger'
import { equalOre, parseSwedishAmount, roundOre, sumOre } from '@/lib/money'
import { storeWebshopPayouts, type WebshopPayoutRecord } from '@/lib/webshop-orders/payout-store'
import { payoutLine } from '@/lib/webshop-orders/payouts'
import type { WebshopPayoutLine } from '@/types'
import { listPayoutsPage, type ShopifySession } from './api-client'
import type { ShopifyMoney, ShopifyPayout } from '../types'

/**
 * Shopify Payments payouts as payout records (webshop_payouts), the second
 * source of the payout model Kustom's settlement report started
 * (lib/webshop-orders/payouts.ts): each payout's bank row is then proposed as
 * one verifikat, the bank net, Shopify's fees and the clearing account gross.
 * The sales and refunds themselves are the order feed's (order-sync.ts).
 *
 * Read with the payout scopes the store's app may not have
 * (read_shopify_payments_payouts, read_shopify_payments_accounts): without
 * them the run says so and the order feed is untouched. Nothing here books.
 *
 * Each run reads the payouts issued in the last PAYOUT_LOOKBACK_DAYS: a few a
 * week, stored once by their id, and a payout no bank row has claimed takes
 * the latest figures (one in transit settles). Only deposits that are paid or
 * in transit: a scheduled payout can still change, a failed or cancelled one
 * never reaches the bank, and a withdrawal is money back to Shopify.
 */

export const PAYOUT_LOOKBACK_DAYS = 35
/** Pages one run reads at most: 25 payouts a week is far above any shop's. */
const MAX_PAYOUT_PAGES = 4

const BANK_STATUSES = new Set(['PAID', 'IN_TRANSIT'])

export interface ShopifyPayoutSyncSummary {
  /** Payouts stored or refreshed this run. */
  stored: number
  /** Payouts left out: not a paid deposit, or a summary that does not add up to the payout. */
  skipped: number
  /** The app lacks the payout scopes. */
  scopeMissing: boolean
}

/** ⚠️ STORED-KEY FORMAT: a payout's identity in webshop_payouts. */
export function shopifyPayoutExternalId(shopScope: string, legacyResourceId: string): string {
  return `shopify_${shopScope}_payout_${legacyResourceId}`
}

function amountOf(money: ShopifyMoney | undefined): number | null {
  if (!money) return 0
  const value = parseSwedishAmount(money.amount, '.')
  return value === null ? null : roundOre(value)
}

/** The Swedish calendar day of a Shopify timestamp: the payout day the bank row is looked for around. */
function swedishDayOf(timestamp: string): string {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? todayIsoStockholm(new Date(ms)) : timestamp.slice(0, 10)
}

export type PayoutRecordOutcome =
  | { ok: true; record: WebshopPayoutRecord }
  /** not_paid: not a paid or in-transit deposit; unreadable: the summary does not add up to the payout. */
  | { ok: false; reason: 'not_paid' | 'unreadable' }

/**
 * One payout as a payout record. Shopify's summary gives a gross and a fee
 * per transaction type; the payout is the grosses less the fees. Which sign a
 * fee carries is read off that identity, to the öre, and a summary it does not
 * hold for is left out rather than guessed. Charges are the sale, refunds the
 * return, the fees one fee part (an acquiring fee: no VAT, ML 2023:200
 * 10 kap. 33 §, so no fee VAT part), reserved funds a holdback or a release,
 * and adjustments, retried payouts and advances an adjustment, which the
 * proposal leaves for a person.
 */
export function shopifyPayoutRecord(shopScope: string, payout: ShopifyPayout): PayoutRecordOutcome {
  if (payout.transactionType !== 'DEPOSIT' || !BANK_STATUSES.has(payout.status)) return { ok: false, reason: 'not_paid' }
  const s = payout.summary
  const net = amountOf(payout.net)
  const grosses = {
    charges: amountOf(s.chargesGross),
    refunds: amountOf(s.refundsFeeGross),
    adjustments: amountOf(s.adjustmentsGross),
    reserved: amountOf(s.reservedFundsGross),
    retried: amountOf(s.retriedPayoutsGross),
    advance: amountOf(s.advanceGross),
  }
  const fees = [s.chargesFee, s.refundsFee, s.adjustmentsFee, s.reservedFundsFee, s.retriedPayoutsFee, s.advanceFees].map(amountOf)
  if (net === null || Object.values(grosses).some((v) => v === null) || fees.some((v) => v === null)) {
    return { ok: false, reason: 'unreadable' }
  }
  const gross = sumOre(Object.values(grosses) as number[])
  const fee = sumOre(fees as number[])
  // The payout is the grosses less the fees: fees reported as costs (positive)
  // or as deductions (negative), whichever the summary holds to the öre.
  const feeCost = equalOre(sumOre([gross, -fee]), net) ? fee : equalOre(sumOre([gross, fee]), net) ? -fee : null
  if (feeCost === null || feeCost < 0) return { ok: false, reason: 'unreadable' }
  if ((grosses.charges as number) < 0 || (grosses.refunds as number) > 0) return { ok: false, reason: 'unreadable' }

  const reserved = grosses.reserved as number
  const parts = [
    payoutLine('sale', grosses.charges as number),
    payoutLine('return', grosses.refunds as number),
    payoutLine('fee', feeCost),
    reserved < 0 ? payoutLine('holdback', reserved) : payoutLine('release', reserved),
    payoutLine('adjustment', sumOre([grosses.adjustments as number, grosses.retried as number, grosses.advance as number])),
  ].filter((l): l is WebshopPayoutLine => l !== null)
  if (!equalOre(sumOre(parts.map((l) => l.amount)), net)) return { ok: false, reason: 'unreadable' }

  return {
    ok: true,
    record: {
      platform: 'shopify',
      store_scope: shopScope,
      external_id: shopifyPayoutExternalId(shopScope, payout.legacyResourceId),
      reference: payout.legacyResourceId,
      payout_date: swedishDayOf(payout.issuedAt),
      currency: (payout.net.currencyCode ?? 'SEK').toUpperCase(),
      amount: net,
      lines: parts,
    },
  }
}

/**
 * Read the store's recent payouts and store each as a payout record. Never
 * throws for a missing scope; a failure to read or store is logged and the
 * order sync's summary goes on (the caller wraps it).
 */
export async function syncShopifyPayouts(
  service: SupabaseClient,
  session: ShopifySession,
  args: { companyId: string; userId: string | null; shopScope: string; connectionId: string; today?: string },
  log: Logger,
): Promise<ShopifyPayoutSyncSummary> {
  const summary: ShopifyPayoutSyncSummary = { stored: 0, skipped: 0, scopeMissing: false }
  const issuedOnOrAfter = addDaysIso(args.today ?? todayIsoStockholm(), -PAYOUT_LOOKBACK_DAYS)
  let after: string | null = null
  const records: WebshopPayoutRecord[] = []
  for (let pageNo = 0; pageNo < MAX_PAYOUT_PAGES; pageNo++) {
    const page = await listPayoutsPage(session, { issuedOnOrAfter, after })
    if (page.kind === 'scope_missing') {
      summary.scopeMissing = true
      log.info('shopify app lacks the payout scopes; payouts not read', { connectionId: args.connectionId })
      return summary
    }
    if (page.kind === 'no_account') return summary
    let reachedOlder = false
    for (const payout of page.payouts) {
      // Newest first: past the lookback, the rest is older still.
      if (swedishDayOf(payout.issuedAt) < issuedOnOrAfter) {
        reachedOlder = true
        break
      }
      const outcome = shopifyPayoutRecord(args.shopScope, payout)
      if (outcome.ok) records.push(outcome.record)
      else {
        summary.skipped += 1
        if (outcome.reason === 'unreadable') {
          log.warn('shopify payout summary does not add up to the payout; left out', { connectionId: args.connectionId, payout: payout.legacyResourceId })
        }
      }
    }
    if (reachedOlder || !page.hasNextPage) break
    after = page.endCursor
  }
  await storeWebshopPayouts(service, args.companyId, args.userId, records)
  summary.stored = records.length
  return summary
}
