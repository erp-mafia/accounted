import type {
  EgenKapitalRow,
  IncomeStatementLine,
  NoteEntry,
} from './types'

/**
 * K3 noter builder (BFNAR 2012:1).
 *
 * K3 requires a richer note set than K2:
 *   - Verbose redovisningsprinciper covering komponentavskrivning (when used),
 *     uppskjuten skatt, intäktsredovisning, leasing och finansiella instrument.
 *   - A separate "Uppskjutna skatter" note showing the latent-tax balance
 *     movement (2240 ingående/utgående saldo + årets förändring posted to 8940).
 *   - "Förändring av eget kapital" presented as a SEPARATE statement (not just
 *     a förvaltningsberättelse line — see ÅRL 6:5 + BFNAR 2012:1 ch.6).
 *   - When component depreciation is used, the materiella anläggnings-not must
 *     break out anskaffningsvärden, avskrivningar och bokfört värde per
 *     huvudkomponent.
 *
 * The functions in this file are pure: they take pre-computed numbers and
 * return the note structures. The caller (buildArsredovisningData) is
 * responsible for fetching the inputs from the database. This keeps the
 * functions trivially unit-testable.
 */

// ─── Redovisningsprinciper ────────────────────────────────────────────────

/**
 * K3 redovisningsprinciper note body. More verbose than K2 — K3 punkt 2.6 +
 * ch.3 require disclosure of each accounting policy that affects the
 * reporting, including measurement bases for fixed assets, depreciation
 * approach, deferred tax treatment, revenue recognition, leasing och
 * financial instruments.
 *
 * @param hasComponents — when true, includes the komponentavskrivning
 *   paragraph. K3 ch.17.4 makes component depreciation mandatory when the
 *   components have meaningfully different useful lives; otherwise the
 *   paragraph would be misleading and is omitted.
 */
export function buildK3RedovisningsPrinciper(
  hasComponents: boolean,
): NoteEntry {
  const paragraphs: string[] = [
    'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen (1995:1554) och Bokföringsnämndens allmänna råd BFNAR 2012:1 Årsredovisning och koncernredovisning (K3).',
    'Värderingsprinciper: Tillgångar och skulder värderas till anskaffningsvärde om inget annat anges. Materiella anläggningstillgångar redovisas till anskaffningsvärde med avdrag för ackumulerade avskrivningar och eventuella nedskrivningar. Avskrivning sker linjärt över tillgångens bedömda nyttjandeperiod.',
  ]
  if (hasComponents) {
    paragraphs.push(
      'Komponentavskrivning: Materiella anläggningstillgångar med betydande komponenter som har väsentligt olika nyttjandeperioder delas upp och varje komponent skrivs av separat. Anskaffningsvärdet fördelas på komponenterna baserat på relativ andel av tillgångens värde.',
    )
  }
  paragraphs.push(
    'Uppskjuten skatt: Uppskjuten skatt redovisas enligt balansräkningsmetoden för temporära skillnader mellan redovisade och skattemässiga värden på tillgångar och skulder. Uppskjuten skatt värderas till nominellt belopp utan diskontering och beräknas utifrån den skattesats som är beslutad på balansdagen.',
    'Intäktsredovisning: Intäkter redovisas till det verkliga värdet av det som erhållits eller kommer att erhållas och redovisas när väsentliga risker och förmåner har överförts till köparen, beloppet kan mätas tillförlitligt och det är sannolikt att de ekonomiska fördelarna tillfaller företaget.',
    'Leasing: Leasingavtal klassificeras som finansiell eller operationell leasing. Operationella leasingavgifter redovisas linjärt i resultaträkningen under leasingperioden. Finansiella leasingavtal redovisas som anläggningstillgång med motsvarande skuld i balansräkningen.',
    'Finansiella instrument: Finansiella instrument redovisas initialt till anskaffningsvärde inklusive transaktionskostnader. Kundfordringar värderas till det belopp som beräknas inflyta. Övriga finansiella tillgångar och skulder redovisas till upplupet anskaffningsvärde.',
  )
  return {
    number: 1,
    title: 'Redovisnings- och värderingsprinciper',
    body: paragraphs.join('\n\n'),
  }
}

// ─── Uppskjutna skatter ──────────────────────────────────────────────────

/**
 * "Uppskjutna skatter" note required for K3 (ch.29). Shows the latent-tax
 * balance movement during the year:
 *   - Opening balance on 2240 (start of period)
 *   - Change posted to 8940 (year-end provision adjustment)
 *   - Closing balance on 2240 (end of period)
 *
 * The closing must equal opening + change. Caller passes raw figures; the
 * note formats them with thousand-separators and the appropriate sign.
 */
