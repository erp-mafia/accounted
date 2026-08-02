import { describe, it, expect, vi } from 'vitest'

// brand-style imports the pure guards from resolve.ts, which pulls in the
// service-client module; mock it so the import chain is inert in node.
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(),
}))

import { hexToHslTriplet, buildBrandVarsCss } from '@/lib/branding/brand-style'
import { deriveChromeColor } from '@/lib/branding/resolve'

// Siffra blue from the WL-02 prototype: passes the white-text WCAG gate.
// Lightness ~53%, i.e. above the dark-mode lift threshold (45%).
const ACCESSIBLE_BLUE = '#2563eb'
// White text on this yellow is nowhere near 4.5:1.
const INACCESSIBLE_YELLOW = '#ffd500'
// Deep green (L ~20%): passes the white-text gate but disappears against
// dark surfaces, so the dark theme must lift it.
const DARK_GREEN = '#14532d'

describe('hexToHslTriplet', () => {
  it('converts hex to the space-separated triplet format globals.css uses', () => {
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%')
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%')
    expect(hexToHslTriplet('#2563eb')).toBe('221 83% 53%')
  })

  it('accepts uppercase hex and surrounding whitespace', () => {
    expect(hexToHslTriplet(' #2563EB ')).toBe('221 83% 53%')
  })

  it('returns null for anything that is not a 6-digit hex color', () => {
    expect(hexToHslTriplet('#fff')).toBeNull()
    expect(hexToHslTriplet('#12345')).toBeNull()
    expect(hexToHslTriplet('2563eb')).toBeNull()
    expect(hexToHslTriplet('blue')).toBeNull()
    expect(hexToHslTriplet('')).toBeNull()
  })
})

