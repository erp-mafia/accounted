/**
 * The month's usage statements, and what is billed of them.
 *
 * Run by the monthly usage cron for the month that just ended. Every company
 * that used a priced kind gets one usage_statements row per kind it used:
 *
 *   preview    not billed, with the reason: no_price, nothing_billable
 *              (within what the month includes), billing_off (the kind is not
 *              in USAGE_BILLING_KINDS), no_consent (no admin accepted the
 *              charge, consent.ts), not_paying (no active subscription of its
 *              own: a trial, a past-due card, a byrå's client, a demo)
 *   billing    the Stripe lines are being made
 *   billed     a line on the company's own subscription at Stripe
 *   failed     Stripe refused something; the error is on the row
 *
 * What is billed rides the subscription, never a separate bill: one line per
 * kind ("Betalningar via banken, oktober 2026: 4 st à 2,00 kr", Stripe Tax,
 * prices exkl. moms). A monthly plan's lines wait for its next subscription
 * invoice; a yearly plan renews once a year, so its lines get an invoice for
 * the subscription each month instead of waiting.
 *
 * A rerun is safe: a statement that is billed is never touched again, the
 * Stripe calls carry idempotency keys, and a company left billing or failed
 * is never billed again by the cron: it is reported for a person.
 */

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { swedishMonthName } from '@/lib/payments/allowance'
import { allowanceOf, currentUsagePeriod, isUsagePeriod, usagePeriodBounds } from '@/lib/payments/usage'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { consentCovers, readOpenConsentsByCompany, type UsageConsent } from './consent'
import { countUsageByCompany } from './counters'
import { formatOre, USAGE_INVOICE_LABELS, USAGE_KINDS, usageLine, type UsageKind, type UsageLine } from './kinds'
import { subscriptionPays } from './paying'

export type StatementStatus = 'preview' | 'billing' | 'billed' | 'failed'
export type PreviewReason = 'no_price' | 'nothing_billable' | 'billing_off' | 'no_consent' | 'not_paying'

export interface CloseUsageDeps {
  /** Null where Stripe is not configured: every statement is then a preview. */
  stripe: Stripe | null
  /** The kinds billed this run (billedUsageKinds). */
  billed: Set<UsageKind>
  log: Logger
}

export interface CloseUsageResult {
  period: string
  companies: number
  statements: number
  billed: Array<{ companyId: string; amountOre: number; invoiceId: string | null }>
  failed: Array<{ companyId: string; error: string }>
  /** Companies with a statement already billing or failed: left for a person. */
  needsAttention: string[]
}

interface ExistingStatement {
  company_id: string
  kind: UsageKind
  status: StatementStatus
}

interface CompanyContext {
  isSandbox: boolean
  subscriptionStatus: string | null
  subscriptionId: string | null
  customerId: string | null
  plan: string | null
  bankPaymentsIncluded: number
  consents: Map<UsageKind, UsageConsent>
}

/** Ids per .in() read: a few hundred uuids would pass the URL length PostgREST takes. */
const IN_CHUNK = 100

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function readByCompanies<T>(service: SupabaseClient, table: string, columns: string, companyIds: string[]): Promise<T[]> {
  const rows: T[] = []
  for (const ids of chunks(companyIds, IN_CHUNK)) {
    const { data, error } = await service.from(table).select(columns).in('company_id', ids)
    if (error) throw new Error(`${table} read failed: ${error.message}`)
    rows.push(...((data ?? []) as T[]))
  }
  return rows
}

/** The month's statements already written: a rerun never touches what was billed. */
async function readStatements(service: SupabaseClient, period: string): Promise<ExistingStatement[]> {
  return fetchAllRows<ExistingStatement & { id: string }>(({ from, to }) =>
    service.from('usage_statements').select('id, company_id, kind, status').eq('period', period).order('id').range(from, to),
  )
}

type SubscriptionRow = { company_id: string; status: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null; plan: string | null }

