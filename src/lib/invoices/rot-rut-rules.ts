import { roundOre } from '@/lib/money'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import type { ArticleType, DeductionType } from '@/types'

export type { DeductionType } from '@/types'

/**
 * Skattereduktion rules: ROT/RUT-avdrag and skattereduktion för grön teknik.
 *
 * Implements the calculation and validation logic for Sweden's tax deduction
 * for household services (RUT), home renovation (ROT) and the installation of
 * green technology (grön teknik). As of 2026:
 *   - ROT: 30% of labor cost INCLUDING VAT, max 50 000 kr per person per year.
 *   - RUT: 50% of labor cost INCLUDING VAT, max 75 000 kr per person per year.
 *   - Grön teknik: 15% (solceller) or 50% (lagring av egenproducerad
 *     elenergi, laddningspunkt till elfordon) of the cost for arbete OCH
 *     material including VAT, max 50 000 kr per person per year, a ceiling of
 *     its own next to ROT/RUT (see GRON_TEKNIK_WORK_TYPES and GRON_TEKNIK_MAX).
 *
 * The base is inklusive moms: for ROT/RUT per HUSFL (2009:194) 6-9 §§, where
 * Skatteverkets own worked example is 18 000 kr arbetskostnad = 22 500 kr
 * inkl. moms (25%), ROT 30% = 6 750 kr; for grön teknik Skatteverket says
 * "Räkna ut skattereduktionen inklusive moms". Callers must therefore pass
 * the line's VAT rate; a missing/null rate is treated as 0% (momsfri labor),
 * where inkl. and exkl. coincide.
 *
 * ROT and RUT apply to labor only: material costs and travel time are NOT
 * eligible. Grön teknik applies to labor and material, but not to travel,
 * equipment, machinery or projektering. In both cases the user flags the
 * eligible lines and keeps everything else on unflagged lines: the entire
 * amount of a flagged invoice item is the base.
 *
 * We CAN'T verify that the customer has remaining yearly headroom (they may
 * have claimed elsewhere). We surface a warning when the per-invoice total
 * already exceeds the statutory max: the customer must then handle the
 * excess outside of fakturamodellen.
 *
 * All functions are pure and deterministic. No I/O, no DB calls: easy to
 * unit-test and easy to embed in the API validator and the live total
 * preview in the invoice editor.
 */

/** Percentage of eligible amount deducted for ROT (renovation). 2026 rule. */
export const ROT_PERCENT = 0.30

/** Percentage of eligible amount deducted for RUT (household services). 2026 rule. */
export const RUT_PERCENT = 0.50

/**
 * Maximum yearly ROT deduction per person. 2026 rule.
 *
 * SEK. The statutory ceiling is a kronor amount, so it may only ever be
 * compared against a SEK figure: an invoice-currency total must go through
 * `deductionToSek()` first.
 */
export const ROT_MAX = 50000

/** Maximum yearly RUT deduction per person. SEK, same caveat as ROT_MAX. 2026 rule. */
export const RUT_MAX = 75000

/**
 * ROT and RUT share one yearly ceiling per person: 75 000 kr in total, with
 * ROT capped at 50 000 kr inside it (the 2024 H2 separation was temporary).
 * SEK, same caveat as ROT_MAX. Grön teknik is NOT part of it.
 */
export const COMBINED_MAX = 75000

/**
 * Maximum yearly grön teknik reduction per person, SEK (same caveat as
 * ROT_MAX). A ceiling of its own that shares no headroom with ROT/RUT:
 * Skatteverket, "Så fungerar skattereduktionen för grön teknik" (företag,
 * checked 2026-09-30): "Dina kunder kan få skattereduktion för grön teknik
 * med högst 50 000 kronor per person och år" and "Din kund kan utöver
 * skattereduktion för grön teknik om 50 000 kr per år även få rot- och
 * rutavdrag för andra arbeten med upp till 75 000 kr per år". 2026 rule.
 */
export const GRON_TEKNIK_MAX = 50000

/**
 * Every kind an invoice line can carry: the runtime twin of DeductionType
 * (Zod enums, pickers). Listed in the order the UI offers them.
 */
export const DEDUCTION_TYPES = ['rot', 'rut', 'gron_teknik'] as const satisfies readonly DeductionType[]

/**
 * The kinds Skatteverkets husavdragstjänst handles (HUS, Begaran.xsd V6,
 * e-tjänst "Rot och rut: företag"). Grön teknik is a separate skattereduktion
 * with its own e-tjänst and its own file format (Begaran V1, TypAvBegaran
 * GRON_TEKNIK), so every HUS-file surface takes this narrower type.
 */
export type HusDeductionType = Exclude<DeductionType, 'gron_teknik'>
export const HUS_DEDUCTION_TYPES = ['rot', 'rut'] as const satisfies readonly HusDeductionType[]

export function isDeductionType(value: unknown): value is DeductionType {
  return typeof value === 'string' && (DEDUCTION_TYPES as readonly string[]).includes(value)
}

