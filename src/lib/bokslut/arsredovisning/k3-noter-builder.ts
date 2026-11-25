import type { NoteEntry } from './types'
import type { DeferredTaxMovement } from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { roundOre } from '@/lib/money'
import { MARK_NOT_DEPRECIATED } from './anlaggningstillgangar-note'
import { formatNoteKronor } from './pdf-format'

/**
 * K3 noter builder (BFNAR 2012:1).
 *
 * K3 requires a richer note set than K2:
 *   - Verbose redovisningsprinciper covering komponentavskrivning (when used),
 *     uppskjuten skatt, intäktsredovisning, leasing och finansiella instrument.
 *   - A separate "Uppskjutna skatter" note showing the latent-tax balance
 *     movement (2240 and 1370 ingående saldo, årets förändring and utgående
 *     saldo, and the year's uppskjuten skatt on 8940).
 *   - (Förändring av eget kapital is no longer built here: the one
 *     specification for K2 and K3 is equity-specification.ts.)
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
 * K3 redovisningsprinciper note body. More verbose than K2: K3 punkt 2.6 +
 * ch.3 require disclosure of each accounting policy that affects the
 * reporting, including measurement bases for fixed assets, depreciation
 * approach, deferred tax treatment, revenue recognition, leasing och
 * financial instruments.
 *
 * @param hasComponents: when true, includes the komponentavskrivning
 *   paragraph. K3 ch.17.4 makes component depreciation mandatory when the
 *   components have meaningfully different useful lives; otherwise the
 *   paragraph would be misleading and is omitted.
 * @param deferredTax: what the trial balance says about 2240, 1370 and 8940.
 *   'recognized' is exactly when buildUppskjutenSkattNot is emitted; the two
 *   notes MUST be driven by the same signal, since a policy paragraph denying
 *   any separately recognized deferred tax cannot sit in the same document as
 *   a note disclosing that very balance. 'unknown' is the read-failure path:
 *   every possible wording is an affirmative claim about figures we could not
 *   read, so NO deferred-tax paragraph is emitted at all. The caller derives
 *   this once (build-data.ts) and warns the user on that path.
 * @param hasCapitalizedLease: true when the balance sheet carries an
 *   anlaggningskonto the company's own chart names as leased (build-data
 *   decides; see hasCapitalizedLeaseAsset there). The blanket operational
 *   treatment is then contradicted by the company's own balansrakning, so the
 *   paragraph describes what is booked instead of asserting the 20.29
 *   simplification.
 */
