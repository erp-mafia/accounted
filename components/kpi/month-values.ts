/**
 * Pure helpers for the "Resultat per månad" pane: the compact bar label and
 * the decision whether every bar can carry one without labels colliding.
 * Kept out of the component so the fit rule is testable without a DOM.
 */

/**
 * Swedish compact form, e.g. "12 tn" or "1,2 mn", used on the bars.
 * `signDisplay: 'negative'` keeps an öre-sized loss that rounds to zero from
 * printing as "−0"; a minus sign only appears on a value that shows as one.
 */
export function compactKr(n: number): string {
  return new Intl.NumberFormat('sv-SE', {
    notation: 'compact',
    maximumFractionDigits: 1,
    signDisplay: 'negative',
  }).format(n)
}

/** Below this the compact form is "0", so the bar carries no label at all. */
export const LABEL_THRESHOLD_KR = 0.05

/** Label for one bar: blank when the month is empty or rounds to nothing. */
export function barLabel(net: number): string {
  return Math.abs(net) < LABEL_THRESHOLD_KR ? '' : compactKr(net)
}

/**
 * Font size of the per-bar labels, in viewBox units. Smaller than the
 * latest bar's label: twelve labels have to share 320 units, and the exact
 * amounts are listed under the axis anyway.
 */
export const BAR_LABEL_FONT_PX = 8

/** Font size of the latest bar's label, the pane's one emphasised number. */
export const LATEST_LABEL_FONT_PX = 10.5

/**
 * Advance widths per glyph class as a fraction of the font size, tuned for
 * Geist. Digits and the minus sign are tabular-wide; the thin separators and
 * the "tn"/"mn" suffix letters are what make a compact label fit or not, so
 * a single average would misjudge "12 tn" against "−3,4 tn".
 */
const GLYPH_EM: Record<string, number> = {
  ' ': 0.28,
  // No-break space: what Intl puts between the number and its "tn" suffix.
  [String.fromCharCode(160)]: 0.28,
  ',': 0.28,
  '.': 0.28,
  t: 0.35,
  n: 0.55,
  m: 0.85,
}
const DEFAULT_GLYPH_EM = 0.6

/** Breathing room between two adjacent labels, in viewBox units. */
const LABEL_GAP_PX = 3

/** Estimated rendered width of one label at the given font size. */
export function estimateLabelWidth(label: string, fontPx = BAR_LABEL_FONT_PX): number {
  let em = 0
  for (const ch of label) em += GLYPH_EM[ch] ?? DEFAULT_GLYPH_EM
  return em * fontPx
}

/**
 * True when every bar can carry its label without any two overlapping.
 *
 * Labels are centred on their bar, so two neighbours collide when half of
 * each plus the gap exceeds one slot; that pairwise test is the real
 * geometry, and it measures the latest bar at the larger size it renders
 * at. Each label must also fit inside its own slot so the first and last
 * never run past the viewBox edge. A company with six-figure months
 * ("−123 tn") on a twelve-slot pane fails this and falls back to labelling
 * the latest bar only, exactly as before.
 */
export function allLabelsFit(labels: string[], slotWidth: number, latestIndex = -1): boolean {
  const widths = labels.map((label, i) =>
    estimateLabelWidth(label, i === latestIndex ? LATEST_LABEL_FONT_PX : BAR_LABEL_FONT_PX),
  )
  if (widths.some((w) => w > slotWidth)) return false
  for (let i = 1; i < widths.length; i++) {
    if (widths[i - 1] === 0 || widths[i] === 0) continue
    if ((widths[i - 1] + widths[i]) / 2 + LABEL_GAP_PX > slotWidth) return false
  }
  return true
}
