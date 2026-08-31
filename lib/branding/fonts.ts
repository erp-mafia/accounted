/**
 * Curated brand font menu (WL-03).
 *
 * `next/font` is strictly build-time, so a brand can never bring an arbitrary
 * font; it picks from this menu via `brands.font_key`. The delivery pattern
 * (documented in WL-03's research) is zero-client-JS:
 *
 *   - every menu font is registered in app/layout.tsx via `next/font` and its
 *     `.variable` class sits on <html> on every host,
 *   - the active pair is selected per request by setting `--font-display` /
 *     `--font-body` as inline style on <html>, which beats the `:root`
 *     declarations in app/globals.css.
 *
 * The menu: `'default'` is Hedvig Letters Serif + Geist, exactly today's
 * pair, already declared in globals.css. `null` therefore means "no
 * per-request override", which keeps default hosts byte-identical. The three
 * curated pairs below (all Google Fonts, OFL) are registered in
 * app/layout.tsx with `preload: false` (WL-03: only the default pair may
 * preload; a preloading menu font would be downloaded by every visitor on
 * every host), so a menu font costs nothing until a brand actually selects
 * it and the browser resolves its `var()`.
 *
 * Adding a menu font is one entry + one registration:
 *   1. register it in app/layout.tsx via `next/font` with `preload: false`,
 *   2. append its `.variable` class to the <html> className list there,
 *   3. add one entry here mapping the new font_key to its variable pair.
 */

export interface BrandFontPair {
  /** Value for the `--font-display` CSS variable. */
  display: string
  /** Value for the `--font-body` CSS variable. */
  body: string
}

export const DEFAULT_FONT_KEY = 'default'

const FONT_MENU: Record<string, BrandFontPair | null> = {
  [DEFAULT_FONT_KEY]: null,
  // Lora + Source Sans 3: warm bookish serif over a neutral workhorse sans;
  // the closest in spirit to the default pair without echoing it.
  lora: {
    display: 'var(--font-lora), Georgia, serif',
    body: 'var(--font-source-sans), system-ui, sans-serif',
  },
  // Fraunces + Work Sans: characterful old-style display with a plain
  // geometric body; the most distinctive of the three.
  fraunces: {
    display: 'var(--font-fraunces), Georgia, serif',
    body: 'var(--font-work-sans), system-ui, sans-serif',
  },
  // Playfair Display + Public Sans: high-contrast editorial serif over the
  // sober USWDS sans; the most formal of the three.
  playfair: {
    display: 'var(--font-playfair), Georgia, serif',
    body: 'var(--font-public-sans), system-ui, sans-serif',
  },
}

/**
 * Resolve a brand's font_key to the CSS variable pair to set on <html>.
 * Returns null for the default pair and for unknown keys (fail open to the
 * globals.css defaults; an unknown key must never break rendering).
 */
export function getBrandFontPair(fontKey: string): BrandFontPair | null {
  if (Object.prototype.hasOwnProperty.call(FONT_MENU, fontKey)) {
    return FONT_MENU[fontKey]
  }
  return FONT_MENU[DEFAULT_FONT_KEY]
}
