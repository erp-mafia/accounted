import { isEuMemberCountry } from '@/lib/vat/eu-countries'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-accounts'
import type { WebshopCountryAccountRule, WebshopVatBreakdownLine } from '@/types'

/**
 * Account rules by destination country for webshop orders
 * (webshop_store_settings.country_account_rules).
 *
 * Why this exists: the line builder used to pick accounts from the VAT rate
 * alone, so a Danish or Norwegian order at 25 % booked as Swedish sales on
 * 3001 and Swedish output VAT on 2611 (rutor 05 and 10), and the bulk sweep
 * only stopped rates that are not Swedish. Shopify rows carry the country the
 * sale is taxed in (crm#1032): the destination of a goods order, the billing
 * country of an order with nothing to ship (#98). These rules turn country
 * plus rate into the accounts, and an order with nothing to ship books the
 * services account where a rule names a goods account (servicesRevenueAccountOf).
 *
 * Sweden takes one kind of rule, Swedish VAT on the store's own sales account
 * (crm#1449): a company that keeps its webshop sales apart from its other
 * business books them on e.g. 3011 instead of 3001. That Sverige row is the
 * store's Swedish booking, for every order the rules do not route abroad: one
 * shipped to Sweden and one without a country. No catch-all covers Sweden,
 * and without the row such orders keep the default Swedish accounts.
 *
 * One resolver for every door: buildOrderBookingLines() reads it, so the
 * single dialog prefill, the bulk sweep and the MCP/v1 suggestion all book an
 * order the same way. Shopify only: WooCommerce rows store the BILLING
 * country, which does not say where the goods went.
 */

/** Catch-all scope for every EU country without its own rule. */
export const COUNTRY_SCOPE_EU = 'EU'
/** Catch-all scope for every country outside the EU without its own rule. */
export const COUNTRY_SCOPE_NON_EU = 'NON_EU'
/** Sweden: its rule books with Swedish VAT ('swedish') and no catch-all covers it. */
export const COUNTRY_SWEDEN = 'SE'

/** OSS sales (SE: BAS 2026 3106 Försäljning varor till annat EU-land, momspliktig). */
export const OSS_REVENUE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'oss_sales')
/** OSS output VAT (SE: BAS 2026 2670 Utgående moms på försäljning inom EU, OSS). */
export const OSS_VAT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'oss_output_vat')
/** Export of goods (SE: BAS 2026 3105 Försäljning varor till land utanför EU, ruta 36). */
export const EXPORT_REVENUE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'export_goods_sales')

/**
 * The services account for each goods account of a sale taxed outside
 * Sweden, from the one treatment-to-account resolver (getRevenueAccount):
 * export 3105 (ruta 36) to 3305 Försäljning tjänster till land utanför EU
 * (ruta 40), EU 3108 (ruta 35) to 3308 Försäljning tjänster till annat
 * EU-land (ruta 39).
 */
const SERVICES_ACCOUNT_BY_GOODS_ACCOUNT: ReadonlyMap<string, string> = new Map(
  (['export', 'reverse_charge'] as const).map((treatment) => [
    getRevenueAccount(treatment, undefined, { goods: true }),
    getRevenueAccount(treatment, undefined, { goods: false }),
  ]),
)

/**
 * The accounts the presets name, and the services accounts an order with
 * nothing to ship books instead of a goods account a rule names. The
 * settings route adds a missing one to the chart (3106 with VAT code OSS, so
 * the momsdeklaration leaves it out), the same way
 * ensureWebshopPrefillAccounts repairs the Swedish prefill set.
 */
export const COUNTRY_PRESET_ACCOUNTS: readonly string[] = [
  OSS_REVENUE_ACCOUNT,
  OSS_VAT_ACCOUNT,
  EXPORT_REVENUE_ACCOUNT,
  ...SERVICES_ACCOUNT_BY_GOODS_ACCOUNT.values(),
]

/**
 * The account a rule's revenue account books an order with nothing to ship
 * on: the services account for a goods account of a sale abroad (3105 to
 * 3305, 3108 to 3308), any other account unchanged. A service sold to a
 * buyer outside Sweden is no export or EU supply of goods; it is declared as
 * a service taxed abroad (ruta 40, or ruta 39 for an EU business).
 */
