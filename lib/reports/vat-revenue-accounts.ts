import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ACCOUNT_TO_BOX } from '@/lib/vat/moms-box-mapping'

/**
 * Resolve which of a company's OWN revenue accounts belong in ruta 05
 * (momspliktig försäljning som inte ingår i någon annan ruta).
 *
 * ACCOUNT_RUTA is a fixed BAS whitelist and ruta 05 is literally 3001/3002/3003
 * there. That is only correct for a company that never touched its kontoplan:
 * the shipped BAS reference (lib/bookkeeping/bas-data/class-3-revenue.ts) has
 * no varugrupp accounts at all, so every 3011/3013/3041-style konto is added by
 * the user. Their revenue was not merely mapped to the wrong ruta, it was never
 * fetched from the ledger: ACCOUNT_RUTA's keys ARE the account filter passed to
 * get_vat_declaration_totals. Ruta 05 came out short and, because
 * runVatDeclarationChecks compares rutor 05-08 against 10-12, a perfectly
 * correct declaration got a blocking OUTPUT_VAT_WITHOUT_SALES error (#1261).
 *
 * The per-account "Standard moms" (chart_of_accounts.default_vat_rate) is the
 * primary resolver: a class 3 konto the user marked 25/12/6 % is by definition
 * domestic taxable sales, which is exactly what ruta 05 collects. For a
 * missing value, the narrow 30x1/30x2/30x3 convention is accepted only when
 * the account label explicitly confirms the same rate. This recovers imported
 * and older custom accounts without guessing from a number or free text alone.
 */

/**
 * Class 3 accounts that carry a moms-sats but belong in a DIFFERENT ruta, so
 * "has a rate" must not be read as "ruta 05". Per the SKV 4700 mapping in
 * .claude/skills/swedish-vat/references/vat-compliance-reference.md §7:
 *
 *   3211/3212/3220 → ruta 07 (vinstmarginalbeskattning)
 *   3913           → ruta 08 (hyresinkomster, frivillig skattskyldighet)
 *
 * Rutor 07 and 08 are not mappable yet (see the note in
 * vat-declaration-checks.ts). Until they are, these accounts stay out of the
 * declaration entirely: that understates one ruta, whereas sweeping them into
 * ruta 05 would file the amount in the wrong box.
 *
 * 3231/3232/3233 (ruta 41, omvänd skattskyldighet) used to sit here for the
 * same reason but are now statically mapped in ACCOUNT_RUTA/ACCOUNT_TO_BOX,
 * so the ACCOUNT_TO_BOX guard below excludes them from ruta 05.
 */
export const RUTA_05_EXCLUDED_ACCOUNTS = new Set([
  '3211', '3212', '3220',
  '3913',
])

/** VAT rates that mark a configured konto as momspliktig försäljning. */
const TAXABLE_RATES = [0.25, 0.12, 0.06]

const DOMESTIC_SALES_RATE_BY_SUFFIX: Record<string, number> = {
  '1': 0.25,
  '2': 0.12,
  '3': 0.06,
}

/**
 * Labels that contradict "momspliktig försäljning inom Sverige". Any hit vetoes
 * the fallback even when the suffix and a "25/12/6 % moms" label agree: a konto
 * named "momsfri", "omvänd betalningsskyldighet", VMB or export belongs in
 * ruta 07/08/35/36/41, and inferring a sats for it would file the amount in
 * ruta 05, i.e. in the wrong box. Omission is the safe failure here, so a
 * contradictory label falls back to today's behaviour instead of guessing.
 *
 * Only consulted for a MISSING rate. An explicitly configured value stays
 * authoritative and never reaches this check.
 *
 * The word boundaries are load-bearing, not decoration. "0 %" needs a leading
 * \b or it also matches the trailing zero of "10/20/30/100 %", vetoing a
 * perfectly ordinary "Försäljning varor 25 % moms, rabatt 30 %" and recreating
 * the #1261 omission this module exists to remove. "vmb" needs both boundaries
 * because three letters occur inside unrelated words. "export" and "utanför"
 * are matched as bare substrings on purpose, so Swedish compounds
 * ("exportförsäljning") are caught too; both are distinctive enough that a
 * false hit would have to be contrived.
 */
const CONTRADICTING_ACCOUNT_NAME =
  /momsfri|momsfritt|utan moms|omvänd|\bvmb\b|vinstmarginal|export|utanför|eu-land|unionsintern|\b0\s*%/i

/**
 * Resolve a missing rate for a company-specific domestic sales sub-account.
 *
 * Neither signal is sufficient by itself:
 *   - 3011 is not in the BAS 2026 catalog and custom numbers can be repurposed;
 *   - account labels are free text and can be stale or contradictory.
 *
 * Requiring the conventional 30x1/30x2/30x3 suffix and one matching explicit
 * "25/12/6 % moms" label keeps the fallback deterministic. A configured value,
 * including explicit 0 %, is always authoritative and never reaches here.
 *
 * Three ways this deliberately answers null:
 *   - the label states no sats, or states it without the word "moms"
 *     ("Försäljning konsult 25 %" is a margin or a share, not a moms-sats);
 *   - the label states two different sats, so neither can be trusted;
 *   - the label also carries a contradicting term (see above).
 */