async function loadCompanyContexts(service: SupabaseClient, companyIds: string[]): Promise<Map<string, CompanyContext>> {
  const [settings, subscriptions, allowances, consents] = await Promise.all([
    readByCompanies<{ company_id: string; is_sandbox: boolean | null }>(service, 'company_settings', 'company_id, is_sandbox', companyIds),
    readByCompanies<SubscriptionRow>(
      service,
      'company_subscriptions',
      'company_id, status, stripe_customer_id, stripe_subscription_id, plan',
      companyIds,
    ),
    // `*` like readBankPaymentsAllowance: a deploy a moment before its migration still reads.
    readByCompanies<{ company_id: string; monthly_payments?: number | null; purchased_packs?: number | null }>(
      service,
      'company_bank_payment_allowances',
      '*',
      companyIds,
    ),
    readOpenConsentsByCompany(service, companyIds),
  ])
  const sandbox = new Map(settings.map((r) => [r.company_id, r.is_sandbox === true]))
  const subscription = new Map(subscriptions.map((r) => [r.company_id, r]))
  const allowance = new Map(allowances.map((r) => [r.company_id, r]))
  return new Map(
    companyIds.map((id) => {
      const sub = subscription.get(id)
      return [
        id,
        {
          isSandbox: sandbox.get(id) ?? false,
          subscriptionStatus: sub?.status ?? null,
          subscriptionId: sub?.stripe_subscription_id ?? null,
          customerId: sub?.stripe_customer_id ?? null,
          plan: sub?.plan ?? null,
          bankPaymentsIncluded: allowanceOf(allowance.get(id) ?? null).included,
          consents: consents.get(id) ?? new Map(),
        },
      ]
    }),
  )
}

/** Why a line is not billed, or null when it is. */
export function previewReason(line: UsageLine, billed: Set<UsageKind>, accepted: boolean, paying: boolean): PreviewReason | null {
  if (line.unit_price_ore === null) return 'no_price'
  if (line.amount_ore <= 0) return 'nothing_billable'
  if (!billed.has(line.kind)) return 'billing_off'
  if (!accepted) return 'no_consent'
  if (!paying) return 'not_paying'
  return null
}

/** The line text: kind, month, count and unit price ("med antal och belopp per post"). */
export function invoiceLineDescription(line: UsageLine, period: string): string {
  const month = `${swedishMonthName(period)} ${period.slice(0, 4)}`
  return `${USAGE_INVOICE_LABELS[line.kind]}, ${month}: ${line.billable} st à ${formatOre(line.unit_price_ore ?? 0)}`
}

function statementRow(companyId: string, period: string, line: UsageLine, status: StatementStatus, extra: Record<string, unknown> = {}) {
  return {
    company_id: companyId,
    period,
    kind: line.kind,
    used: line.used,
    included: line.included,
    billable: line.billable,
    unit_price_ore: line.unit_price_ore,
    amount_ore: line.amount_ore,
    status,
    reason: null,
    stripe_invoice_item_id: null,
    stripe_invoice_id: null,
    error: null,
    ...extra,
  }
}

async function upsertStatements(service: SupabaseClient, rows: Array<ReturnType<typeof statementRow>>): Promise<void> {
  if (rows.length === 0) return
  const { error } = await service.from('usage_statements').upsert(rows, { onConflict: 'company_id,period,kind' })
  if (error) throw new Error(`usage_statements write failed: ${error.message}`)
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500)
}

/** Billing that failed, with the Stripe lines and invoice it got as far as. */
export class UsageBillingError extends Error {
  constructor(
    message: string,
    readonly items: ReadonlyMap<UsageKind, string>,
    readonly invoiceId: string | null,
  ) {
    super(message)
    this.name = 'UsageBillingError'
  }
}

/**
 * One company's lines on its subscription: one pending item per kind for the
 * subscription, then, for a yearly plan, an invoice for the subscription that
 * takes them and is charged at once. A monthly plan's items wait for its next
 * subscription invoice.
 */
async function billCompany(input: {
  service: SupabaseClient
  stripe: Stripe
  companyId: string
  context: CompanyContext
  period: string
  lines: UsageLine[]
}): Promise<{ amountOre: number; invoiceId: string | null }> {
  const { service, stripe, companyId, context, period, lines } = input
  const customer = context.customerId!
  const subscription = context.subscriptionId!
  const { start, end } = usagePeriodBounds(period)
  const servicePeriod = { start: Math.floor(Date.parse(start) / 1000), end: Math.floor(Date.parse(end) / 1000) }
  const items = new Map<UsageKind, string>()
  let invoiceId: string | null = null

  try {
    await upsertStatements(service, lines.map((line) => statementRow(companyId, period, line, 'billing')))
    for (const line of lines) {
      const item = await stripe.invoiceItems.create(
        {
          customer,
          subscription,
          currency: 'sek',
          amount: line.amount_ore,
          description: invoiceLineDescription(line, period),
          tax_behavior: 'exclusive',
          period: servicePeriod,
          metadata: {
            company_id: companyId,
            period,
            kind: line.kind,
            billable: String(line.billable),
            unit_price_ore: String(line.unit_price_ore ?? 0),
          },
        },
        { idempotencyKey: `usage-item:${companyId}:${period}:${line.kind}` },
      )
      items.set(line.kind, item.id)
    }

    if (context.plan === 'yearly') {
      const invoice = await stripe.invoices.create(
        {
          customer,
          subscription,
          collection_method: 'charge_automatically',
          auto_advance: true,
          automatic_tax: { enabled: true },
          pending_invoice_items_behavior: 'include',
          description: `Styckavgifter ${swedishMonthName(period)} ${period.slice(0, 4)}`,
          metadata: { company_id: companyId, period, purpose: 'usage_statement' },
        },
        { idempotencyKey: `usage-invoice:${companyId}:${period}` },
      )
      invoiceId = invoice.id
      await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true })
    }
  } catch (err) {
    throw new UsageBillingError(errorText(err), items, invoiceId)
  }

  await upsertStatements(
    service,
    lines.map((line) =>
      statementRow(companyId, period, line, 'billed', { stripe_invoice_item_id: items.get(line.kind), stripe_invoice_id: invoiceId }),
    ),
  )
  return { amountOre: lines.reduce((sum, line) => sum + line.amount_ore, 0), invoiceId }
}