/**
 * Statutory Swedish labels per kind: ledger text, blocker and warning
 * messages, and Swedish-only surfaces. A Record, so adding a kind is a
 * compile error until it is labelled here, instead of a binary
 * `kind === 'rot' ? 'ROT' : 'RUT'` silently calling the new kind RUT.
 * UI chrome translates through the `invoices` messages instead
 * (DEDUCTION_TYPE_LABEL_KEYS).
 */
export const DEDUCTION_TYPE_LABELS: Record<DeductionType, {
  /** Standalone name, at the start of a label: 'ROT', 'RUT', 'Grön teknik'. */
  short: string
  /** Start of a 1513 line text: '<ledger> faktura 12'. */
  ledger: string
  /** The same inside a sentence: 'Utbetalning <noun> från Skatteverket'. */
  noun: string
  /** A refused share (reclaim voucher): '<refused> faktura 12'. */
  refused: string
  /** Subject of the yearly-ceiling warning: '<capSubject> på denna faktura (...)'. */
  capSubject: string
}> = {
  rot: {
    short: 'ROT',
    ledger: 'ROT-avdrag',
    noun: 'ROT-avdrag',
    refused: 'Nekat ROT-avdrag',
    capSubject: 'ROT-avdraget',
  },
  rut: {
    short: 'RUT',
    ledger: 'RUT-avdrag',
    noun: 'RUT-avdrag',
    refused: 'Nekat RUT-avdrag',
    capSubject: 'RUT-avdraget',
  },
  gron_teknik: {
    short: 'Grön teknik',
    ledger: 'Skattereduktion grön teknik',
    noun: 'skattereduktion grön teknik',
    refused: 'Nekad skattereduktion grön teknik',
    capSubject: 'Skattereduktionen för grön teknik',
  },
}

/** Message keys (namespace `invoices`) for the kind's name in UI chrome. */
export const DEDUCTION_TYPE_LABEL_KEYS: Record<
  DeductionType,
  'rot_rut_type_rot' | 'rot_rut_type_rut' | 'rot_rut_type_gron_teknik'
> = {
  rot: 'rot_rut_type_rot',
  rut: 'rot_rut_type_rut',
  gron_teknik: 'rot_rut_type_gron_teknik',
}

/**
 * The distinct deduction kinds among `items`, in DEDUCTION_TYPES order.
 * Unknown values (legacy garbage the CHECK constraint never let through)
 * are ignored.
 */
export function deductionKindsOf(
  items: ReadonlyArray<{ deduction_type?: string | null }>,
): DeductionType[] {
  const present = new Set(items.map((item) => item.deduction_type).filter(isDeductionType))
  return DEDUCTION_TYPES.filter((kind) => present.has(kind))
}

/**
 * The invoice's money context: what currency its amounts are denominated in
 * and the booking rate that turns them into kronor.
 */
export interface DeductionCurrencyContext {
  /** ISO 4217 code of the invoice. Missing/null is treated as SEK. */
  currency?: string | null
  /** SEK per unit of `currency`. Required as soon as `currency` isn't SEK. */
  exchangeRate?: number | null
}

/**
 * Build the invoice-currency → SEK converter for a deduction context, or
 * null when the invoice is in a foreign currency and carries no usable
 * booking rate.
 *
 * The conversion is the SAME one the ledger leg applies before it debits BAS
 * 1513 (`generateRotRutLines` in lib/bookkeeping/invoice-entries.ts): per
 * amount, `Math.round(amount * rate * 100) / 100`. Sharing it is what keeps
 * the begäran om utbetalning and the 1513 receivable from disagreeing about
 * what the Skatteverket claim is worth.
 *
 * A null return means "cannot be expressed in kronor". Callers must then
 * refuse to compare or emit: substituting the raw foreign number for a kronor
 * amount is how a 625 EUR deduction ends up being asked for as "625 kr"
 * against a 7 125 kr receivable that can never clear.
 */
export function deductionSekConverter(
  money?: DeductionCurrencyContext,
): ((amount: number) => number) | null {
  const currency = (money?.currency ?? 'SEK').toUpperCase()
  if (currency === 'SEK') return (amount) => amount
  const rate = money?.exchangeRate
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
  return (amount) => Math.round(amount * rate * 100) / 100
}

/**
 * One-shot form of `deductionSekConverter`: null on the same "foreign
 * currency, no usable booking rate" condition.
 */
export function deductionToSek(
  amount: number,
  money?: DeductionCurrencyContext,
): number | null {
  const toSek = deductionSekConverter(money)
  return toSek ? toSek(amount) : null
}

