/**
 * Brand style block builder (WL-12 slice A2).
 *
 * Pure functions that turn a brand's colors into the server-rendered
 * <style id="brand-vars"> block the root layout injects on branded hosts.
 * Kept free of rendering so the triplet conversion and the block builder
 * are unit-testable in plain node.
 *
 * How the block wins over app/globals.css in both themes:
 *
 *   - globals.css declares the light theme on `:root` (0,1,0) and the dark
 *     theme on `.dark` (0,1,0); the user palettes add `:root[data-palette]` /
 *     `.dark[data-palette]` at (0,2,0).
 *   - the layout stamps `data-brand` on <html> only when a brand renders, so
 *     `html[data-brand]:not(.dark)` and `html[data-brand].dark` are (0,2,1):
 *     they beat every one of the above in their own mode without relying on
 *     stylesheet order.
 *   - the sidebar block defines variables directly ON the sidebar element
 *     (`.bg-frame > aside`), and element-level custom properties always beat
 *     inherited ones, whatever the specificity of the root declarations.
 *
 * No brand (or a brand whose color fails the accessibility gate) means the
 * layout renders no block and no `data-brand` attribute at all: the additive
 * guarantee (default hosts stay byte-identical) lives in the callers, and the
 * fail-open path lives here as a `null` return.
 */

import { getContrastRatio } from '@/lib/invoices/contrast-check'
import { getEffectiveChrome, hslToHex, isBrandColorAccessible, type Brand } from './resolve'

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

interface Hsl {
  h: number
  s: number
  l: number
}

function hexToHsl(hex: string): Hsl | null {
  if (typeof hex !== 'string') return null
  const trimmed = hex.trim()
  if (!HEX_COLOR_RE.test(trimmed)) return null
  const value = trimmed.slice(1)
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }

  return { h, s, l }
}

/** Format an HSL value in the space-separated triplet globals.css uses. */
function formatTriplet(hsl: Hsl): string {
  const h = Math.round(hsl.h) % 360
  const s = Math.round(hsl.s * 100)
  const l = Math.round(hsl.l * 100)
  return `${h} ${s}% ${l}%`
}

/**
 * Convert a `#rrggbb` hex color to the `H S% L%` triplet format the theme
 * variables in app/globals.css use (e.g. `#2563eb` -> `221 83% 53%`).
 * Returns null for anything that is not a 6-digit hex color.
 */
export function hexToHslTriplet(hex: string): string | null {
  const hsl = hexToHsl(hex)
  return hsl ? formatTriplet(hsl) : null
}

// Sidebar tokens on deep chrome (WL-02 round 2: deep-branded chrome needs
// light sidebar text). The sidebar consumes --foreground, --muted-foreground,
// --primary (active items), --primary-foreground, --secondary (hover/active
// chips), --muted (count badges) and --border (trial box, hairlines); this is
// the minimal set that keeps it readable on the deep tone. Lightness values
// are fixed (not relative to the chrome) so any tone inside the derivation
// bounds (L 15-17%) gets the same calibrated lift; hue and saturation follow
// the chrome so the chips read as the same material. A light chrome override
// would break this contract, which is why the onboarding gate (WL-02) rejects
// it there instead of us auto-correcting at render time.
const SIDEBAR_FOREGROUND = '0 0% 98%'
const SIDEBAR_MUTED_FOREGROUND = '0 0% 75%'
const SIDEBAR_SECONDARY_LIGHTNESS = 0.28
const SIDEBAR_MUTED_LIGHTNESS = 0.26
const SIDEBAR_BORDER_LIGHTNESS = 0.3
const SIDEBAR_SATURATION_MAX = 0.35

// Dark-mode ring/primary lift (WL-02 gap fix). Every accessible brand color
// is fairly dark (the white-text 4.5:1 gate demands it), and a LOW-lightness
// one (below ~45%) disappears against dark surfaces: invisible focus rings,
// murky primary buttons. The dark theme therefore lifts such colors to a
// lighter variant of the same hue (~62%, inside the 60-65% band the WL-02
// prototype used for its dark-mode brand variants). Colors at or above the
// threshold keep their stored value in dark mode, exactly as before.
const DARK_LIFT_LIGHTNESS_THRESHOLD = 0.45
const DARK_LIFT_TARGET_LIGHTNESS = 0.62

/** The brand tone the DARK theme renders: lifted when the source is dark. */
function darkModeBrandHsl(brandHsl: Hsl): Hsl {
  if (brandHsl.l >= DARK_LIFT_LIGHTNESS_THRESHOLD) return brandHsl
  return { ...brandHsl, l: DARK_LIFT_TARGET_LIGHTNESS }
}

