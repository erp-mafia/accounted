/**
 * Pure helpers for the "Resultat per månad" pane: the compact bar label and
 * the decision whether every bar can carry one without labels colliding.
 * Kept out of the component so the fit rule is testable without a DOM.
 */

/** Swedish compact form, e.g. "12 tn" or "1,2 mn", used on the bars. */
export function compactKr(n: number): string {
  return new Intl.NumberFormat('sv-SE', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/**
 * Font size of the per-bar labels, in viewBox units. Smaller than the 10.5
 * the latest bar keeps: twelve labels have to share 320 units, and the exact
 * amounts are listed under the axis anyway.
 */
export const BAR_LABEL_FONT_PX = 8

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
 * True when the widest label fits inside one bar slot with a gap to spare,
 * so labelling every bar cannot overlap. A company with six-figure months
 * ("−123 tn") on a twelve-slot pane fails this and falls back to labelling
 * the latest bar only, exactly as before.
 */
export function allLabelsFit(labels: string[], slotWidth: number, fontPx = BAR_LABEL_FONT_PX): boolean {
  const widest = labels.reduce((max, l) => Math.max(max, estimateLabelWidth(l, fontPx)), 0)
  return widest + LABEL_GAP_PX <= slotWidth
}
