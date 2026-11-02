/**
 * The stop at the included amount: before a paid action, whether it may go
 * ahead. While a kind is billed (USAGE_BILLING_KINDS) and its month is used
 * up, the action is refused: with USAGE_SUBSCRIPTION_REQUIRED for a company
 * without a subscription of its own (paying.ts), else with
 * USAGE_CONSENT_REQUIRED until an admin accepts the charge (consent.ts);
 * after that it goes ahead and costs the unit price. A kind that is not
 * billed is never stopped here: its own rules apply as before.
 *
 * Bank payments have their own stop with a safety ceiling
 * (lib/payments/allowance.ts); this is the gate for the other kinds in
 * USAGE_GATED_KINDS.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationOutcome } from '@/lib/operations/types'
import { currentUsagePeriod } from '@/lib/payments/usage'
import { consentCovers, readOpenConsents } from './consent'
import { countCompanyUsage } from './counters'
import { billedUsageKinds, formatOre, USAGE_INVOICE_LABELS, USAGE_PRICES, USAGE_UNITS_SV, type UsageKind } from './kinds'
import { readCompanyPays } from './paying'

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

export interface UsageConsentRequiredDetails {
  kind: UsageKind
  /** YYYY-MM in Stockholm time. */
  period: string
  used: number
  included: number
  requested: number
  unit_price_ore: number
}

/** "Månadens 3 signeringar som ingår är använda. Fler kostar", or for a kind with none included "Utskick till Kivra kostar". */
function priceHead(details: UsageConsentRequiredDetails): string {
  return details.included > 0
    ? `Månadens ${details.included} ${USAGE_UNITS_SV[details.kind]} som ingår är använda. Fler kostar`
    : `${USAGE_INVOICE_LABELS[details.kind]} kostar`
}

/** The Swedish refusal, with the numbers (thrown_message_sv on the code). */
export function usageConsentRequiredMessage(details: UsageConsentRequiredDetails): string {
  return (
    `${priceHead(details)} ${formatOre(details.unit_price_ore)} st och faktureras i efterskott. ` +
    'En admin godkänner det under Inställningar, Abonnemang, Användning.'
  )
}

/** The refusal for a company without a subscription of its own. */
export function usageSubscriptionRequiredMessage(details: UsageConsentRequiredDetails): string {
  return `${priceHead(details)} ${formatOre(details.unit_price_ore)} st och kräver ett abonnemang. Starta det under Inställningar, Abonnemang.`
}

/**
 * The refusal for `requested` more units of a kind, or null when they may go
 * ahead. Read before the action and outside it: two actions at the same
 * moment can each see room and pass the included amount by one or two,
 * which the statement then shows as billable only with an acceptance.
 */
export async function usageGateRefusal(
  service: SupabaseClient,
  companyId: string,
  kind: UsageKind,
  options: { requested?: number; period?: string; env?: Record<string, string | undefined> } = {},
): Promise<Refusal | null> {
  if (!billedUsageKinds(options.env).has(kind)) return null
  const price = USAGE_PRICES[kind]
  const included = price.includedPerMonth ?? 0
  const requested = options.requested ?? 1
  const period = options.period ?? currentUsagePeriod()
  const used = await countCompanyUsage(service, companyId, kind, period)
  if (used + requested <= included) return null
  const details: UsageConsentRequiredDetails = { kind, period, used, included, requested, unit_price_ore: price.unitPriceOre ?? 0 }
  if (!(await readCompanyPays(service, companyId))) {
    return { ok: false, code: 'USAGE_SUBSCRIPTION_REQUIRED', details: { ...details }, messageSv: usageSubscriptionRequiredMessage(details) }
  }
  if (consentCovers((await readOpenConsents(service, companyId)).get(kind), kind)) return null
  return { ok: false, code: 'USAGE_CONSENT_REQUIRED', details: { ...details }, messageSv: usageConsentRequiredMessage(details) }
}