describe('buildBrandVarsCss', () => {
  it('emits the brand variables in both the light and the dark block', () => {
    const css = buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: null })
    expect(css).not.toBeNull()
    // Light: html[data-brand]:not(.dark) at (0,2,1) beats :root (0,1,0) and
    // :root[data-palette] (0,2,0). Dark: html[data-brand].dark at (0,2,1)
    // beats .dark (0,1,0) and .dark[data-palette] (0,2,0).
    expect(css).toContain('html[data-brand]:not(.dark) {')
    expect(css).toContain('html[data-brand].dark {')
    const brandTriplet = hexToHslTriplet(ACCESSIBLE_BLUE)
    const lightBlock = css!.split('html[data-brand].dark')[0]
    const darkBlock = css!.split('html[data-brand].dark')[1]
    for (const block of [lightBlock, darkBlock]) {
      expect(block).toContain(`--primary: ${brandTriplet};`)
      expect(block).toContain('--primary-foreground: 0 0% 100%;')
      expect(block).toContain(`--ring: ${brandTriplet};`)
    }
  })

  it('sets --frame to the derived chrome when no override is stored', () => {
    const css = buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: null })
    const chromeTriplet = hexToHslTriplet(deriveChromeColor(ACCESSIBLE_BLUE))
    expect(css).toContain(`--frame: ${chromeTriplet};`)
  })

  it('sets --frame to the explicit chrome override when stored', () => {
    const css = buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: '#101820' })
    expect(css).toContain(`--frame: ${hexToHslTriplet('#101820')};`)
    expect(css).not.toContain(`--frame: ${hexToHslTriplet(deriveChromeColor(ACCESSIBLE_BLUE))};`)
  })

  it('scopes light sidebar text tokens to the frame sidebar', () => {
    const css = buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: null })
    expect(css).toContain('html[data-brand] .bg-frame > aside {')
    const sidebarBlock = css!.split('.bg-frame > aside')[1]
    expect(sidebarBlock).toContain('--foreground: 0 0% 98%;')
    expect(sidebarBlock).toContain('--muted-foreground: 0 0% 75%;')
    expect(sidebarBlock).toContain('--primary: 0 0% 98%;')
    // The solid-primary chip inside the sidebar inverts onto the chrome tone.
    const chromeTriplet = hexToHslTriplet(deriveChromeColor(ACCESSIBLE_BLUE))
    expect(sidebarBlock).toContain(`--primary-foreground: ${chromeTriplet};`)
    expect(sidebarBlock).toContain('--secondary: ')
    expect(sidebarBlock).toContain('--muted: ')
    expect(sidebarBlock).toContain('--border: ')
  })

  it('lifts --primary/--ring in the dark block for a dark brand color', () => {
    const css = buildBrandVarsCss({ brandColor: DARK_GREEN, chromeColor: null })!
    const [lightBlock, darkBlock] = css.split('html[data-brand].dark')
    const source = hexToHslTriplet(DARK_GREEN)!
    // The stored color ends in its own (low) lightness; the lifted variant is
    // the same hue and saturation at 62% lightness.
    const lifted = source.replace(/\d+%$/, '62%')
    expect(lifted).not.toBe(source)
    expect(lightBlock).toContain(`--primary: ${source};`)
    expect(lightBlock).toContain(`--ring: ${source};`)
    expect(darkBlock).toContain(`--primary: ${lifted};`)
    expect(darkBlock).toContain(`--ring: ${lifted};`)
    expect(darkBlock).not.toContain(`--ring: ${source};`)
  })

  it('flips dark-mode button text dark when white fails on the lifted tone', () => {
    const css = buildBrandVarsCss({ brandColor: DARK_GREEN, chromeColor: null })!
    const [lightBlock, darkBlock] = css.split('html[data-brand].dark')
    // Light theme keeps the gate's guarantee: white on the stored color.
    expect(lightBlock).toContain('--primary-foreground: 0 0% 100%;')
    // Lifted light green cannot carry white button text.
    expect(darkBlock.split('.bg-frame')[0]).toContain('--primary-foreground: 0 0% 10%;')
  })

  it('keeps a light-enough brand color unchanged in dark mode (as today)', () => {
    const css = buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: null })!
    const darkBlock = css.split('html[data-brand].dark')[1].split('.bg-frame')[0]
    const brandTriplet = hexToHslTriplet(ACCESSIBLE_BLUE)
    expect(darkBlock).toContain(`--primary: ${brandTriplet};`)
    expect(darkBlock).toContain(`--ring: ${brandTriplet};`)
    expect(darkBlock).toContain('--primary-foreground: 0 0% 100%;')
  })

  it('scopes deep-chrome tokens to the mobile bottom nav', () => {
    const css = buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: null })!
    expect(css).toContain('html[data-brand] nav[data-mobile-nav] {')
    const navBlock = css.split('nav[data-mobile-nav]')[1]
    const chromeTriplet = hexToHslTriplet(deriveChromeColor(ACCESSIBLE_BLUE))
    // The bar renders on --card with --border hairlines: chrome tone + the
    // same calibrated light text as the sidebar.
    expect(navBlock).toContain(`--card: ${chromeTriplet};`)
    expect(navBlock).toContain('--muted-foreground: 0 0% 75%;')
    expect(navBlock).toContain('--primary: 0 0% 98%;')
    expect(navBlock).toContain(`--primary-foreground: ${chromeTriplet};`)
    expect(navBlock).toContain('--border: ')
  })

  it('fails open (null) when the brand color fails the accessibility gate', () => {
    expect(
      buildBrandVarsCss({ brandColor: INACCESSIBLE_YELLOW, chromeColor: null }),
    ).toBeNull()
  })

  it('fails open (null) on invalid brand or chrome hex', () => {
    expect(buildBrandVarsCss({ brandColor: 'not-a-color', chromeColor: null })).toBeNull()
    expect(buildBrandVarsCss({ brandColor: '#12345', chromeColor: null })).toBeNull()
    expect(
      buildBrandVarsCss({ brandColor: ACCESSIBLE_BLUE, chromeColor: 'nonsense' }),
    ).toBeNull()
  })
})