export function servicesRevenueAccountOf(account: string): string {
  return SERVICES_ACCOUNT_BY_GOODS_ACCOUNT.get(account) ?? account
}

/**
 * "We report OSS": EU orders with VAT book on 3106/2670, outside the
 * momsdeklaration; VAT-free orders outside the EU book as export on 3105.
 * Norway through VOEC has no preset: its VAT is a debt to Norway on an
 * account the company picks (no default until our accountant confirms one).
 */
export const OSS_PRESET_RULES: readonly WebshopCountryAccountRule[] = [
  {
    country: COUNTRY_SCOPE_EU,
    vat_rate: null,
    mode: 'accounts',
    revenue_account: OSS_REVENUE_ACCOUNT,
    vat_account: OSS_VAT_ACCOUNT,
  },
  {
    country: COUNTRY_SCOPE_NON_EU,
    vat_rate: 0,
    mode: 'accounts',
    revenue_account: EXPORT_REVENUE_ACCOUNT,
    vat_account: null,
  },
]

/**
 * "We charge Swedish VAT on EU sales" (below the distance-selling threshold):
 * EU orders book like Swedish sales; VAT-free orders outside the EU as export.
 * A 'swedish' rule may name its own revenue account (a ruta 05 account, e.g.
 * one kept for EU consumer sales); the output VAT stays on the Swedish
 * account for the rate.
 */
export const NO_OSS_PRESET_RULES: readonly WebshopCountryAccountRule[] = [
  { country: COUNTRY_SCOPE_EU, vat_rate: null, mode: 'swedish' },
  {
    country: COUNTRY_SCOPE_NON_EU,
    vat_rate: 0,
    mode: 'accounts',
    revenue_account: EXPORT_REVENUE_ACCOUNT,
    vat_account: null,
  },
]

/** The Swedish VAT rates a 'swedish' rule may name (percent). */
export const SWEDISH_RULE_RATES: readonly number[] = [25, 12, 6, 0]

/** Rates are stored as percentages with at most two decimals (25.5). */
export function sameVatRate(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005
}

/** Whether the rule covers buckets that carry VAT (any rate, or one above 0 %). */
export function ruleCoversVat(rule: Pick<WebshopCountryAccountRule, 'vat_rate'>): boolean {
  return rule.vat_rate === null || rule.vat_rate > 0
}

/** The catch-all scope a country falls under when it has no rule of its own. */
export function countryScopeOf(country: string): string {
  return isEuMemberCountry(country) ? COUNTRY_SCOPE_EU : COUNTRY_SCOPE_NON_EU
}

/**
 * Whether a rule's country is another EU country or the EU catch-all. Not
 * Sweden, which isEuMemberCountry counts as a member: OSS and distance
 * selling are about sales to the other EU countries.
 */
export function isEuRuleCountry(country: string): boolean {
  return (
    country === COUNTRY_SCOPE_EU ||
    (country !== COUNTRY_SCOPE_NON_EU && country !== COUNTRY_SWEDEN && isEuMemberCountry(country))
  )
}

/** Whether a rule books OSS sales: an EU country or the EU catch-all, on buckets with VAT. */
export function isOssRule(rule: Pick<WebshopCountryAccountRule, 'country' | 'vat_rate'>): boolean {
  return isEuRuleCountry(rule.country) && ruleCoversVat(rule)
}

/**
 * The accounts the presets give a destination and rate: the OSS pair for an
 * EU destination with VAT, export (3105) outside the EU. Norway's VOEC VAT
 * account has no default (the company picks it), and a 0 % EU sale has none:
 * it is a different treatment (EU B2B) the user must name. Sweden has none
 * either: its rule books with Swedish VAT. The settings form starts a new row
 * from these, and a refused row's copy names one of them as the account to
 * use instead.
 */
export function presetAccountsFor(
  country: string,
  rate: number | null,
): { revenue: string | null; vat: string | null } {
  if (country === COUNTRY_SWEDEN) return { revenue: null, vat: null }
  if (isEuRuleCountry(country)) {
    return ruleCoversVat({ vat_rate: rate })
      ? { revenue: OSS_REVENUE_ACCOUNT, vat: OSS_VAT_ACCOUNT }
      : { revenue: null, vat: null }
  }
  return { revenue: EXPORT_REVENUE_ACCOUNT, vat: null }
}

