/**
 * WCAG 2.x contrast ratio helpers.
 *
 * Pure utility — no I/O. Used by the invoice branding settings UI to warn
 * users when their chosen primary color would fail AA contrast against a
 * white invoice background, and by the branding API to surface the same
 * warning in the JSON response.
 *
 * Reference: WCAG 2.2 §1.4.3 (Contrast — Minimum). The 4.5:1 threshold
 * applies to normal text (≤18pt, or ≤14pt bold). The PDF invoice renders
 * text at 8-14pt, so 4.5:1 is the right threshold here.
 *
 * Formula:
 *   L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
 *   where each channel x in [0, 1]:
 *     x_lin = x / 12.92                       if x <= 0.03928
 *     x_lin = ((x + 0.055) / 1.055) ** 2.4    otherwise
 *
 *   ratio = (L_lighter + 0.05) / (L_darker + 0.05)
 *   ratio ∈ [1, 21]
 */

/**
 * Parse a hex color string (#RRGGBB) into RGB channels in [0, 1].
 * Throws on invalid input — callers should validate format upstream.
 */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex.trim())
  if (!m) throw new Error(`Invalid hex color: ${hex}`)
  const value = m[1]
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  return { r, g, b }
}

/**
 * Linearize a single sRGB channel value [0, 1] per WCAG 2.x.
 */
function linearize(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4)
}

/**
 * Compute relative luminance L ∈ [0, 1] for a hex color per WCAG 2.x.
 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex)
  const rL = linearize(r)
  const gL = linearize(g)
  const bL = linearize(b)
  return 0.2126 * rL + 0.7152 * gL + 0.0722 * bL
}

/**
 * Compute the WCAG contrast ratio between two hex colors. Returns a value in
 * [1, 21] — 1 = identical colors, 21 = pure black on pure white.
 *
 * Argument order does not matter (the formula uses the lighter and darker
 * luminance regardless of which is foreground).
 */
export function getContrastRatio(hexFg: string, hexBg: string): number {
  const l1 = relativeLuminance(hexFg)
  const l2 = relativeLuminance(hexBg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Returns true when the contrast ratio between fg and bg meets WCAG 2.2 AA
 * for normal text (4.5:1). Use this to warn users when their brand color
 * would render text that fails AA on the invoice background (which is
 * effectively white in the current PDF template).
 */
export function isWcagAACompliant(fg: string, bg: string): boolean {
  return getContrastRatio(fg, bg) >= 4.5
}
