import { roundOre } from '@/lib/money'
import { computeLineNet } from '@/lib/invoices/line-amounts'

/**
 * ROT/RUT-avdrag rules.
 *
 * Implements the calculation and validation logic for Sweden's tax deduction
 * for household services (RUT) and home renovation (ROT). As of 2026:
 *   - ROT: 30% of labor cost INCLUDING VAT, max 50 000 kr per person per year.
 *   - RUT: 50% of labor cost INCLUDING VAT, max 75 000 kr per person per year.
 *
 * The base is arbetskostnaden inklusive moms per HUSFL (2009:194) 6-9 §§:
 * Skatteverkets own worked example is 18 000 kr arbetskostnad = 22 500 kr
 * inkl. moms (25%), ROT 30% = 6 750 kr. Callers must therefore pass the
 * line's VAT rate; a missing/null rate is treated as 0% (momsfri labor),
 * where inkl. and exkl. coincide.
 *
 * The deduction applies to labor only: material costs and travel time are
 * NOT eligible. In this v1 we treat the entire invoice item amount as labor
 * when the user flags it ROT/RUT; the user is expected to either invoice
 * labor on its own row or split materials onto a non-flagged row. A future
 * iteration can add per-line "labor portion" handling if needed.
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
 * SEK, same caveat as ROT_MAX.
 */
export const COMBINED_MAX = 75000

export type DeductionType = 'rot' | 'rut'

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
 * Which deduction kind a Skatteverket work-type code belongs to. The two code
 * lists are disjoint, so the code alone decides ROT vs RUT: this is what lets
 * an article's housework_type pre-fill both the invoice line's work_type and
 * its deduction_type. Unknown or absent codes map to null (no deduction).
 */
export function deductionTypeForWorkType(code: string | null | undefined): DeductionType | null {
  if (!code) return null
  if (ROT_WORK_TYPES.some((w) => w.code === code)) return 'rot'
  if (RUT_WORK_TYPES.some((w) => w.code === code)) return 'rut'
  return null
}

/** Human label for a Skatteverket work-type code, or null for unknown codes. */
export function workTypeLabel(code: string | null | undefined): string | null {
  if (!code) return null
  const hit = [...ROT_WORK_TYPES, ...RUT_WORK_TYPES].find((w) => w.code === code)
  return hit ? hit.label : null
}

/**
 * The two vocabularies `articles.housework_type` has been written in:
 * - a Skatteverket work-type code (`BYGG`, `STAD`, ...): the intended value,
 *   decides both the deduction kind and the line's arbetstyp;
 * - the bare kind `ROT` / `RUT`: what the article form stored before it
 *   offered real work types (legacy rows), decides the kind only.
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

/** Accepted housework_type values: every work-type code plus the bare kinds. */
export const HOUSEWORK_TYPE_VALUES: readonly string[] = [
  'ROT',
  'RUT',
  ...ROT_WORK_TYPES.map((w) => w.code),
  ...RUT_WORK_TYPES.map((w) => w.code),
]

export interface ItemForDeduction {
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
  /** 'rot' | 'rut' | null. Drives whether the deduction kicks in at all. */
  deduction_type?: DeductionType | null
  /**
   * The line's VAT rate in percent (25, 12, 6, 0). The statutory deduction
   * base is the labor cost INCLUDING VAT (HUSFL 6-9 §§), so every caller
   * that knows the rate must pass it. null/undefined means 0% (momsfri
   * labor), where inkl. and exkl. moms coincide.
   */
  vat_rate?: number | null
  /**
   * Optional. Reserved for a future iteration where the eligible portion of
   * the row is just the labor hours × hourly rate. v1 ignores this and
   * deducts on the full line total; we still take the field so the API
   * schema accepts it without rejecting future-shaped payloads.
   */
  labor_hours?: number | null
}

/**
 * Compute the deduction amount for a single invoice item. Returns 0 when
 * the item has no deduction_type. The base is the line total INCLUDING VAT
 * (HUSFL 6-9 §§: 30% av arbetskostnaden inklusive moms for ROT, 50% for
 * RUT). The per-line VAT is reproduced with the exact rounding the write
 * path stores on invoice_items.vat_amount (Math.round(lineTotal * rate /
 * 100 * 100) / 100 in build-invoice-write.ts), so the deduction and the
 * stored VAT can never disagree by an öre. The result is always >= 0 and
 * <= line total incl. VAT (no over-deduction even if percentages are
 * tweaked).
 */