/**
 * The account a refused rule's copy may name instead: the preset account for
 * the same field, and never the refused account itself. A 3106 whose VAT code
 * puts it in a ruta must not be told to use 3106. Null when there is no
 * account to name.
 */
export function alternativeAccountFor(
  rule: Pick<WebshopCountryAccountRule, 'country' | 'vat_rate'>,
  field: 'revenue_account' | 'vat_account',
  refused: string | undefined,
): string | null {
  const preset = presetAccountsFor(rule.country, rule.vat_rate)
  const account = field === 'revenue_account' ? preset.revenue : preset.vat
  return account && account !== refused ? account : null
}

/** One rule as a fixed tuple, so equal rules compare equal whatever their key order. */
function canonicalRule(rule: WebshopCountryAccountRule): string {
  return JSON.stringify(
    rule.mode === 'swedish'
      ? [rule.country, rule.vat_rate, rule.mode, rule.revenue_account || null]
      : [rule.country, rule.vat_rate, rule.mode, rule.revenue_account, rule.vat_account ?? null],
  )
}

/**
 * Whether two rule sets say the same thing, rule by rule in order. Not
 * JSON.stringify on the rules themselves: Postgres jsonb hands object keys
 * back sorted by length (mode, country, vat_rate, vat_account,
 * revenue_account), not in the order the form wrote them, so a stored set
 * never equalled the form's copy of it and the form always looked unsaved.
 */
export function sameCountryRules(
  a: readonly WebshopCountryAccountRule[],
  b: readonly WebshopCountryAccountRule[],
): boolean {
  return a.length === b.length && a.every((rule, i) => canonicalRule(rule) === canonicalRule(b[i]))
}

/**
 * The order fields the rules read. All optional: an order without a country
 * is simply never routed, and one without ships_nothing books as goods.
 */
export interface RoutableOrder {
  platform?: string | null
  customer_country?: string | null
  /** webshop_orders.ships_nothing: no line of the order needs shipping. */
  ships_nothing?: boolean | null
}

/**
 * The country the rules key on, or null when they do not apply: a Shopify
 * row (whose column is the destination country of a goods order, the billing
 * country of an order with nothing to ship) in a known country outside
 * Sweden. Orders to Sweden, without a country, or from another platform keep
 * the Swedish booking: the store's Sverige row for a Shopify order, see
 * routeOrderBuckets (an order without a country in a store with rules for
 * abroad is flagged: isDestinationUnknown).
 */
export function routedCountryOf(order: RoutableOrder): string | null {
  if (order.platform !== 'shopify') return null
  const country = order.customer_country?.trim().toUpperCase()
  if (!country || country === COUNTRY_SWEDEN) return null
  return country
}

/**
 * Whether a Shopify order has no destination country although its store has
 * saved country rules for abroad. The country is missing when the store
 * withholds addresses from the app (Shopify Basic, or protected customer data
 * not granted), for a local pickup of goods, and on rows synced before the
 * country was stored. A store with rules for abroad has told us it sells
 * abroad, so for it a missing country means unknown, not Sweden: the bulk
 * sweep refuses the order and the single dialog warns. A store without such
 * rules (none, or only a Sverige row) keeps the Swedish booking.
 */
export function isDestinationUnknown(
  order: RoutableOrder,
  rules: readonly WebshopCountryAccountRule[] | null | undefined,
): boolean {
  if (order.platform !== 'shopify') return false
  if (order.customer_country?.trim()) return false
  return (rules ?? []).some((rule) => rule.country !== COUNTRY_SWEDEN)
}

/**
 * The rule for one VAT bucket of an order shipped to `country`: the country's
 * own rule for that exact rate, then its rule for every rate with VAT, then
 * the same two steps on the EU / NON_EU catch-all, except for Sweden, which
 * only its own rule covers (the EU catch-all is the other EU countries). Null
 * when nothing covers it. A rule for "every rate" never covers a 0 % bucket:
 * a VAT-free sale abroad (EU B2B, export) is a different treatment and needs
 * its own rule.
 */
export function resolveCountryRule(
  rules: readonly WebshopCountryAccountRule[],
  country: string,
  rate: number,
): WebshopCountryAccountRule | null {
  const scopes = country === COUNTRY_SWEDEN ? [country] : [country, countryScopeOf(country)]
  for (const scope of scopes) {
    const scoped = rules.filter((rule) => rule.country === scope)
    const exact = scoped.find((rule) => rule.vat_rate !== null && sameVatRate(rule.vat_rate, rate))
    if (exact) return exact
    if (rate > 0) {
      const anyRate = scoped.find((rule) => rule.vat_rate === null)
      if (anyRate) return anyRate
    }
  }
  return null
}