/** Skatteverket work codes used by Husavdragstjänsten. Maps a free-text */
/** "what the worker did" label to the official code. The code drives which */
/** element the begäran-om-utbetalning file (Begaran.xsd V6) reports the */
/** hours under: see WORK_TYPE_ELEMENTS in lib/invoices/rot-rut-file.ts. */
/** The lists mirror the XSD exactly: rot work types are the seven */
/** ArendeUtfortArbeteRotTYPE elements (IT-tjänster is a RUT service and was */
/** removed from the rot list 2026-07); rut covers all thirteen */
/** ArendeUtfortArbeteRutTYPE elements incl. the two schablontjänster. */
export const ROT_WORK_TYPES = [
  { code: 'BYGG', label: 'Byggnadsarbete' },
  { code: 'EL', label: 'Elarbete' },
  { code: 'GLAS_PLAT', label: 'Glas- och plåtarbete' },
  { code: 'MARK_DRAN', label: 'Mark- och dräneringsarbete' },
  { code: 'MURNING', label: 'Murnings- och putsarbete' },
  { code: 'MALNING', label: 'Mål- och tapetseringsarbete' },
  { code: 'VVS', label: 'VVS-arbete' },
] as const

export const RUT_WORK_TYPES = [
  { code: 'STAD', label: 'Städning' },
  { code: 'KLAD', label: 'Kläd- och textilvård' },
  { code: 'SNOSKOTTNING', label: 'Snöskottning' },
  { code: 'TRADGARD', label: 'Trädgårdsarbete' },
  { code: 'BARNPASS', label: 'Barnpassning' },
  { code: 'PERSONLIG_OMS', label: 'Personlig omsorg' },
  { code: 'FLYTT', label: 'Flyttjänster' },
  { code: 'IT', label: 'IT-tjänster i hemmet' },
  { code: 'REPARATION', label: 'Reparation av vitvaror' },
  { code: 'MOBLERING', label: 'Möblering' },
  { code: 'TILLSYN', label: 'Tillsyn av bostad' },
  // Schablontjänster: reported as utförd/ej utförd in the Skatteverket file,
  // never with hours or material.
  { code: 'TRANSPORT', label: 'Transport till försäljning (schablon)' },
  { code: 'TVATT', label: 'Tvätt vid tvättinrättning (schablon)' },
] as const

/**
 * Skattereduktion för grön teknik: the three installation types, each with
 * its own rate. The codes are Skatteverkets TypAvUtfortArbete values for
 * TypAvBegaran GRON_TEKNIK (Begaran.xsd V1: "Giltiga värden när GRON_TEKNIK
 * valts: [INSTALLATION_LADDPUNKT, INSTALLATION_LAGRING,
 * INSTALLATION_SOLCELLER]"). Rates per Skatteverket, "Så fungerar
 * skattereduktionen för grön teknik" (företag, checked 2026-09-30):
 * "Skattereduktion för installationen beräknas sedan till 15 procent för
 * solceller och till 50 procent för system för lagring och för
 * laddningspunkter", of "kostnaden för arbete och material", inklusive moms.
 * Not date-versioned, the same as ROT_PERCENT / RUT_PERCENT (2026 rule).
 * Unlike ROT/RUT, the rate follows the work type, not the kind: see
 * deductionPercent.
 */
export const GRON_TEKNIK_WORK_TYPES = [
  { code: 'INSTALLATION_SOLCELLER', label: 'Installation av solceller', percent: 0.15 },
  {
    code: 'INSTALLATION_LAGRING',
    label: 'Installation av system för lagring av egenproducerad elenergi',
    percent: 0.50,
  },
  { code: 'INSTALLATION_LADDPUNKT', label: 'Installation av laddningspunkt till elfordon', percent: 0.50 },
] as const

/** The grön teknik installation type for a code, or null for anything else. */
export function gronTeknikWorkType(
  code: string | null | undefined,
): (typeof GRON_TEKNIK_WORK_TYPES)[number] | null {
  const trimmed = code?.trim()
  if (!trimmed) return null
  return GRON_TEKNIK_WORK_TYPES.find((w) => w.code === trimmed) ?? null
}

/**
 * The share of the line total (inkl. moms) a deduction line gets, or null
 * when the line cannot carry one. ROT and RUT take the kind's rate whatever
 * the work type (identical to the rates before grön teknik existed); grön
 * teknik takes its installation type's rate, so a grön teknik line without a
 * valid installation type has no rate at all. A Record, so a new kind cannot
 * silently inherit another kind's rate.
 */
const PERCENT_BY_KIND: Record<DeductionType, (workType: string | null | undefined) => number | null> = {
  rot: () => ROT_PERCENT,
  rut: () => RUT_PERCENT,
  gron_teknik: (workType) => gronTeknikWorkType(workType)?.percent ?? null,
}

export function deductionPercent(
  type: DeductionType | null | undefined,
  workType: string | null | undefined,
): number | null {
  if (!type) return null
  const resolve = (PERCENT_BY_KIND as Partial<Record<string, (w: string | null | undefined) => number | null>>)[type]
  return resolve ? resolve(workType) : null
}

/**
 * Which deduction kind a Skatteverket work-type code belongs to. The code
 * lists are disjoint, so the code alone decides ROT vs RUT vs grön teknik:
 * this is what lets an article's housework_type pre-fill both the invoice
 * line's work_type and its deduction_type. Unknown or absent codes map to
 * null (no deduction).
 */