export function buildUppskjutenSkattNot(params: {
  noteNumber: number
  latentTaxOpening: number
  latentTaxChange: number
  latentTaxClosing: number
}): NoteEntry {
  const { noteNumber, latentTaxOpening, latentTaxChange, latentTaxClosing } =
    params
  // sv-SE thousand separator, no decimals — typical for ÅR notes.
  const fmt = (n: number) =>
    Math.round(n).toLocaleString('sv-SE')
  const lines: string[] = [
    'Uppskjuten skatteskuld avser i huvudsak temporära skillnader på obeskattade reserver (periodiseringsfonder och överavskrivningar), beräknad med skattesatsen 20,6 %.',
    '',
    `Ingående saldo (2240): ${fmt(latentTaxOpening)} kr`,
    `Årets förändring (8940): ${fmt(latentTaxChange)} kr`,
    `Utgående saldo (2240): ${fmt(latentTaxClosing)} kr`,
  ]
  return {
    number: noteNumber,
    title: 'Uppskjutna skatter',
    body: lines.join('\n'),
  }
}

// ─── Förändring av eget kapital ──────────────────────────────────────────

export interface EquityChangesSummary {
  /** Opening balances per equity component. */
  opening: {
    aktiekapital: number
    /** Övriga bundna reserver — reservfond, uppskrivningsfond. */
    bundna_reserver: number
    balanserade_vinstmedel: number
  }
  /** Year movements. */
  changes: {
    nyemission: number
    utdelning: number
    /** Årets resultat — added to balanserade vinstmedel next year, shown on
     *  its own line in the change statement. */
    arets_resultat: number
  }
}

export interface EquityChangesStatement {
  rows: EgenKapitalRow[]
  /** Closing total — derived from opening + changes for invariant testing. */
  closing_total: number
}

/**
 * Build a "Förändring av eget kapital" statement. K3 requires this as a
 * separate financial statement (not buried in the förvaltningsberättelse —
 * BFNAR 2012:1 ch.6 + ÅRL 6:5). Each component is shown with its opening
 * balance, year movements, and closing balance.
 *
 * Note: returns an EgenKapitalRow[] sequence rather than a structured table
 * — the PDF renderer in arsredovisning-k3-pdf.tsx draws the rows in order.
 * Keeping the shape compatible with the existing EgenKapitalRow type avoids
 * touching the PDF template for additional row variants.
 */
export function buildEquityChangesNote(
  summary: EquityChangesSummary,
): EquityChangesStatement {
  const { opening, changes } = summary
  const rows: EgenKapitalRow[] = []

  // Opening balances
  rows.push({ label: 'Ingående aktiekapital', amount: opening.aktiekapital })
  rows.push({
    label: 'Ingående övriga bundna reserver',
    amount: opening.bundna_reserver,
  })
  rows.push({
    label: 'Ingående balanserade vinstmedel',
    amount: opening.balanserade_vinstmedel,
  })
  const openingTotal =
    opening.aktiekapital + opening.bundna_reserver + opening.balanserade_vinstmedel
  rows.push({ label: 'Summa ingående eget kapital', amount: openingTotal })

  // Year movements
  if (changes.nyemission !== 0) {
    rows.push({ label: 'Nyemission', amount: changes.nyemission })
  }
  if (changes.utdelning !== 0) {
    // Utdelning typically posted as a negative (reduction). The caller is
    // free to pass either sign; we just render what we got.
    rows.push({ label: 'Utdelning', amount: changes.utdelning })
  }
  rows.push({ label: 'Årets resultat', amount: changes.arets_resultat })

  // Closing balance — uses standard accounting roll-forward.
  const closingTotal =
    openingTotal +
    changes.nyemission +
    changes.utdelning +
    changes.arets_resultat
  rows.push({
    label: 'Summa utgående eget kapital',
    amount: Math.round(closingTotal * 100) / 100,
  })

  return { rows, closing_total: Math.round(closingTotal * 100) / 100 }
}

// ─── Materiella anläggningstillgångar ────────────────────────────────────

/**
 * Per-component breakdown for an asset under K3 komponentavskrivning.
 * Shape mirrors what we expect to find on Asset.k3_components when item
 * 18c lands — kept loose here so the field can evolve without breaking
 * this builder. We accept anything with the four fields we need.
 */
export interface K3ComponentBreakdown {
  name: string
  /** Anskaffningsvärde for this component. */
  acquisition_cost: number
  /** Ackumulerade avskrivningar so far. */
  accumulated_depreciation: number
  /** Useful life in months (drives the avskrivningstid disclosure). */
  useful_life_months: number
}

interface AssetWithComponents {
  name: string
  category: string
  acquisition_date: string
  acquisition_cost: number
  k3_components: unknown | null
  disposed_at: string | null
  useful_life_months: number
}

/**
 * Type guard: validates that an unknown payload from Asset.k3_components is
 * actually an array of K3ComponentBreakdown rows we can render. The DB stores
 * the field as JSONB so callers receive `unknown`; the migration plan for
 * 18c will tighten the type, but we keep this guard so the builder is safe
 * to call against today's column.
 */
