/**
 * Momsdeklaration box mapping for Swedish VAT returns.
 *
 * Maps BAS revenue accounts to the correct box (ruta) in the
 * momsdeklaration filed with Skatteverket. Used by:
 * - Export VAT Monitor (full box overview)
 * - EU Sales List (cross-validation against box 35/39)
 *
 * Reference: Skatteverket momsdeklaration (SKV 4700)
 * https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen
 */

/** Momsdeklaration box number */
export type MomsBox =
  | '05'  // Momspliktig försäljning (taxable sales)
  | '06'  // Momspliktiga uttag (taxable withdrawals)
  | '07'  // Vinstmarginalbeskattning (margin scheme)
  | '08'  // Hyresinkomster frivillig beskattning (rental)
  | '10'  // Utgående moms 25%
  | '11'  // Utgående moms 12%
  | '12'  // Utgående moms 6%
  | '20'  // Inköp varor från EU
  | '21'  // Inköp tjänster från EU
  | '22'  // Inköp tjänster utanför EU
  | '23'  // Inköp varor Sverige omvänd skattskyldighet
  | '24'  // Inköp tjänster Sverige omvänd skattskyldighet
  | '30'  // Utgående moms inköp 25%
  | '31'  // Utgående moms inköp 12%
  | '32'  // Utgående moms inköp 6%
  | '35'  // Varuförsäljning till annat EU-land
  | '36'  // Varuförsäljning utanför EU (export)
  | '37'  // Mellanmans inköp trepartshandel
  | '38'  // Mellanmans försäljning trepartshandel
  | '39'  // Tjänsteförsäljning EU (huvudregeln)
  | '40'  // Övrig försäljning av tjänster utomlands
  | '41'  // Försäljning omvänd skattskyldighet Sverige
  | '42'  // Övrig försäljning m.m.
  | '48'  // Ingående moms att dra av
  | '49'  // Moms att betala eller få tillbaka
  | '50'  // Importbeskattningsunderlag
  | '60'  // Importmoms 25%
  | '61'  // Importmoms 12%
  | '62'  // Importmoms 6%

/** Which side of the account's balance a ruta reads. */
export type VatAccountSide = 'credit' | 'debit'

/**
 * The purchase type of a reverse-charge or import basis account (rutor
 * 20-24 and 50). Basis accounts come in threes, one per momssats.
 */
export type VatBasisKind =
  | 'eu_goods'           // ruta 20
  | 'eu_services'        // ruta 21
  | 'non_eu_services'    // ruta 22
  | 'domestic_goods'     // ruta 23
  | 'domestic_services'  // ruta 24
  | 'import'             // ruta 50

export type VatBasisRate = 0.25 | 0.12 | 0.06

export interface VatAccount {
  box: MomsBox
  side: VatAccountSide
  /** Basis accounts only: the purchase type and the momssats it books at. */
  basis?: { kind: VatBasisKind; rate: VatBasisRate }
  /**
   * false: labels the account with a ruta (Export VAT Monitor, EU Sales
   * List, voucher-line codes) but stays out of the momsdeklaration figures
   * and the settlement shape detector (ACCOUNT_RUTA in
   * lib/reports/vat-declaration.ts).
   */
  declared?: false
}

const credit = (box: MomsBox): VatAccount => ({ box, side: 'credit' })
const debit = (box: MomsBox): VatAccount => ({ box, side: 'debit' })
const basis = (box: MomsBox, kind: VatBasisKind, rate: VatBasisRate): VatAccount => ({
  box,
  side: 'debit',
  basis: { kind, rate },
})

/**
 * The BAS accounts Accounted maps to a momsdeklaration ruta (SKV 4700), the
 * one table. Everything else is derived from it: ACCOUNT_TO_BOX below,
 * ACCOUNT_RUTA and VAT_ACCOUNTS in lib/reports/vat-declaration.ts, the
 * reverse-charge basis sets in lib/bookkeeping/vat-entries.ts and
 * lib/reports/vat-filing-gate.ts, and the basis account per purchase type and
 * sats (vatBasisAccount). The mapping follows the BAS 2026 chart and
 * Skatteverket's BAS-to-ruta spec
 * (.claude/skills/swedish-vat/references/vat-compliance-reference.md §7, §8).
 *
 * A company's OWN class 3 accounts marked with a moms-sats join ruta 05 on
 * top of this list (fetchDynamicRuta05Accounts, #1261): this table only
 * covers the accounts Accounted itself seeds. Pure data, safe in the client.
 *
 * The vilande accounts (VILANDE_VAT_ACCOUNTS) are deliberately absent: their
 * moms is reported once it is moved to the ordinary account, never while it
 * rests (the reference above, §8: ruta "Transferred"). Mapped to the same
 * ruta as that account, the move nets to zero and the moms never reaches a
 * declaration (crm#1562).
 */