export function deductionTypeForWorkType(code: string | null | undefined): DeductionType | null {
  if (!code) return null
  if (ROT_WORK_TYPES.some((w) => w.code === code)) return 'rot'
  if (RUT_WORK_TYPES.some((w) => w.code === code)) return 'rut'
  if (GRON_TEKNIK_WORK_TYPES.some((w) => w.code === code)) return 'gron_teknik'
  return null
}

/** Human label for a Skatteverket work-type code, or null for unknown codes. */
export function workTypeLabel(code: string | null | undefined): string | null {
  const trimmed = code?.trim()
  if (!trimmed) return null
  const hit = [...ROT_WORK_TYPES, ...RUT_WORK_TYPES, ...GRON_TEKNIK_WORK_TYPES].find((w) => w.code === trimmed)
  return hit ? hit.label : null
}

/**
 * The two vocabularies `articles.housework_type` has been written in:
 * - a Skatteverket work-type code (`BYGG`, `STAD`, `INSTALLATION_SOLCELLER`,
 *   ...): the intended value, decides both the deduction kind and the line's
 *   arbetstyp;
 * - the bare kind `ROT` / `RUT`: what the article form stored before it
 *   offered real work types (legacy rows), decides the kind only. There is no
 *   bare grön teknik kind: its rate needs the installation type.
 * Anything else (free text, `0`/`1` from a mis-mapped CSV column) is not a
 * housework flag at all and normalizes to null.
 */
export interface ArticleHousework {
  deductionType: DeductionType | null
  /** Skatteverket work-type code, or null when only the kind is known. */
  workType: string | null
}

export function parseArticleHouseworkType(value: string | null | undefined): ArticleHousework {
  const raw = value?.trim().toUpperCase() ?? ''
  if (!raw) return { deductionType: null, workType: null }
  const kindFromCode = deductionTypeForWorkType(raw)
  if (kindFromCode) return { deductionType: kindFromCode, workType: raw }
  if (raw === 'ROT' || raw === 'RUT') return { deductionType: raw.toLowerCase() as DeductionType, workType: null }
  return { deductionType: null, workType: null }
}

/**
 * The deduction an article pre-fills onto an invoice line when it is picked.
 *
 * ROT and RUT are computed on arbetskostnaden only (IL 67 kap. 11-19 §§,
 * HUSFL 2009:194): material, travel and machine hire never carry the
 * reduction. A goods article (`vara`) therefore pre-fills no ROT/RUT
 * deduction, whatever its housework_type says. The article form already hides
 * and clears the ROT/RUT codes for goods, but rows written by a file import or
 * an older writer can still carry a flag nobody can see; this is the one
 * place that turns the flag into a claim, so it is the one place that has to
 * refuse it.
 *
 * Grön teknik is the exception: Skatteverket gives it "för kostnaden för
 * arbete och material", so the solar panels, the battery or the charger
 * installed are part of the base and a goods article with an installation
 * type does pre-fill it.
 */
export function articleDeductionPrefill(article: {
  type?: ArticleType | null
  housework_type?: string | null
}): ArticleHousework {
  const parsed = parseArticleHouseworkType(article.housework_type)
  if (article.type === 'vara' && parsed.deductionType !== 'gron_teknik') {
    return { deductionType: null, workType: null }
  }
  return parsed
}

/**
 * Canonical stored form of a housework_type input: the work-type code, the
 * bare kind (`ROT`/`RUT`), or null. Case-insensitive; unknown values are
 * null so the column never accumulates a third vocabulary again.
 */
export function normalizeHouseworkType(value: string | null | undefined): string | null {
  const parsed = parseArticleHouseworkType(value)
  if (parsed.workType) return parsed.workType
  if (parsed.deductionType) return parsed.deductionType.toUpperCase()
  return null
}

/**
 * Husarbete (ROT/RUT) housework_type values: every HUS work-type code plus
 * the bare kinds.
 */
export const HOUSEWORK_TYPE_VALUES: readonly string[] = [
  'ROT',
  'RUT',
  ...ROT_WORK_TYPES.map((w) => w.code),
  ...RUT_WORK_TYPES.map((w) => w.code),
]

/**
 * Everything `articles.housework_type` accepts: the husarbete vocabulary plus
 * the grön teknik installation types (valid on goods too, see
 * articleDeductionPrefill). The column name predates grön teknik and is kept
 * for wire stability.
 */
export const ARTICLE_HOUSEWORK_TYPE_VALUES: readonly string[] = [
  ...HOUSEWORK_TYPE_VALUES,
  ...GRON_TEKNIK_WORK_TYPES.map((w) => w.code),
]

interface DeductionLineBase {
  /** Unit price (per `quantity`). Same field as invoice_items.unit_price. */
  unit_price: number
  /** Quantity. Same field as invoice_items.quantity. */
  quantity: number
  /**
   * Percentage discount on the line (0-100), invoice_items.discount_percent.
   * The deduction base is the amount the customer actually pays, so a
   * discounted line deducts on the NET line total. Omitted/null = 0.
   */
  discount_percent?: number | null
  /**
   * The line's VAT rate in percent (25, 12, 6, 0). The statutory deduction
   * base is the cost INCLUDING VAT (HUSFL 6-9 §§; Skatteverket for grön
   * teknik), so every caller that knows the rate must pass it. null/undefined
   * means 0% (momsfri labor), where inkl. and exkl. moms coincide.
   */
  vat_rate?: number | null
  /**
   * Arbetstimmar on the line. Validated (validateDeductionLines) and reported
   * in the begäran; the amount is always the full line total, never hours ×
   * rate.
   */
  labor_hours?: number | null
}