export function buildK3RedovisningsPrinciper(params: {
  hasComponents: boolean
  deferredTax: 'none' | 'recognized' | 'unknown'
  /** With 'recognized': which deferred tax posts the balansräkning carries (default: the liability only). */
  deferredTaxSides?: { liability: boolean; asset: boolean }
  hasCapitalizedLease: boolean
  /** Mark is on the books: it has no useful life and is not depreciated. */
  holdsLand?: boolean
}): NoteEntry {
  const { hasComponents, deferredTax, hasCapitalizedLease, holdsLand = false } = params
  const sides = params.deferredTaxSides ?? { liability: true, asset: false }
  const paragraphs: string[] = [
    'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen (1995:1554) och Bokföringsnämndens allmänna råd BFNAR 2012:1 Årsredovisning och koncernredovisning (K3).',
    'Värderingsprinciper: Tillgångar och skulder värderas till anskaffningsvärde om inget annat anges. Materiella anläggningstillgångar redovisas till anskaffningsvärde med avdrag för ackumulerade avskrivningar och eventuella nedskrivningar. Avskrivning sker linjärt över tillgångens bedömda nyttjandeperiod.' +
      (holdsLand ? ` ${MARK_NOT_DEPRECIATED}` : ''),
  ]
  if (hasComponents) {
    paragraphs.push(
      'Komponentavskrivning: Materiella anläggningstillgångar med betydande komponenter som har väsentligt olika nyttjandeperioder delas upp och varje komponent skrivs av separat. Anskaffningsvärdet fördelas på komponenterna baserat på relativ andel av tillgångens värde.',
    )
  }
  // The uppskjuten skatt and leasing paragraphs below describe what the
  // BOOKS show, never a policy the document cannot back up. No code
  // capitalizes leases, so every lease is expensed as operational under the
  // K3 20.29 exemption available to a juridisk person. Do not restore
  // broader policy claims (balansrakningsmetoden over all temporary
  // differences, finance-lease capitalization) unless the engine actually
  // implements them: a signed AR must not assert policies the books do not
  // follow.
  //
  // Deferred tax has three cases, decided by the same signal that decides
  // whether buildUppskjutenSkattNot is emitted:
  //   - 'none': no 2240, 1370 or 8940 activity. The reserves are carried
  //     gross, which is what K3 29.37 permits in juridisk person, and the
  //     paragraph says so.
  //   - 'recognized': a 2240 or 1370 balance exists (the K3 deferred tax
  //     posting, legacy postings or imported history). Denying it would
  //     contradict both the balansrakning and the "Uppskjutna skatter" note,
  //     so the paragraph names the posts the books carry and points at that
  //     note.
  //   - 'unknown': the figures could not be read, so NO paragraph is emitted.
  //     Both of the other wordings state how this document reports the
  //     reserves, which is a claim about books we just failed to read: the
  //     gross wording is the same affirmative statement as the denial, only
  //     phrased positively. Silence is the one honest option, and the caller
  //     has already raised a warning telling the user the note could not be
  //     computed.
  // No branch claims HOW the balance was measured or WHERE it came from:
  // under K3 the 2240 account carries deferred tax on ALL temporary
  // differences (.claude/skills/swedish-year-end-closing/references/
  // k2-vs-k3.md:11-13), and deriveLatentTaxMovement reads only the 2240,
  // 1370 and 8940 balances, so an attribution to obeskattade reserver is not
  // something this builder can establish. An imported provision may also have
  // been booked at 22 or 21.4 percent by another system.
  const movementNote = 'Ingående saldo, årets förändring och utgående saldo framgår av noten Uppskjutna skatter.'
  const recognizedParagraph =
    sides.liability && sides.asset
      ? `Uppskjuten skatt: Uppskjuten skatteskuld redovisas på konto 2240 och uppskjuten skattefordran på konto 1370. ${movementNote}`
      : sides.asset
        ? `Uppskjuten skatt: Uppskjuten skattefordran redovisas på konto 1370. ${movementNote}`
        : sides.liability
          ? `Uppskjuten skatt: Uppskjuten skatteskuld redovisas på konto 2240. ${movementNote}`
          : 'Uppskjuten skatt: Årets uppskjutna skatt redovisas i resultaträkningen och framgår av noten Uppskjutna skatter.'
  const deferredTaxParagraph =
    deferredTax === 'recognized'
      ? recognizedParagraph
      : deferredTax === 'unknown'
        ? null
        : 'Uppskjuten skatt: Uppskjuten skatt hänförlig till obeskattade reserver särredovisas inte i juridisk person, utan obeskattade reserver redovisas inklusive uppskjuten skatteskuld.'
  // Leasing follows the same rule as deferred tax: describe the books, do not
  // assert a simplification the balansrakning contradicts. The 20.29 wording
  // states the basis for the treatment without claiming anything about the
  // entity's group obligations, which this builder cannot know (build-data
  // emits a Koncernforhallanden note whenever a parent company is declared).
  // Source: .claude/skills/swedish-asset-accounting/references/leasing-and-disposal.md:32.
  const leasingParagraph = hasCapitalizedLease
    ? 'Leasing: Leasingavgifter för operationella leasingavtal kostnadsförs linjärt i resultaträkningen över leasingperioden. Balansräkningen innehåller leasade tillgångar som redovisas som anläggningstillgång med tillhörande avskrivningar.'
    : 'Leasing: Samtliga leasingavtal redovisas som operationella leasingavtal med stöd av undantaget i K3 punkt 20.29, som medger att även finansiella leasingavtal redovisas som operationella i juridisk person. Leasingavgifterna kostnadsförs linjärt i resultaträkningen över leasingperioden.'
  if (deferredTaxParagraph) paragraphs.push(deferredTaxParagraph)
  paragraphs.push(
    'Intäktsredovisning: Intäkter redovisas till det verkliga värdet av det som erhållits eller kommer att erhållas och redovisas när väsentliga risker och förmåner har överförts till köparen, beloppet kan mätas tillförlitligt och det är sannolikt att de ekonomiska fördelarna tillfaller företaget.',
    leasingParagraph,
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
 * "Uppskjutna skatter" note required for K3 (ch.29). Shows, for each
 * deferred tax post the balansräkning carries, its movement during the year:
 *   - the uppskjuten skatteskuld (2240): ingående saldo, årets förändring,
 *     utgående saldo;
 *   - the uppskjuten skattefordran (1370, a deductible temporary difference
 *     or a recognised loss carried forward): the same three figures;
 * and the year's uppskjuten skatt in the resultaträkning (8940). Each post's
 * closing equals its opening plus its change; the 8940 figure is the two
 * posts' net change (liability up, or asset down, is a cost) as far as it
 * went through the resultaträkning. What did not (the K3 transition
 * voucher books the opening deferred tax against equity on the first day of
 * the first K3 year, 35.11; a correction against equity) is its own line, so
 * the note ties.
 *
 * Emitted only when such a balance actually exists (the K3 deferred tax
 * posting, legacy postings or imported history). The body reports the
 * figures and does NOT claim they were measured at the current 20.6 percent
 * rate: an imported provision may have been booked at 21.4 or 22 percent by
 * another system, and the balance is disclosed here exactly as it stands. It
 * also does not attribute the balance to obeskattade reserver: under K3 the
 * posts hold deferred tax on every temporary difference
 * (.claude/skills/swedish-year-end-closing/references/k2-vs-k3.md:11-13).
 *
 * Whenever this note is emitted, buildK3RedovisningsPrinciper MUST be built
 * with deferredTax 'recognized' and the same posts, or note 1 would deny the
 * very balances this note discloses. build-data.ts derives both from one
 * call to deriveLatentTaxMovement so the pair cannot drift.
 */
export function buildUppskjutenSkattNot(params: {
  noteNumber: number
  /** The uppskjuten skatteskuld, credit-positive; null when the balansräkning carries none. */
  liability: DeferredTaxMovement | null
  /** The uppskjuten skattefordran, debit-positive; null when the balansräkning carries none. */
  asset: DeferredTaxMovement | null
  /** The year's uppskjuten skatt (8940), a cost positive. */
  expense: number
}): NoteEntry {
  const { noteNumber, liability, asset, expense } = params
  // sv-SE thousand separator, no decimals: typical for ÅR notes.
  const fmt = (n: number) => formatNoteKronor(n)
  const intro =
    liability && asset
      ? 'Posterna avser uppskjuten skatteskuld redovisad på konto 2240 och uppskjuten skattefordran redovisad på konto 1370.'
      : asset
        ? 'Posten avser uppskjuten skattefordran redovisad på konto 1370.'
        : liability
          ? 'Posten avser uppskjuten skatteskuld redovisad på konto 2240.'
          : 'Balansräkningen har ingen uppskjuten skatteskuld eller skattefordran vid årets början eller slut.'
  // The posts' net change (a growing skuld or a shrinking fordran is a
  // cost) less what went through 8940: booked against another account.
  const outsideIncomeStatement = roundOre(
    (liability?.change ?? 0) - (asset?.change ?? 0) - expense,
  )
  const post = (label: string, account: string, movement: DeferredTaxMovement) => [
    '',
    label,
    `Ingående saldo (${account}): ${fmt(movement.opening)} kr`,
    `Årets förändring: ${fmt(movement.change)} kr`,
    `Utgående saldo (${account}): ${fmt(movement.closing)} kr`,
  ]
  const lines: string[] = [
    intro,
    ...(liability ? post('Uppskjuten skatteskuld', '2240', liability) : []),
    ...(asset ? post('Uppskjuten skattefordran', '1370', asset) : []),
    '',
    `Årets uppskjutna skatt i resultaträkningen (8940): ${fmt(expense)} kr`,
    ...(Math.abs(outsideIncomeStatement) >= 0.5
      ? [`Förändring som inte redovisats i resultaträkningen (till exempel mot eget kapital vid övergången till K3): ${fmt(outsideIncomeStatement)} kr`]
      : []),
  ]
  return {
    number: noteNumber,
    title: 'Uppskjutna skatter',
    body: lines.join('\n'),
  }
}

// ─── Materiella anläggningstillgångar ────────────────────────────────────

/**
 * Per-component breakdown for an asset under K3 komponentavskrivning.
 * Shape mirrors what we expect to find on Asset.k3_components when item
 * 18c lands: kept loose here so the field can evolve without breaking
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
  // Mark is a tangible asset without a useful life: never depreciated, so
  // it is named in the principle, never given an avskrivningstid.
  const holdsLand = assets.some((a) => !a.disposed_at && a.category === 'land')
  if (active.length === 0 && !holdsLand) return null

  const linesOut: string[] = [
    'Materiella anläggningstillgångar redovisas till anskaffningsvärde med avdrag för ackumulerade avskrivningar.' +
      (holdsLand ? ` ${MARK_NOT_DEPRECIATED}` : ''),
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
  if (byCategory.size > 0) linesOut.push('', 'Avskrivningstider per kategori:')
  for (const [cat, yearsSet] of byCategory.entries()) {
    const yrs = Array.from(yearsSet).sort((a, b) => a - b)
    const yrsLabel =
      yrs.length === 1 ? `${yrs[0]} år` : `${yrs[0]}-${yrs[yrs.length - 1]} år`
    linesOut.push(`  • ${categoryLabels[cat] ?? cat}: ${yrsLabel}`)
  }

  // If any asset has components, render a per-component breakdown per asset.
  const fmt = (n: number) => formatNoteKronor(n)
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
        // A mark component (no useful life) is not written off: no "0 år".
        const life = years > 0 ? `avskrivningstid ${years} år` : 'skrivs inte av'
        linesOut.push(
          `  • ${c.name}: anskaffningsvärde ${fmt(c.acquisition_cost)} kr, ackumulerad avskrivning ${fmt(c.accumulated_depreciation)} kr, bokfört värde ${fmt(bookValue)} kr (${life})`,
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