export interface BucketRoute {
  bucket: WebshopVatBreakdownLine
  /**
   * The rule that books this bucket. Null means the Swedish accounts: an
   * order the rules do not apply to, or a bucket no rule covers.
   */
  rule: WebshopCountryAccountRule | null
}

export interface OrderRouting {
  /**
   * The destination the rules applied to: a country abroad, or Sweden when
   * the Sverige row books a bucket (an order to Sweden, or one without a
   * country, which books as Swedish); null when they do not apply.
   */
  country: string | null
  buckets: BucketRoute[]
  /**
   * Rates of the buckets no rule covers on an order the rules apply to. The
   * bulk sweep refuses such an order; the single dialog prefills those
   * buckets on the Swedish accounts for the user to change.
   */
  unroutedRates: number[]
  /**
   * isDestinationUnknown(): no country on an order whose store has rules.
   * Every bucket stays on the Swedish accounts, which the bulk sweep must
   * not book and the single dialog shows only as an editable prefill.
   */
  destinationUnknown: boolean
}

/**
 * Route every VAT bucket of an order through the store's country rules. A
 * rule without a VAT account does not cover a bucket that carries tax (a 0 %
 * rule meeting a bucket with VAT on it), so that bucket stays unrouted
 * rather than losing its VAT line. An order with nothing to ship books a
 * rule's goods account as the services account (servicesRevenueAccountOf).
 * An order the rules do not route abroad is never unrouted: a Shopify order
 * to Sweden or without a country books each bucket the store's Sverige row
 * covers on that row (for an order without a country in a store with rules
 * for abroad, an editable guess the bulk sweep refuses), the rest on the
 * default Swedish accounts.
 */
export function routeOrderBuckets(
  order: RoutableOrder,
  breakdown: readonly WebshopVatBreakdownLine[],
  rules: readonly WebshopCountryAccountRule[] | null | undefined,
): OrderRouting {
  const country = routedCountryOf(order)
  if (!country) {
    const shopify = order.platform === 'shopify'
    const buckets = breakdown.map((bucket) => {
      const rule = shopify ? resolveCountryRule(rules ?? [], COUNTRY_SWEDEN, bucket.rate) : null
      // A sale in Sweden always carries Swedish VAT: only a 'swedish' row books it.
      return { bucket, rule: rule?.mode === 'swedish' ? rule : null }
    })
    return {
      country: buckets.some((route) => route.rule) ? COUNTRY_SWEDEN : null,
      buckets,
      unroutedRates: [],
      destinationUnknown: isDestinationUnknown(order, rules),
    }
  }
  const unrouted = new Set<number>()
  const buckets = breakdown.map((bucket) => {
    let rule = resolveCountryRule(rules ?? [], country, bucket.rate)
    if (rule && rule.mode === 'accounts' && !rule.vat_account && bucket.tax !== 0) rule = null
    if (rule && rule.mode === 'accounts' && order.ships_nothing === true) {
      const revenue = servicesRevenueAccountOf(rule.revenue_account)
      if (revenue !== rule.revenue_account) rule = { ...rule, revenue_account: revenue }
    }
    if (!rule) unrouted.add(bucket.rate)
    return { bucket, rule }
  })
  return {
    country,
    buckets,
    unroutedRates: Array.from(unrouted).sort((a, b) => a - b),
    destinationUnknown: false,
  }
}

/**
 * Whether a routed bucket books like a Swedish sale: output VAT on the
 * Swedish account for its rate, which only a Swedish rate has.
 */
export function usesSwedishAccounts(route: BucketRoute): boolean {
  return route.rule === null || route.rule.mode === 'swedish'
}

/**
 * Whether a bucket's revenue line comes from the bulk revenue template (or
 * the default Swedish sales account): a Swedish-booked bucket whose 'swedish'
 * rule names no revenue account of its own.
 */
export function usesRevenueTemplate(route: BucketRoute): boolean {
  return route.rule === null || (route.rule.mode === 'swedish' && !route.rule.revenue_account)
}