/**
 * One invoice line as the deduction math reads it.
 *
 * A discriminated union on purpose: a grön teknik line's rate comes from its
 * installation type, so `work_type` is a REQUIRED key whenever the line can be
 * grön teknik. A call site that passes a widened DeductionType and forgets
 * work_type would deduct 0 on 1513 while the header says 15 or 50 %, and the
 * customer's 1510 would never clear; the union turns that omission into a
 * compile error at the call site. ROT/RUT-only literals (the kind's rate,
 * whatever the work type) keep work_type optional.
 */
export type ItemForDeduction = DeductionLineBase & (
  | {
      /** 'rot' | 'rut' | null. Drives whether the deduction kicks in at all. */
      deduction_type?: HusDeductionType | null
      /** Skatteverket arbetstypskod (ROT_WORK_TYPES / RUT_WORK_TYPES). */
      work_type?: string | null
    }
  | {
      deduction_type: 'gron_teknik'
      /** GRON_TEKNIK_WORK_TYPES code: decides the rate. */
      work_type: string | null | undefined
    }
)

/**
 * Compute the deduction amount for a single invoice item. Returns 0 when
 * the item has no deduction_type, or no rate (a grön teknik line without a
 * valid installation type: validation refuses it at creation, and the header
 * total and the 1513 debit both come from this function, so they agree on
 * the 0). The base is the line total INCLUDING VAT (HUSFL 6-9 §§: 30% av
 * arbetskostnaden inklusive moms for ROT, 50% for RUT; 15 or 50 % of arbete
 * och material inklusive moms for grön teknik). The per-line VAT is
 * reproduced with the exact rounding the write path stores on
 * invoice_items.vat_amount (Math.round(lineTotal * rate / 100 * 100) / 100
 * in build-invoice-write.ts), so the deduction and the stored VAT can never
 * disagree by an öre. The result is always >= 0 and <= line total incl. VAT
 * (no over-deduction even if percentages are tweaked).
 */
export function computeDeduction(item: ItemForDeduction): number {
  if (!item.deduction_type) return 0
  const percent = deductionPercent(item.deduction_type, item.work_type)
  if (percent === null) return 0
  // Net of any line discount: the deduction follows what the customer pays.
  const lineTotal = computeLineNet(item.quantity, item.unit_price, item.discount_percent)
  if (lineTotal <= 0) return 0
  const rate = item.vat_rate ?? 0
  const lineVat = rate > 0 ? Math.round(lineTotal * rate / 100 * 100) / 100 : 0
  const lineTotalInclVat = lineTotal + lineVat
  const raw = lineTotalInclVat * percent
  // Cap at line total incl. VAT: defensive against future rule changes that
  // would push percent past 1.0.
  const capped = Math.min(raw, lineTotalInclVat)
  return Math.round(capped * 100) / 100
}

/**
 * Sum the per-item deduction over an invoice. Returns the total to store
 * on invoices.deduction_total and to use as the 1513 debit amount.
 */
export function computeInvoiceDeductionTotal(items: ItemForDeduction[]): number {
  let total = 0
  for (const item of items) {
    total += computeDeduction(item)
  }
  return Math.round(total * 100) / 100
}

/**
 * Per-kind deduction totals, in invoice currency. `gron_teknik` is present
 * only when the items carry a grön teknik line, so a ROT/RUT invoice keeps
 * exactly the shape it always had.
 */
export interface DeductionTotalsByKind {
  rot: number
  rut: number
  gron_teknik?: number
}

/**
 * Sum per deduction kind. Used to surface separate cap warnings.
 */
export function computeDeductionTotalsByKind(items: ItemForDeduction[]): DeductionTotalsByKind {
  let rot = 0
  let rut = 0
  let gronTeknik: number | null = null
  for (const item of items) {
    const amount = computeDeduction(item)
    if (item.deduction_type === 'rot') rot += amount
    else if (item.deduction_type === 'rut') rut += amount
    else if (item.deduction_type === 'gron_teknik') gronTeknik = (gronTeknik ?? 0) + amount
  }
  const totals: DeductionTotalsByKind = {
    rot: Math.round(rot * 100) / 100,
    rut: Math.round(rut * 100) / 100,
  }
  if (gronTeknik !== null) totals.gron_teknik = roundOre(gronTeknik)
  return totals
}

export type ValidateInvoiceItem = ItemForDeduction & {
  housing_designation?: string | null
}

/**
 * Schablontjänster are reported to Skatteverket as utförd/ej utförd, never
 * with hours, so they are the one case where labor_hours is not required.
 */
export const SCHABLON_WORK_TYPES: readonly string[] = ['TRANSPORT', 'TVATT']