export const VAT_ACCOUNT_TABLE: Readonly<Record<string, VatAccount>> = {
  // Output VAT 25% → ruta 10
  '2610': credit('10'),  // Utgående moms 25% (summary/parent)
  '2611': credit('10'),  // Försäljning inom Sverige
  '2612': credit('10'),  // Egna uttag
  '2613': credit('10'),  // Uthyrning (frivillig skattskyldighet)
  '2616': credit('10'),  // Vinstmarginalbeskattning
  // Output VAT 12% → ruta 11
  '2620': credit('11'),  // Utgående moms 12% (summary/parent)
  '2621': credit('11'),
  '2622': credit('11'),  // Egna uttag
  '2623': credit('11'),  // Uthyrning
  '2626': credit('11'),  // VMB
  // Output VAT 6% → ruta 12
  '2630': credit('12'),  // Utgående moms 6% (summary/parent)
  '2631': credit('12'),
  '2632': credit('12'),  // Egna uttag
  '2633': credit('12'),  // Uthyrning
  '2636': credit('12'),  // VMB
  // Reverse charge output VAT → ruta 30/31/32
  '2614': credit('30'),
  '2624': credit('31'),
  '2634': credit('32'),
  // Input VAT → ruta 48
  '2640': debit('48'),   // Ingående moms (summary/parent)
  '2641': debit('48'),   // Debiterad ingående moms
  '2642': debit('48'),   // Frivillig skattskyldighet
  '2645': debit('48'),   // Förvärv utlandet (EU/non-EU RC)
  '2646': debit('48'),   // Uthyrning
  '2647': debit('48'),   // Omvänd skattskyldighet i Sverige
  '2649': debit('48'),   // Blandad verksamhet
  // Import VAT (since 2015, via momsdeklaration) → ruta 60/61/62
  '2615': credit('60'),  // Import 25%
  '2625': credit('61'),  // Import 12%
  '2635': credit('62'),  // Import 6%
  // Revenue: domestic taxable sales → ruta 05
  '3000': credit('05'),  // Försäljning inom Sverige (summary/parent)
  '3001': credit('05'),
  '3002': credit('05'),
  '3003': credit('05'),
  // Revenue: momspliktiga uttag → ruta 06
  '3401': credit('06'),
  '3402': credit('06'),
  '3403': credit('06'),
  // Revenue: rent under frivillig skattskyldighet → ruta 08. Its output VAT
  // is on 2613/2623/2633 (rutor 10-12). 3911/3912 (Hyres- and
  // Arrendeintäkter) stay out: they hold exempt rent too, so the account's
  // momskod decides their ruta.
  '3913': credit('08'),  // Frivilligt momspliktiga hyresintäkter
  // Revenue: EU goods/services → ruta 35/39
  '3108': credit('35'),  // Varuförsäljning till EU
  // Trepartshandel. A declared account here also widens p_ruta_accounts,
  // which is the settlement SHAPE detector: an entry touching one of them AND
  // 2650/1650 is classified a momsredovisning and dropped from the totals.
  // Accepted because the scheme carries no VAT, so such a voucher has no
  // reason to touch the clearing account, and every other revenue account in
  // this table already lives with the same rule.
  '3107': credit('38'),  // Mellanmans försäljning, trepartshandel
  '3308': credit('39'),  // Tjänsteförsäljning till EU
  // Revenue: export/other → ruta 36/40/42
  '3105': credit('36'),  // Varuförsäljning export
  '3305': credit('40'),  // Tjänsteförsäljning export
  '3004': credit('42'),  // Momsfri försäljning (AB)
  '3100': credit('42'),  // Momsfria intäkter (EF)
  '3404': credit('42'),  // Momsfria uttag
  '3980': credit('42'),  // Erhållna offentliga stöd m.m.
  '3994': credit('42'),  // Övriga rörelseintäkter momsfria
  // Revenue: omvänd skattskyldighet inom Sverige → ruta 41. The seller books
  // NO output VAT (the buyer accounts for it via rutor 23-24/30-32), so these
  // deliberately stay OUT of the ruta 05-08 vs 10-12 pairing checks.
  '3231': credit('41'),  // Försäljning byggsektorn, omvänd betalningsskyldighet
  '3232': credit('41'),  // Omvänd betalningsskyldighet, övriga (skrot m.m.)
  '3233': credit('41'),  // Omvänd betalningsskyldighet, övriga
  // Reverse-charge purchase bases (debit on cost accounts) → ruta 20-24, 50
  '4512': debit('37'),   // Mellanmans inköp, trepartshandel
  '4515': basis('20', 'eu_goods', 0.25),           // Inköp varor EU 25%
  '4516': basis('20', 'eu_goods', 0.12),           // Inköp varor EU 12%
  '4517': basis('20', 'eu_goods', 0.06),           // Inköp varor EU 6%
  '4535': basis('21', 'eu_services', 0.25),        // Inköp tjänster EU 25% (huvudregeln)
  '4536': basis('21', 'eu_services', 0.12),        // Inköp tjänster EU 12%
  '4537': basis('21', 'eu_services', 0.06),        // Inköp tjänster EU 6%
  '4531': basis('22', 'non_eu_services', 0.25),    // Inköp tjänster utanför EU 25%
  '4532': basis('22', 'non_eu_services', 0.12),    // Inköp tjänster utanför EU 12%
  '4533': basis('22', 'non_eu_services', 0.06),    // Inköp tjänster utanför EU 6%
  '4415': basis('23', 'domestic_goods', 0.25),     // Inköp varor SE omvänd skattskyldighet 25%
  '4416': basis('23', 'domestic_goods', 0.12),     // Inköp varor SE omvänd skattskyldighet 12%
  '4417': basis('23', 'domestic_goods', 0.06),     // Inköp varor SE omvänd skattskyldighet 6%
  '4425': basis('24', 'domestic_services', 0.25),  // Inköp tjänster SE omvänd skattskyldighet 25%
  '4426': basis('24', 'domestic_services', 0.12),  // Inköp tjänster SE omvänd skattskyldighet 12%
  '4427': basis('24', 'domestic_services', 0.06),  // Inköp tjänster SE omvänd skattskyldighet 6%
  '4545': basis('50', 'import', 0.25),             // Beskattningsunderlag import 25%
  '4546': basis('50', 'import', 0.12),             // Beskattningsunderlag import 12%
  '4547': basis('50', 'import', 0.06),             // Beskattningsunderlag import 6%
  // Labels only (declared: false): the frakter accounts follow the goods
  // treatment, and 3109 is the older trepartshandel sales account.
  '3521': { ...credit('35'), declared: false },  // Fakturerade frakter EU
  '3522': { ...credit('36'), declared: false },  // Fakturerade frakter export
  '3109': { ...credit('38'), declared: false },  // Mellanmans försäljning trepartshandel
}