/**
 * Close a month that has ended: write every company's statements and bill
 * what is above the included amount where the kind is billed, an admin
 * accepted the charge and the company has an active subscription of its own.
 * Refuses the current or a future month: a month still open would be billed
 * short.
 */
export async function closeUsagePeriod(service: SupabaseClient, period: string, deps: CloseUsageDeps): Promise<CloseUsageResult> {
  if (!isUsagePeriod(period) || period >= currentUsagePeriod()) {
    throw new Error(`usage period ${period} is not a closed month`)
  }
  const result: CloseUsageResult = { period, companies: 0, statements: 0, billed: [], failed: [], needsAttention: [] }

  const counts = new Map<UsageKind, Map<string, number>>()
  for (const kind of USAGE_KINDS) counts.set(kind, await countUsageByCompany(service, kind, period))
  const companyIds = [...new Set([...counts.values()].flatMap((byCompany) => [...byCompany.keys()]))].sort()
  if (companyIds.length === 0) return result

  const [contexts, existingRows] = await Promise.all([loadCompanyContexts(service, companyIds), readStatements(service, period)])
  const existing = new Map(existingRows.map((r) => [`${r.company_id}:${r.kind}`, r.status] as const))

  for (const companyId of companyIds) {
    const context = contexts.get(companyId)!
    const lines = USAGE_KINDS.map((kind) =>
      usageLine(kind, counts.get(kind)?.get(companyId) ?? 0, kind === 'bank_payment' ? context.bankPaymentsIncluded : null),
    ).filter((line) => line.used > 0)
    result.companies += 1

    const stuck = lines.filter((line) => {
      const status = existing.get(`${companyId}:${line.kind}`)
      return status === 'billing' || status === 'failed'
    })
    if (stuck.length > 0) {
      // Half-made or refused lines: a person decides, the cron never bills this company again.
      result.needsAttention.push(companyId)
      deps.log.warn('usage statement left for a person', { companyId, period, kinds: stuck.map((l) => l.kind) })
      continue
    }

    const open = lines.filter((line) => existing.get(`${companyId}:${line.kind}`) !== 'billed')
    const paying =
      !!deps.stripe &&
      subscriptionPays({
        isSandbox: context.isSandbox,
        status: context.subscriptionStatus,
        customerId: context.customerId,
        subscriptionId: context.subscriptionId,
      })
    const toBill: UsageLine[] = []
    const previews: Array<ReturnType<typeof statementRow>> = []
    for (const line of open) {
      const reason = previewReason(line, deps.billed, consentCovers(context.consents.get(line.kind), line.kind), paying)
      if (reason) previews.push(statementRow(companyId, period, line, 'preview', { reason }))
      else toBill.push(line)
    }
    await upsertStatements(service, previews)
    result.statements += previews.length

    if (toBill.length === 0) continue
    try {
      const billed = await billCompany({ service, stripe: deps.stripe!, companyId, context, period, lines: toBill })
      result.billed.push({ companyId, ...billed })
      result.statements += toBill.length
    } catch (err) {
      const error = errorText(err)
      const items = err instanceof UsageBillingError ? err.items : new Map<UsageKind, string>()
      const invoiceId = err instanceof UsageBillingError ? err.invoiceId : null
      deps.log.error('usage billing failed', { companyId, period, invoiceId, items: items.size, error })
      result.failed.push({ companyId, error })
      await upsertStatements(
        service,
        toBill.map((line) =>
          statementRow(companyId, period, line, 'failed', { error, stripe_invoice_item_id: items.get(line.kind) ?? null, stripe_invoice_id: invoiceId }),
        ),
      ).catch((writeErr) => deps.log.error('usage statement failure not recorded', { companyId, period, error: errorText(writeErr) }))
    }
  }
  return result
}

/** The month before `period` (YYYY-MM): what the cron on the 1st closes. */
export function previousUsagePeriod(period: string = currentUsagePeriod()): string {
  const [year, month] = period.split('-').map(Number)
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}