export function computeDeduction(item: ItemForDeduction): number {
  if (!item.deduction_type) return 0
  // Net of any line discount: the deduction follows what the customer pays.
  const lineTotal = computeLineNet(item.quantity, item.unit_price, item.discount_percent)
  if (lineTotal <= 0) return 0
  const rate = item.vat_rate ?? 0
  const lineVat = rate > 0 ? Math.round(lineTotal * rate / 100 * 100) / 100 : 0
  const lineTotalInclVat = lineTotal + lineVat
  const percent = item.deduction_type === 'rot' ? ROT_PERCENT : RUT_PERCENT
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
 * Sum per deduction kind. Used to surface separate cap warnings.
 */
export function computeDeductionTotalsByKind(items: ItemForDeduction[]): {
  rot: number
  rut: number
} {
  let rot = 0
  let rut = 0
  for (const item of items) {
    const amount = computeDeduction(item)
    if (item.deduction_type === 'rot') rot += amount
    else if (item.deduction_type === 'rut') rut += amount
  }
  return {
    rot: Math.round(rot * 100) / 100,
    rut: Math.round(rut * 100) / 100,
  }
}

export interface ValidateInvoiceItem extends ItemForDeduction {
  housing_designation?: string | null
  /** Skatteverket arbetstypskod (ROT_WORK_TYPES / RUT_WORK_TYPES). */
  work_type?: string | null
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
} as const

/**
 * Per-line claim completeness: what the begäran om utbetalning to Skatteverket
 * needs from every deduction line (HUSFL 2009:194: art av arbete och antal
 * arbetstimmar). Checked at invoice creation because that is the last moment
 * the line is editable: once the invoice is numbered, booked and paid, a
 * missing arbetstyp used to surface only as a file-generation blocker with
 * no repair path short of a credit note. Returns each message at most once.
 */
export function validateDeductionLines(items: ValidateInvoiceItem[]): string[] {
  const errors = new Set<string>()
  for (const item of items) {
    if (!item.deduction_type) continue
    const workType = item.work_type?.trim() || null
    if (!workType) {
      errors.add(DEDUCTION_LINE_ERRORS.workTypeMissing)
    } else if (deductionTypeForWorkType(workType) !== item.deduction_type) {
      errors.add(DEDUCTION_LINE_ERRORS.workTypeMismatch)
    }
    const isSchablon = workType != null && SCHABLON_WORK_TYPES.includes(workType)
    const hours = item.labor_hours
    if (!isSchablon && !(typeof hours === 'number' && Number.isFinite(hours) && hours > 0)) {
      errors.add(DEDUCTION_LINE_ERRORS.hoursMissing)
    }
  }
  return [...errors]
}

export interface ValidationResult {
  errors: string[]
  warnings: string[]
}

/**
 * Validate ROT/RUT prerequisites against a draft invoice.
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
 * ROT_MAX / RUT_MAX are kronor ceilings, so the comparison is only meaningful
 * against a SEK figure. Omitting the argument means "SEK", which is what
 * every pre-existing caller was implicitly asserting.
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

  if (hasAnyDeduction && !personnummerProvided) {
    errors.push('Personnummer krävs för ROT/RUT-avdrag.')
  }

  // Arbetstyp + arbetstimmar per line: required by the Skatteverket claim,
  // and only fixable while the invoice is still a draft.
  errors.push(...validateDeductionLines(items))

  // ROT requires fastighetsbeteckning per Skatteverket's Husavdragstjänst.
  // RUT does not (in 2026 the Skatteverket file accepts RUT without it).
  if (hasAnyRot && !housingDesignationProvided) {
    errors.push('Fastighetsbeteckning krävs för ROT-avdrag.')
  }

  warnings.push(...deductionCapWarnings(computeDeductionTotalsByKind(items), money, priorYear))

  return { errors, warnings }
}

/** Deductions already claimed for the same person earlier in the year, in SEK. */
export interface PriorYearDeductions {
  rot: number
  rut: number
}

/**
 * Yearly-ceiling warnings for one invoice's deductions (invoice currency),
 * optionally on top of what the same person has already been granted this
 * year (SEK). Three ceilings: ROT 50 000, RUT 75 000, and the shared 75 000
 * (COMBINED_MAX) that ROT + RUT together must not exceed. Warnings, never
 * errors: we cannot see claims made through other providers, so the customer
 * still has to check their own remaining headroom.
 *
 * `totals` works in invoice currency; the ceilings are kronor. Convert before
 * comparing, and never label a foreign figure "kr".
 */
export function deductionCapWarnings(
  totals: { rot: number; rut: number },
  money?: DeductionCurrencyContext,
  priorYear?: PriorYearDeductions | null,
): string[] {
  const warnings: string[] = []
  const currencyLabel = (money?.currency ?? 'SEK').toUpperCase()
  const toSek = deductionSekConverter(money)
  const advice = 'Kunden behöver kontrollera sitt återstående utrymme själv.'
  const priorRot = Math.max(0, priorYear?.rot ?? 0)
  const priorRut = Math.max(0, priorYear?.rut ?? 0)

  // Warning-text amounts: sv-SE digits, always two decimals, same convention
  // as maxText below.
  const svAmount = (n: number): string =>
    n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const maxTextOf = (max: number): string => `${max.toLocaleString('sv-SE')} kr`

  const rotSek = toSek ? toSek(totals.rot) : null
  const rutSek = toSek ? toSek(totals.rut) : null

  const pushCapWarning = (kind: 'ROT' | 'RUT', amount: number, amountSek: number | null, prior: number, max: number): void => {
    if (amount <= 0) return
    const maxText = maxTextOf(max)
    const priorText = prior > 0 ? ` plus tidigare avdrag i år (${svAmount(prior)} kr)` : ''

    if (amountSek === null) {
      // No booking rate: we cannot know whether the ceiling is breached.
      // Saying so beats both silence and a fabricated kronor comparison.
      warnings.push(
        `${kind}-avdraget på denna faktura (${svAmount(amount)} ${currencyLabel}) kan inte stämmas av mot ` +
          `årsmaximum ${maxText}: fakturan saknar växelkurs. ` + advice,
      )
      return
    }
    if (amountSek + prior <= max) return
    const figure = currencyLabel === 'SEK'
      ? `${svAmount(amount)} kr`
      : `${svAmount(amount)} ${currencyLabel} = ${svAmount(amountSek)} kr`
    warnings.push(
      `${kind}-avdraget på denna faktura (${figure})${priorText} överstiger årsmaximum ${maxText}. ` + advice,
    )
  }

  pushCapWarning('ROT', totals.rot, rotSek, priorRot, ROT_MAX)
  pushCapWarning('RUT', totals.rut, rutSek, priorRut, RUT_MAX)

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

  return warnings
}