/**
 * Build the CSS text for the `<style id="brand-vars">` block: brand primary +
 * ring + deep chrome frame in both the light and dark theme, plus the
 * sidebar-scoped light-text tokens. Returns null (fail open to the default
 * theme) when the brand color fails the WCAG gate or any color is not valid
 * hex; the caller logs and renders without the block.
 */
export function buildBrandVarsCss(brand: Pick<Brand, 'brandColor' | 'chromeColor'>): string | null {
  const brandHsl = hexToHsl(brand.brandColor)
  if (!brandHsl) return null
  if (!isBrandColorAccessible(brand.brandColor)) return null

  const chromeHsl = hexToHsl(getEffectiveChrome(brand))
  if (!chromeHsl) return null

  const brandTriplet = formatTriplet(brandHsl)
  const chromeTriplet = formatTriplet(chromeHsl)

  const sidebarSaturation = Math.min(chromeHsl.s, SIDEBAR_SATURATION_MAX)
  const sidebarTone = (lightness: number) =>
    formatTriplet({ h: chromeHsl.h, s: sidebarSaturation, l: lightness })

  // The gate guarantees 4.5:1 for white on the brand color, so
  // --primary-foreground is white in the light theme.
  const brandVars = [
    `  --primary: ${brandTriplet};`,
    '  --primary-foreground: 0 0% 100%;',
    `  --ring: ${brandTriplet};`,
    `  --frame: ${chromeTriplet};`,
  ].join('\n')

  // Dark theme: a dark brand color is lifted (darkModeBrandHsl) so rings and
  // primary buttons stay visible on dark surfaces. The white-text guarantee
  // only holds for the STORED color; the lifted tone may need dark button
  // text instead, so the foreground follows the same contrast math as the
  // onboarding gate.
  const darkHsl = darkModeBrandHsl(brandHsl)
  const darkTriplet = formatTriplet(darkHsl)
  const darkPrimaryForeground =
    getContrastRatio('#ffffff', hslToHex(darkHsl.h, darkHsl.s, darkHsl.l)) >= 4.5
      ? '0 0% 100%'
      : '0 0% 10%'
  const darkBrandVars = [
    `  --primary: ${darkTriplet};`,
    `  --primary-foreground: ${darkPrimaryForeground};`,
    `  --ring: ${darkTriplet};`,
    `  --frame: ${chromeTriplet};`,
  ].join('\n')

  const sidebarVars = [
    `  --foreground: ${SIDEBAR_FOREGROUND};`,
    `  --muted-foreground: ${SIDEBAR_MUTED_FOREGROUND};`,
    `  --primary: ${SIDEBAR_FOREGROUND};`,
    `  --primary-foreground: ${chromeTriplet};`,
    `  --secondary: ${sidebarTone(SIDEBAR_SECONDARY_LIGHTNESS)};`,
    `  --secondary-foreground: ${SIDEBAR_FOREGROUND};`,
    `  --muted: ${sidebarTone(SIDEBAR_MUTED_LIGHTNESS)};`,
    `  --border: ${sidebarTone(SIDEBAR_BORDER_LIGHTNESS)};`,
  ].join('\n')

  // Mobile bottom nav (WL-02 gap fix): mobile keeps the pre-frame layout, so
  // its chrome is the bottom bar, not the sidebar. Same deep-chrome
  // treatment: the bar renders on --card with --border hairlines and
  // --primary accents, so scoping those tokens to the bar re-tints it
  // exactly like the sidebar. The hook is the data-mobile-nav attribute
  // DashboardNav stamps on the bar (a class would couple this block to
  // Tailwind utility names).
  const mobileNavVars = [
    `  --card: ${chromeTriplet};`,
    `  --border: ${sidebarTone(SIDEBAR_BORDER_LIGHTNESS)};`,
    `  --muted-foreground: ${SIDEBAR_MUTED_FOREGROUND};`,
    `  --primary: ${SIDEBAR_FOREGROUND};`,
    `  --primary-foreground: ${chromeTriplet};`,
  ].join('\n')

  // `.bg-frame > aside` is the dashboard sidebar: DashboardNav's <aside> is a
  // direct child of the frame wrapper in every shell variant of
  // app/(dashboard)/layout.tsx. `bg-frame` is a locked design-system class
  // (.claude/rules/design.md), so the selector is stable.
  return [
    'html[data-brand]:not(.dark) {',
    brandVars,
    '}',
    'html[data-brand].dark {',
    darkBrandVars,
    '}',
    'html[data-brand] .bg-frame > aside {',
    sidebarVars,
    '}',
    'html[data-brand] nav[data-mobile-nav] {',
    mobileNavVars,
    '}',
  ].join('\n')
}