export const DEDUCTION_LINE_ERRORS = {
  workTypeMissing: 'Arbetstyp krävs på alla ROT/RUT-rader.',
  workTypeMismatch: 'Arbetstypen på raden hör inte till vald skattereduktion (ROT/RUT).',
  hoursMissing: 'Antal arbetstimmar krävs på ROT/RUT-rader (schablontjänster undantagna).',
  gronTeknikWorkTypeMissing:
    'Typ av installation krävs på alla rader med skattereduktion för grön teknik.',
  gronTeknikWorkTypeMismatch:
    'Typen av installation hör inte till grön teknik: välj solceller, lagring av egenproducerad elenergi eller laddningspunkt till elfordon.',
  gronTeknikHoursMissing:
    'Antal arbetstimmar krävs på minst en rad per typ av installation (grön teknik). Materialrader kan lämnas utan timmar. Säljs bara material ges ingen skattereduktion: ta bort grön teknik från raden.',
  gronTeknikMixed:
    'Grön teknik kan inte kombineras med ROT- eller RUT-rader på samma faktura: Skatteverket prövar dem i olika e-tjänster och ger inte båda för samma arbete. Dela upp i separata fakturor.',
} as const

/** Invoice-level grön teknik prerequisites (validateInvoice). */
export const GRON_TEKNIK_INVOICE_ERRORS = {
  personnummerMissing: 'Personnummer krävs för skattereduktion för grön teknik.',
  propertyMissing:
    'Fastighetsbeteckning, eller lägenhetsnummer och bostadsrättsföreningens organisationsnummer, krävs för skattereduktion för grön teknik.',
} as const

function hasPositiveHours(hours: number | null | undefined): boolean {
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0
}

export type DeductionLineIssueCode = keyof typeof DEDUCTION_LINE_ERRORS

/** One claim-completeness problem, anchored on a line and field for the UI. */
export interface DeductionLineIssue {
  /** Index into the items passed in. */
  index: number
  field: 'work_type' | 'labor_hours' | 'deduction_type'
  code: DeductionLineIssueCode
}

/** The line fields claim completeness reads. */
export interface DeductionLineShape {
  line_type?: string | null
  deduction_type?: string | null
  work_type?: string | null
  labor_hours?: number | null
}

/**
 * Per-line claim completeness: what the begäran om utbetalning to Skatteverket
 * needs from every deduction line (HUSFL 2009:194: art av arbete och antal
 * arbetstimmar). Checked at invoice creation because that is the last moment
 * the line is editable: once the invoice is numbered, booked and paid, a
 * missing arbetstyp used to surface only as a file-generation blocker with
 * no repair path short of a credit note.
 *
 * Grön teknik flags labour AND material rows, so its hours are required per
 * installation type, not per row: Skatteverket's e-tjänst demands "Antal
 * arbetade timmar ... för minst en installation" (actual hours even at a
 * fixed price), and the begäran reports one hour figure per installation
 * type. A material row may therefore leave hours empty as long as a row of
 * the same installation type carries them (the issue anchors on the type's
 * first row). Grön teknik cannot share an invoice with ROT/RUT
 * ("Skattereduktion för grön teknik och rotavdrag kan inte ges för samma
 * arbete", and each kind is requested in its own e-tjänst, while one invoice
 * holds one 1513 claim).
 *
 * The one definition behind validateDeductionLines (server write paths, MCP
 * staging), the API schema's field-level issues and the invoice editor.
 * Free-text rows carry no claim and are skipped.
 */
export function deductionLineIssues(items: ReadonlyArray<DeductionLineShape>): DeductionLineIssue[] {
  const issues: DeductionLineIssue[] = []
  const gronTeknikTypes = new Map<string, { firstIndex: number; hours: number }>()
  let firstGronTeknikIndex: number | null = null
  let hasHus = false
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (!item.deduction_type || item.line_type === 'text') continue
    const workType = item.work_type?.trim() || null
    if (item.deduction_type === 'gron_teknik') {
      if (firstGronTeknikIndex === null) firstGronTeknikIndex = index
      if (!workType) {
        issues.push({ index, field: 'work_type', code: 'gronTeknikWorkTypeMissing' })
      } else if (deductionTypeForWorkType(workType) !== 'gron_teknik') {
        issues.push({ index, field: 'work_type', code: 'gronTeknikWorkTypeMismatch' })
      } else {
        const entry = gronTeknikTypes.get(workType) ?? { firstIndex: index, hours: 0 }
        if (hasPositiveHours(item.labor_hours)) entry.hours += item.labor_hours as number
        gronTeknikTypes.set(workType, entry)
      }
      continue
    }
    hasHus = true
    if (!workType) {
      issues.push({ index, field: 'work_type', code: 'workTypeMissing' })
    } else if (deductionTypeForWorkType(workType) !== item.deduction_type) {
      issues.push({ index, field: 'work_type', code: 'workTypeMismatch' })
    }
    const isSchablon = workType != null && SCHABLON_WORK_TYPES.includes(workType)
    if (!isSchablon && !hasPositiveHours(item.labor_hours)) {
      issues.push({ index, field: 'labor_hours', code: 'hoursMissing' })
    }
  }
  for (const entry of gronTeknikTypes.values()) {
    if (!(entry.hours > 0)) issues.push({ index: entry.firstIndex, field: 'labor_hours', code: 'gronTeknikHoursMissing' })
  }
  if (firstGronTeknikIndex !== null && hasHus) {
    issues.push({ index: firstGronTeknikIndex, field: 'deduction_type', code: 'gronTeknikMixed' })
  }
  return issues
}

