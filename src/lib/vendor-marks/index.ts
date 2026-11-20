/**
 * A vendor's mark as the app draws it: the brand's own mark on a white chip
 * (Simple Icons, CC0), or its initials on its own colour, for the vendor a
 * name names (match.ts). Data and pure functions only; the component is
 * components/parties/BrandMark.tsx.
 *
 * Nothing here is fetched: every mark ships inside the app. For a vendor
 * without one, lib/vendor-logos fetches the vendor's own icon once per
 * domain, from the vendor's own website, into our storage; no logo service
 * is ever called, so none learns which merchants a company pays.
 */
import { VENDOR_MARKS, type VendorMarkKey } from './marks'
import { VENDOR_MONOGRAMS, type VendorMonogramKey } from './monograms'
import { vendorKeyFor, type VendorKey } from './match'

export { vendorKeyFor, vendorTokens, VENDOR_KEYS, type VendorKey } from './match'
export type { VendorMarkKey } from './marks'
export type { VendorMonogramKey } from './monograms'

export type VendorLook =
  | {
      kind: 'mark'
      key: VendorMarkKey
      title: string
      path: string
      /** The mark's colour. */
      fill: string
      /** The chip's background: white, or the brand colour when the mark would be too faint on white. */
      chip: string
    }
  | { kind: 'monogram'; key: VendorMonogramKey; title: string; initials: string; bg: string; fg: string }

/** Relative luminance of a six-digit hex colour (WCAG 2). */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG contrast ratio of two six-digit hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Below this a mark on white is too faint to read at 12px (Mailchimp's
 * yellow, Klarna's pink, Wise's green): the chip takes the brand colour and
 * the mark goes black or white, the way those brands draw their own icons.
 */
export const FAINT_ON_WHITE = 1.7

function isMarkKey(key: VendorKey): key is VendorMarkKey {
  return Object.prototype.hasOwnProperty.call(VENDOR_MARKS, key)
}

function isMonogramKey(key: VendorKey): key is VendorMonogramKey {
  return Object.prototype.hasOwnProperty.call(VENDOR_MONOGRAMS, key)
}

/** How a known vendor is drawn. */
export function vendorLook(key: VendorKey): VendorLook | null {
  if (isMarkKey(key)) {
    const mark = VENDOR_MARKS[key]
    const faint = contrast(mark.hex, 'FFFFFF') < FAINT_ON_WHITE
    const onBrand = contrast('000000', mark.hex) >= contrast('FFFFFF', mark.hex) ? '000000' : 'FFFFFF'
    return {
      kind: 'mark',
      key,
      title: mark.title,
      path: mark.path,
      fill: `#${faint ? onBrand : mark.hex}`,
      chip: `#${faint ? mark.hex : 'FFFFFF'}`,
    }
  }
  if (isMonogramKey(key)) {
    const m = VENDOR_MONOGRAMS[key]
    return { kind: 'monogram', key, title: m.title, initials: m.initials, bg: `#${m.bg}`, fg: `#${m.fg}` }
  }
  return null
}

/** The look for whatever a name names, or null when it names no vendor the app knows. */
export function vendorLookFor(name: string | null | undefined): VendorLook | null {
  const key = vendorKeyFor(name)
  return key ? vendorLook(key) : null
}