function inferDomesticSalesRate(
  accountNumber: string,
  accountName: string | null | undefined,
): number | null {
  const accountMatch = /^30\d([123])$/.exec(accountNumber)
  if (!accountMatch) return null

  const name = accountName ?? ''
  if (CONTRADICTING_ACCOUNT_NAME.test(name)) return null

  const expectedRate = DOMESTIC_SALES_RATE_BY_SUFFIX[accountMatch[1]]
  const namedRates = new Set(
    [...name.matchAll(/\b(25|12|6)\s*%\s*moms\b/gi)].map(
      (match) => Number(match[1]) / 100,
    )
  )

  return namedRates.size === 1 && namedRates.has(expectedRate) ? expectedRate : null
}

/**
 * Ruta 05 accounts that ACCOUNT_TO_BOX already sums, but whose per-rate bucket
 * cannot be inferred from the account number.
 *
 * 3000 "Försäljning inom Sverige" is the BAS gruppkonto for the 30xx range. A
 * BAS-conformant company posts to 3001/3002/3003 and never to 3000, but a
 * company that does post to it has genuine domestic taxable sales, so ruta 05
 * stays the right box and the filed figure is already correct. What is missing
 * is only the rate split: unlike 3001/3002/3003 the number carries no sats, so
 * `breakdown.invoices.base25/12/6` would not add up to ruta 05.
 *
 * These accounts therefore contribute a RATE ONLY. Adding them to `accounts`
 * would double-count them, since ACCOUNT_TO_BOX already puts them in the sum.
 */
const RUTA_05_STATIC_RATE_ACCOUNTS = new Set(['3000'])

export interface DynamicRuta05Accounts {
  /** Accounts to add to the ledger fetch and to the ruta 05 sum. */
  accounts: string[]
  /** account_number → 0.25 | 0.12 | 0.06, for the per-rate base breakdown. */
  rateByAccount: Map<string, number>
  /**
   * Rates for accounts ALREADY counted in ruta 05 by the static map. Feeds the
   * base breakdown only, never the sum. Empty unless the user set a
   * "Standard moms" on one of RUTA_05_STATIC_RATE_ACCOUNTS.
   */
  staticRateByAccount: Map<string, number>
}

const EMPTY: DynamicRuta05Accounts = {
  accounts: [],
  rateByAccount: new Map(),
  staticRateByAccount: new Map(),
}

/**
 * Fetch the company-specific ruta 05 accounts.
 *
 * Excluded:
 *   - every account in ACCOUNT_TO_BOX. This covers all of ACCOUNT_RUTA (the
 *     alignment test in lib/vat/__tests__/moms-box-mapping.test.ts fails if the
 *     mirror ever stops being a superset) and additionally the accounts only
 *     the mirror maps (3106, 3109, 3521, 3522). Filtering on the superset alone
 *     keeps this module off vat-declaration.ts, which imports it.
 *
 *     This exclusion is what makes the BAS backfill safe: it sets 3001 = 25 %,
 *     and without it 3001 would be counted once by ACCOUNT_RUTA and once here,
 *     doubling ruta 05.
 *   - RUTA_05_EXCLUDED_ACCOUNTS above.
 *
 * The company_id filter is explicit rather than left to RLS:
 * calculateVatDeclaration is also reached from /api/v1/* on a service client,
 * which has no RLS.
 */
export async function fetchDynamicRuta05Accounts(
  supabase: SupabaseClient,
  companyId: string
): Promise<DynamicRuta05Accounts> {
  const rows = await fetchAllRows<{
    account_number: string
    account_name: string
    default_vat_rate: number | string | null
  }>(
    ({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, default_vat_rate')
        .eq('company_id', companyId)
        .eq('account_class', 3)
        // Deactivated accounts only. is_active is nullable (boolean DEFAULT
        // true, never made NOT NULL) and the accounts API treats only an
        // explicit false as deactivated, so `eq(true)` would silently drop a
        // NULL-flagged konto: the same kind of quiet omission this whole fix
        // exists to remove.
        .not('is_active', 'is', false)
        .order('account_number', { ascending: true })
        .range(from, to)
  )

  if (rows.length === 0) return EMPTY

  const accounts: string[] = []
  const rateByAccount = new Map<string, number>()
  const staticRateByAccount = new Map<string, number>()
  for (const row of rows) {
    const account = row.account_number
    const rate = row.default_vat_rate === null
      ? inferDomesticSalesRate(account, row.account_name)
      : Number(row.default_vat_rate)
    if (rate === null || !TAXABLE_RATES.includes(rate)) continue

    // Checked before the ACCOUNT_TO_BOX skip: these accounts ARE in that map,
    // which is precisely why they need the rate surfaced separately.
    if (RUTA_05_STATIC_RATE_ACCOUNTS.has(account)) {
      staticRateByAccount.set(account, rate)
      continue
    }

    if (ACCOUNT_TO_BOX[account]) continue
    if (RUTA_05_EXCLUDED_ACCOUNTS.has(account)) continue

    accounts.push(account)
    rateByAccount.set(account, rate)
  }

  return { accounts, rateByAccount, staticRateByAccount }
}
