/**
 * The stop at the included amount: before a paid action, whether it may go
 * ahead. While a kind is billed (USAGE_BILLING_KINDS) and what it includes
 * is used up (the month's amount, or for signed documents the company's
 * first in all), the action is refused: with USAGE_SUBSCRIPTION_REQUIRED for
 * a company nobody pays for (paying.ts), else with USAGE_LIMIT_REACHED until
 * the company asks for more (requests.ts) and a founder opens the charge for
 * it (a usage_consents row, consent.ts); after that it goes ahead and costs
 * the unit price. A kind that is not billed is never stopped here: its own rules
 * apply as before.
 *
 * Bank payments have their own stop with a safety ceiling
 * (lib/payments/allowance.ts); this is the gate for the other kinds in
 * USAGE_GATED_KINDS.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationOutcome } from '@/lib/operations/types'
import { currentUsagePeriod } from '@/lib/payments/usage'
import { liveAccountKeys, readLiveBankAccounts } from './bank-accounts'
import { consentCovers, readOpenConsents } from './consent'
import { countCompanyUsage } from './counters'
import { billedUsageKinds, formatOre, USAGE_GAUGE_KINDS, USAGE_INVOICE_LABELS, USAGE_PRICES, USAGE_UNITS_SV, type UsageKind } from './kinds'
import { readCompanyPays } from './paying'

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

export interface UsageLimitDetails {
  kind: UsageKind
  /** YYYY-MM in Stockholm time. */
  period: string
  /** Used this month; for a kind included once (signed documents), used in all. */
  used: number
  /** What a month includes; for a kind included once, what the company's first units include in all. */
  included: number
  requested: number
  unit_price_ore: number
}

/**
 * "Månadens 10 skickade e-fakturor som ingår är använda. Fler kostar 1,00 kr
 * st", for a kind included once "De 3 signeringar som ingår är använda. Fler
 * kostar 10,00 kr st", for live bank accounts "De 2 kopplade bankkonton som
 * ingår är använda. Fler kostar 20,00 kr st i månaden", and for a kind with
 * none included "Utskick till Kivra kostar 3,00 kr st".
 */
function priceSentence(details: UsageLimitDetails): string {
  const price = formatOre(details.unit_price_ore)
  if (details.included <= 0) return `${USAGE_INVOICE_LABELS[details.kind]} kostar ${price} st`
  const units = USAGE_UNITS_SV[details.kind]
  if (USAGE_GAUGE_KINDS.has(details.kind)) return `De ${details.included} ${units} som ingår är använda. Fler kostar ${price} st i månaden`
  if (USAGE_PRICES[details.kind].includedOnce !== undefined) return `De ${details.included} ${units} som ingår är använda. Fler kostar ${price} st`
  return `Månadens ${details.included} ${units} som ingår är använda. Fler kostar ${price} st`
}

/** The Swedish refusal at the limit, with the numbers (thrown_message_sv on the code). */
export function usageLimitReachedMessage(details: UsageLimitDetails): string {
  const ask = details.included > 0 ? 'Begär fler' : 'Begär det'
  return `${priceSentence(details)}. ${ask} under Inställningar, Abonnemang, Användning, så öppnar vi.`
}

/** The refusal for a company nobody pays for. */
export function usageSubscriptionRequiredMessage(details: UsageLimitDetails): string {
  return `${priceSentence(details)} och kräver ett abonnemang. Starta det under Inställningar, Abonnemang.`
}

/**
 * The refusal for `requested` more units of a kind, or null when they may go
 * ahead. `used` is counted here unless the caller passes it (live bank
 * accounts, which the caller reads around a selection): the month's units,
 * or for a kind included once every unit so far. Read before the
 * action and outside it: two actions at the same moment can each see room
 * and pass the included amount by one or two, which the statement then shows
 * as billable only once the charge is open.
 */
export async function usageGateRefusal(
  service: SupabaseClient,
  companyId: string,
  kind: UsageKind,
  options: { requested?: number; used?: number; period?: string; env?: Record<string, string | undefined> } = {},
): Promise<Refusal | null> {
  if (!billedUsageKinds(options.env).has(kind)) return null
  const requested = options.requested ?? 1
  if (requested <= 0) return null
  const price = USAGE_PRICES[kind]
  const once = price.includedOnce !== undefined
  const included = (once ? price.includedOnce : price.includedPerMonth) ?? 0
  const period = options.period ?? currentUsagePeriod()
  const used =
    options.used ??
    (once
      ? (await countCompanyUsage(service, companyId, kind, period, { before: true })) + (await countCompanyUsage(service, companyId, kind, period))
      : await countCompanyUsage(service, companyId, kind, period))
  if (used + requested <= included) return null
  const details: UsageLimitDetails = { kind, period, used, included, requested, unit_price_ore: price.unitPriceOre ?? 0 }
  if (!(await readCompanyPays(service, companyId))) {
    return { ok: false, code: 'USAGE_SUBSCRIPTION_REQUIRED', details: { ...details }, messageSv: usageSubscriptionRequiredMessage(details) }
  }
  if (consentCovers((await readOpenConsents(service, companyId)).get(kind), kind)) return null
  return { ok: false, code: 'USAGE_LIMIT_REACHED', details: { ...details }, messageSv: usageLimitReachedMessage(details) }
}

/**
 * The stop for a bank account selection: `accounts` are what the selection
 * will store on connection `connectionId`. Only accounts the selection adds
 * to the company's live ones are requested, so a company already above what
 * is included keeps the accounts it has (they cost the unit price once the
 * charge is open) and saves a reselection of them freely.
 */
export async function bankAccountsSelectionRefusal(
  service: SupabaseClient,
  companyId: string,
  connectionId: string,
  accounts: unknown,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<Refusal | null> {
  if (!billedUsageKinds(options.env).has('bank_account')) return null
  const [all, others] = await Promise.all([
    readLiveBankAccounts(service, companyId),
    readLiveBankAccounts(service, companyId, { exceptConnectionId: connectionId }),
  ])
  const after = new Set([...others, ...liveAccountKeys(accounts, companyId)])
  return usageGateRefusal(service, companyId, 'bank_account', { used: all.size, requested: after.size - all.size, env: options.env })
}