/**
 * The claim-completeness errors for an invoice's lines as Swedish messages,
 * each at most once (see deductionLineIssues for the rules).
 */
export function validateDeductionLines(items: ValidateInvoiceItem[]): string[] {
  return [...new Set(deductionLineIssues(items).map((issue) => DEDUCTION_LINE_ERRORS[issue.code]))]
}

export interface ValidationResult {
  errors: string[]
  warnings: string[]
}

/**
 * Validate skattereduktion prerequisites against a draft invoice.
 *
 * Errors block invoice creation; warnings surface in the UI but don't
 * block (we can't verify a customer's yearly headroom across providers,
 * but we can surface a "this invoice alone exceeds the cap" warning).
 *
 * The function takes invoice-level metadata as separate arguments rather
 * than reading them off the items array so callers can compose it from
 * either a HTTP request body or the form state without restructuring.
 *
 * `money` carries the invoice's currency (and, when known, its booking rate).
 * ROT_MAX / RUT_MAX / GRON_TEKNIK_MAX are kronor ceilings, so the comparison
 * is only meaningful against a SEK figure. Omitting the argument means "SEK",
 * which is what every pre-existing caller was implicitly asserting.
 */
export function validateInvoice(
  items: ValidateInvoiceItem[],
  personnummerProvided: boolean,
  housingDesignationProvided: boolean,
  money?: DeductionCurrencyContext,
  priorYear?: PriorYearDeductions | null,
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const hasAnyDeduction = items.some((item) => item.deduction_type)
  const hasAnyRot = items.some((item) => item.deduction_type === 'rot')
  const hasAnyGronTeknik = items.some((item) => item.deduction_type === 'gron_teknik')
  const onlyGronTeknik =
    hasAnyGronTeknik && items.every((item) => !item.deduction_type || item.deduction_type === 'gron_teknik')

  if (hasAnyDeduction && !personnummerProvided) {
    errors.push(onlyGronTeknik ? GRON_TEKNIK_INVOICE_ERRORS.personnummerMissing : 'Personnummer krävs för ROT/RUT-avdrag.')
  }

  // Arbetstyp + arbetstimmar per line: required by the Skatteverket claim,
  // and only fixable while the invoice is still a draft.
  errors.push(...validateDeductionLines(items))

  // ROT requires fastighetsbeteckning per Skatteverket's Husavdragstjänst.
  // RUT does not (in 2026 the Skatteverket file accepts RUT without it).
  if (hasAnyRot && !housingDesignationProvided) {
    errors.push('Fastighetsbeteckning krävs för ROT-avdrag.')
  }
  // Grön teknik: the invoice must name the property ("Fastighetsbeteckningen
  // eller bostadsrättsföreningens organisationsnummer och lägenhetsnummer",
  // Skatteverket's list of what the invoice should contain).
  if (hasAnyGronTeknik && !housingDesignationProvided) {
    errors.push(GRON_TEKNIK_INVOICE_ERRORS.propertyMissing)
  }

  warnings.push(...deductionCapWarnings(computeDeductionTotalsByKind(items), money, priorYear))

  return { errors, warnings }
}

/** Deductions already claimed for the same person earlier in the year, in SEK. */
export interface PriorYearDeductions {
  rot: number
  rut: number
  /** Grön teknik: its own ceiling, never part of the ROT/RUT combined one. */
  gron_teknik?: number
}

/**
 * Yearly-ceiling warnings for one invoice's deductions (invoice currency),
 * optionally on top of what the same person has already been granted this
 * year (SEK). Four ceilings: ROT 50 000, RUT 75 000, the shared 75 000
 * (COMBINED_MAX) that ROT + RUT together must not exceed, and grön teknik
 * 50 000 (GRON_TEKNIK_MAX), which is separate headroom. Warnings, never
 * errors: we cannot see claims made through other providers, so the customer
 * still has to check their own remaining headroom.
 *
 * `totals` works in invoice currency; the ceilings are kronor. Convert before
 * comparing, and never label a foreign figure "kr".
 */