/**
 * BAS account to momsdeklaration box, for every account in the table
 * (declared or label-only). The answer to "which moms box does this BAS
 * account contribute to?" for cross-validation (Export VAT Monitor, EU Sales
 * List) and any UI that labels a journal line by its declaration ruta.
 */
export const ACCOUNT_TO_BOX: Readonly<Record<string, MomsBox>> = Object.fromEntries(
  Object.entries(VAT_ACCOUNT_TABLE).map(([account, row]) => [account, row.box]),
)

const BASIS_ACCOUNTS: ReadonlyArray<{ account: string; kind: VatBasisKind; rate: VatBasisRate }> =
  Object.entries(VAT_ACCOUNT_TABLE).flatMap(([account, row]) => (row.basis ? [{ account, ...row.basis }] : []))

/**
 * The reverse-charge basis accounts (rutor 20-24), optionally at one sats:
 * every basis account except import (4545-4547, ruta 50), which is import
 * VAT, not reverse charge.
 */
export function reverseChargeBasisAccounts(rate?: VatBasisRate): string[] {
  return BASIS_ACCOUNTS
    .filter((b) => b.kind !== 'import' && (rate === undefined || b.rate === rate))
    .map((b) => b.account)
}

/** The import basis accounts (4545-4547, ruta 50): import VAT, not reverse charge. */
export function importBasisAccounts(): string[] {
  return BASIS_ACCOUNTS.filter((b) => b.kind === 'import').map((b) => b.account)
}

/** The basis account for a purchase type at a sats (EU goods at 12 % is 4516), or null for any other sats. */
export function vatBasisAccount(kind: VatBasisKind, rate: number): string | null {
  return BASIS_ACCOUNTS.find((b) => b.kind === kind && b.rate === rate)?.account ?? null
}