function isComponentArray(value: unknown): value is K3ComponentBreakdown[] {
  if (!Array.isArray(value)) return false
  return value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const obj = item as Record<string, unknown>
    return (
      typeof obj.name === 'string' &&
      typeof obj.acquisition_cost === 'number' &&
      typeof obj.accumulated_depreciation === 'number' &&
      typeof obj.useful_life_months === 'number'
    )
  })
}

/**
 * "Materiella anläggningstillgångar" note. When component depreciation is
 * in use for any asset, render per-component sub-totals so the reader can
 * see how the asset breaks down. Otherwise fall back to the K2-style
 * avskrivningstider summary.
 *
 * Caller passes the asset list as-is from listAssets(); this function
 * filters out disposed assets and skips immaterial / non-tangible categories
 * (those belong in their own note).
 */
export function buildMateriellaAnlaggningsNot(params: {
  noteNumber: number
  assets: AssetWithComponents[]
}): NoteEntry | null {
  const { noteNumber, assets } = params
  const tangibleCategories = new Set([
    'building',
    'land_improvement',
    'machinery',
    'equipment',
    'vehicle',
    'computer',
    'other_tangible',
  ])
  const active = assets.filter(
    (a) => !a.disposed_at && tangibleCategories.has(a.category),
  )
  if (active.length === 0) return null

  const linesOut: string[] = [
    'Materiella anläggningstillgångar redovisas till anskaffningsvärde med avdrag för ackumulerade avskrivningar.',
    '',
  ]

  // Group by category for the avskrivningstider summary.
  const categoryLabels: Record<string, string> = {
    building: 'Byggnader',
    land_improvement: 'Markanläggningar',
    machinery: 'Maskiner',
    equipment: 'Inventarier',
    vehicle: 'Fordon',
    computer: 'Datorer',
    other_tangible: 'Övriga materiella anläggningstillgångar',
  }
  const byCategory = new Map<string, Set<number>>()
  for (const a of active) {
    const years = Math.round(a.useful_life_months / 12)
    if (!byCategory.has(a.category)) byCategory.set(a.category, new Set())
    byCategory.get(a.category)!.add(years)
  }
  linesOut.push('Avskrivningstider per kategori:')
  for (const [cat, yearsSet] of byCategory.entries()) {
    const yrs = Array.from(yearsSet).sort((a, b) => a - b)
    const yrsLabel =
      yrs.length === 1 ? `${yrs[0]} år` : `${yrs[0]}–${yrs[yrs.length - 1]} år`
    linesOut.push(`  • ${categoryLabels[cat] ?? cat}: ${yrsLabel}`)
  }

  // If any asset has components, render a per-component breakdown per asset.
  const fmt = (n: number) => Math.round(n).toLocaleString('sv-SE')
  const withComponents = active.filter((a) => isComponentArray(a.k3_components))
  if (withComponents.length > 0) {
    linesOut.push('', 'Komponentuppdelning per tillgång:')
    for (const asset of withComponents) {
      const components = asset.k3_components as K3ComponentBreakdown[]
      linesOut.push('', asset.name)
      let totalCost = 0
      let totalAccum = 0
      for (const c of components) {
        const bookValue = c.acquisition_cost - c.accumulated_depreciation
        const years = Math.round(c.useful_life_months / 12)
        linesOut.push(
          `  • ${c.name}: anskaffningsvärde ${fmt(c.acquisition_cost)} kr, ackumulerad avskrivning ${fmt(c.accumulated_depreciation)} kr, bokfört värde ${fmt(bookValue)} kr (avskrivningstid ${years} år)`,
        )
        totalCost += c.acquisition_cost
        totalAccum += c.accumulated_depreciation
      }
      linesOut.push(
        `  Summa: anskaffningsvärde ${fmt(totalCost)} kr, ackumulerad avskrivning ${fmt(totalAccum)} kr, bokfört värde ${fmt(totalCost - totalAccum)} kr`,
      )
    }
  }

  return {
    number: noteNumber,
    title: 'Materiella anläggningstillgångar',
    body: linesOut.join('\n'),
  }
}

// ─── Helpers (exported for tests + integration) ──────────────────────────

/**
 * True iff any (non-disposed) asset has K3 components configured. Caller can
 * use this to decide whether to:
 *   - include the komponentavskrivning paragraph in redovisningsprinciper
 *   - render the per-component sub-totals in materiella anläggnings-not.
 */
export function anyAssetHasComponents(assets: AssetWithComponents[]): boolean {
  return assets.some(
    (a) => !a.disposed_at && isComponentArray(a.k3_components),
  )
}

// Re-export so the type-guard signature can be reused by build-data and
// tests without exposing the local AssetWithComponents structural type.
export { isComponentArray as isK3ComponentArray }

// Re-export the line type to make integration easier for callers that need
// to merge with non-K3 lines without re-importing from './types'.
export type { IncomeStatementLine }