export function deductionCapWarnings(
  totals: DeductionTotalsByKind,
  money?: DeductionCurrencyContext,
  priorYear?: PriorYearDeductions | null,
): string[] {
  const warnings: string[] = []
  const currencyLabel = (money?.currency ?? 'SEK').toUpperCase()
  const toSek = deductionSekConverter(money)
  const advice = 'Kunden behöver kontrollera sitt återstående utrymme själv.'
  const priorRot = Math.max(0, priorYear?.rot ?? 0)
  const priorRut = Math.max(0, priorYear?.rut ?? 0)
  const priorGronTeknik = Math.max(0, priorYear?.gron_teknik ?? 0)

  // Warning-text amounts: sv-SE digits, always two decimals, same convention
  // as maxText below.
  const svAmount = (n: number): string =>
    n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const maxTextOf = (max: number): string => `${max.toLocaleString('sv-SE')} kr`

  const rotSek = toSek ? toSek(totals.rot) : null
  const rutSek = toSek ? toSek(totals.rut) : null

  // `subject` is the kind's DEDUCTION_TYPE_LABELS.capSubject and `wording`
  // defaults to the ROT/RUT one, so the ROT and RUT sentences read exactly as
  // they always have.
  const pushCapWarning = (
    subject: string,
    amount: number,
    amountSek: number | null,
    prior: number,
    max: number,
    wording: CapWording = HUS_CAP_WORDING,
  ): void => {
    if (amount <= 0) return
    const maxText = maxTextOf(max)
    const priorText = prior > 0 ? ` plus ${wording.prior} (${svAmount(prior)} kr)` : ''

    if (amountSek === null) {
      // No booking rate: we cannot know whether the ceiling is breached.
      // Saying so beats both silence and a fabricated kronor comparison.
      warnings.push(
        `${subject} på denna faktura (${svAmount(amount)} ${currencyLabel}) kan inte stämmas av mot ` +
          `årsmaximum ${maxText}: fakturan saknar växelkurs. ` + advice,
      )
      return
    }
    if (amountSek + prior <= max) return
    const figure = currencyLabel === 'SEK'
      ? `${svAmount(amount)} kr`
      : `${svAmount(amount)} ${currencyLabel} = ${svAmount(amountSek)} kr`
    // Over the ceiling on its own: no remaining headroom can absorb it, so
    // "check your headroom" would be the wrong advice.
    const kindAdvice = amountSek > max && wording.overOnItsOwn ? wording.overOnItsOwn : advice
    warnings.push(
      `${subject} på denna faktura (${figure})${priorText} överstiger årsmaximum ${maxText}. ` + kindAdvice,
    )
  }

  pushCapWarning(DEDUCTION_TYPE_LABELS.rot.capSubject, totals.rot, rotSek, priorRot, ROT_MAX)
  pushCapWarning(DEDUCTION_TYPE_LABELS.rut.capSubject, totals.rut, rutSek, priorRut, RUT_MAX)

  // The shared ceiling: only worth its own line when neither kind already
  // tripped its own (a RUT breach of 75 000 implies the combined breach), and
  // only when both kinds are in play across the year, otherwise the per-kind
  // ceiling is the binding one (ROT alone caps at 50 000 anyway).
  if (rotSek !== null && rutSek !== null) {
    const rotYear = rotSek + priorRot
    const rutYear = rutSek + priorRut
    const combined = rotYear + rutYear
    const bothKinds = rotYear > 0 && rutYear > 0
    if (bothKinds && combined > COMBINED_MAX && rotYear <= ROT_MAX && rutYear <= RUT_MAX) {
      const thisInvoice = roundOre(rotSek + rutSek)
      const priorSum = priorRot + priorRut
      const priorText = priorSum > 0 ? ` plus tidigare avdrag i år (${svAmount(priorSum)} kr)` : ''
      warnings.push(
        `ROT- och RUT-avdragen på denna faktura (${svAmount(thisInvoice)} kr)${priorText} överstiger tillsammans ` +
          `det gemensamma årsmaximum ${maxTextOf(COMBINED_MAX)}. ` + advice,
      )
    }
  }

  // Grön teknik: its own 50 000 kr ceiling, after the ROT/RUT lines so their
  // order never changes. It never counts towards COMBINED_MAX.
  const gronTeknik = totals.gron_teknik ?? 0
  pushCapWarning(
    DEDUCTION_TYPE_LABELS.gron_teknik.capSubject,
    gronTeknik,
    toSek ? toSek(gronTeknik) : null,
    priorGronTeknik,
    GRON_TEKNIK_MAX,
    GRON_TEKNIK_CAP_WORDING,
  )

  return warnings
}

/** The words a ceiling warning uses for what came before and what to do. */
interface CapWording {
  /** What the prior amount is: 'tidigare avdrag i år'. */
  prior: string
  /** Advice when this invoice alone is above the ceiling; null keeps the general advice. */
  overOnItsOwn: string | null
}

const HUS_CAP_WORDING: CapWording = { prior: 'tidigare avdrag i år', overOnItsOwn: null }

/**
 * Grön teknik speaks of skattereduktion, not avdrag. A single installation
 * above the ceiling (a battery at 50 % reaches it at 100 000 kr incl. moms) is
 * common, and Skatteverkets e-tjänst refuses a Begärt belopp above the limit,
 * so the part above it is the customer's to pay.
 */
const GRON_TEKNIK_CAP_WORDING: CapWording = {
  prior: 'tidigare skattereduktion för grön teknik i år',
  overOnItsOwn:
    'Skatteverket betalar inte ut mer än så per person och år, så den del som överstiger det får kunden betala.',
}