/** Swedish labels for each momsdeklaration box */
export const BOX_LABELS: Record<MomsBox, string> = {
  '05': 'Momspliktig försäljning',
  '06': 'Momspliktiga uttag',
  '07': 'Vinstmarginalbeskattning',
  '08': 'Hyresinkomster (frivillig beskattning)',
  '10': 'Utgående moms 25%',
  '11': 'Utgående moms 12%',
  '12': 'Utgående moms 6%',
  '20': 'Inköp varor från EU',
  '21': 'Inköp tjänster från EU',
  '22': 'Inköp tjänster utanför EU',
  '23': 'Inköp varor Sverige (omvänd skattskyldighet)',
  '24': 'Inköp tjänster Sverige (omvänd skattskyldighet)',
  '30': 'Utgående moms på inköp 25%',
  '31': 'Utgående moms på inköp 12%',
  '32': 'Utgående moms på inköp 6%',
  '35': 'Varuförsäljning till annat EU-land',
  '36': 'Varuförsäljning utanför EU (export)',
  '37': 'Mellanmans inköp vid trepartshandel',
  '38': 'Mellanmans försäljning vid trepartshandel',
  '39': 'Tjänsteförsäljning till EU (huvudregeln)',
  '40': 'Övrig försäljning av tjänster utomlands',
  '41': 'Försäljning med omvänd skattskyldighet (Sverige)',
  '42': 'Övrig försäljning m.m.',
  '48': 'Ingående moms att dra av',
  '49': 'Moms att betala eller få tillbaka',
  '50': 'Beskattningsunderlag vid import',
  '60': 'Importmoms 25%',
  '61': 'Importmoms 12%',
  '62': 'Importmoms 6%',
}

/** Get the momsdeklaration box for a BAS account number */
export function getBoxForAccount(accountNumber: string): MomsBox | undefined {
  return ACCOUNT_TO_BOX[accountNumber]
}

/**
 * BAS vilande moms: 2618/2628/2638 utgående, 2648 ingående. Moms that rests
 * until a later event (payment under kontantmetoden, a jämkning or
 * frivillig skattskyldighet being granted) and is declared when moved to
 * 2611/2621/2631/2641. No ruta reads the vilande account itself, so it is
 * not in VAT_ACCOUNT_TABLE and isDeclarationVatAccount leaves it out: a
 * period's flow on it is not moms the declaration misses.
 */
export const VILANDE_VAT_ACCOUNTS: ReadonlySet<string> = new Set(['2618', '2628', '2638', '2648'])

/**
 * The BAS moms accounts proper, the range a momsdeklaration ruta reads:
 * utgående moms 2610-2639 and ingående moms 2640-2649, less the vilande
 * accounts (VILANDE_VAT_ACCOUNTS). The rest of 26xx is
 * the redovisningskonto (2650-2659), punktskatter (2660-2669) and OSS
 * (2670-2679), which no ruta of the Swedish declaration reads. An account in
 * this range that is neither in VAT_ACCOUNT_TABLE nor given a momsruta of the
 * company's own carries moms the declaration leaves out
 * (VAT_ACCOUNT_WITHOUT_RUTA): typically 2617/2627/2637 or 2643/2644 from a
 * chart that predates BAS 2026.
 */
export function isDeclarationVatAccount(accountNumber: string): boolean {
  return /^26[1-4]\d$/.test(accountNumber) && !VILANDE_VAT_ACCOUNTS.has(accountNumber)
}

/**
 * What a line on this account says about a booking's VAT, as booking review
 * rules read it (lib/booking-review/match.ts vatClassesFromLines, accounted#130;
 * mirrored in SQL by public.booking_review_vat_classes, migration
 * 20261031150000): omvänd betalningsskyldighet or import of goods (the
 * utgående accounts per rate and the two reverse-charge ingående accounts),
 * utgående moms per rate, other ingående moms (its rate read off the
 * amounts), another 26xx account, or no VAT account at all.
 */
export type BookingVatRole = 'reverse_charge' | 'standard_25' | 'reduced_12' | 'reduced_6' | 'input' | 'other_vat' | 'not_vat'

const BOOKING_REVERSE_CHARGE_ACCOUNTS: ReadonlySet<string> = new Set([
  '2614', '2615', '2624', '2625', '2634', '2635', '2645', '2647',
])

export function bookingVatRole(accountNumber: string): BookingVatRole {
  if (BOOKING_REVERSE_CHARGE_ACCOUNTS.has(accountNumber)) return 'reverse_charge'
  if (/^261\d$/.test(accountNumber)) return 'standard_25'
  if (/^262\d$/.test(accountNumber)) return 'reduced_12'
  if (/^263\d$/.test(accountNumber)) return 'reduced_6'
  if (/^264\d$/.test(accountNumber)) return 'input'
  if (accountNumber.startsWith('26')) return 'other_vat'
  return 'not_vat'
}
