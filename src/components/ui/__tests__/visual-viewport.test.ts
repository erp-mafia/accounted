import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEYBOARD_FIT_ATTRIBUTE, KEYBOARD_MIN_COVER, dialogViewportStyle, keyboardCovers, revealScrollTop } from '../visual-viewport'

/**
 * On a phone the on-screen keyboard shrinks only the visual viewport, so a
 * dialog or drawer placed against the layout viewport kept its footer (Skapa
 * kund, Bokför, Spara) under the keyboard. The shared DialogContent and
 * SlideOverContent now take the visible box while a keyboard is up on a touch
 * screen, and render as before otherwise.
 */

describe('keyboardCovers', () => {
  it('counts a phone keyboard: the visible part is several hundred px shorter', () => {
    // An 844px tall phone, the keyboard leaves 508px.
    expect(keyboardCovers(844, { height: 508, scale: 1 })).toBe(true)
  })

  it('leaves a screen without a keyboard alone, toolbars and rounding included', () => {
    expect(keyboardCovers(844, { height: 844, scale: 1 })).toBe(false)
    // A collapsed toolbar makes the visible part taller, never shorter.
    expect(keyboardCovers(664, { height: 745, scale: 1 })).toBe(false)
    expect(keyboardCovers(844, { height: 844 - KEYBOARD_MIN_COVER, scale: 1 })).toBe(false)
  })

  it('never counts a pinch zoom: the visible height shrinks by the zoom only', () => {
    expect(keyboardCovers(844, { height: 422, scale: 2 })).toBe(false)
    expect(keyboardCovers(844, { height: 844 / 3, scale: 3 })).toBe(false)
  })

  it('counts a keyboard while zoomed in', () => {
    // Zoomed 2x with the keyboard leaving 508 screen px: 254 CSS px visible.
    expect(keyboardCovers(844, { height: 254, scale: 2 })).toBe(true)
  })
})

describe('revealScrollTop', () => {
  const view = { top: 216, height: 368, scrollTop: 0 }

  it('leaves a field that already sits between the top and the middle', () => {
    expect(revealScrollTop(view, { top: 216 + 40, height: 32 })).toBeNull()
    expect(revealScrollTop(view, { top: 216 + 152, height: 32 })).toBeNull()
  })

  it('brings a field the shrunk dialog left below its edge to the middle, clear of the footer', () => {
    // The last field of a form, 534px into the dialog: below the 368px it now shows.
    const next = revealScrollTop(view, { top: 216 + 534, height: 32 })
    expect(next).toBe(534 - (368 - 32) / 2)
    // Where it lands: its middle on the dialog's middle.
    expect(534 - next! + 16).toBe(368 / 2)
  })

  it('brings a field in the lower half, where a sticky footer sits, to the middle too', () => {
    expect(revealScrollTop(view, { top: 216 + 300, height: 32 })).toBe(300 - 168)
  })

  it('brings a field scrolled above the top back down to the middle, never below zero', () => {
    expect(revealScrollTop({ top: 0, height: 400, scrollTop: 500 }, { top: -100, height: 32 })).toBe(500 - 100 - 184)
    expect(revealScrollTop({ top: 0, height: 400, scrollTop: 50 }, { top: -40, height: 32 })).toBe(0)
  })

  it('puts the top of a field taller than the container at its top', () => {
    expect(revealScrollTop({ top: 0, height: 300, scrollTop: 100 }, { top: 350, height: 500 })).toBe(450)
  })
})

const source = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8')

/** A CSS length in px (1rem is 16px). */
function px(length: string): number {
  return length.endsWith('rem') ? parseFloat(length) * 16 : parseFloat(length)
}

describe('SlideOverContent placement', () => {
  const slideOver = source('slide-over.tsx')
  const top = slideOver.match(/[' ]top-\[calc\(var\(--dialog-viewport-top,0px\)\+([\d.]+(?:px|rem))\)\]/)
  const maxHeight = slideOver.match(/[' ]max-h-\[calc\(var\(--dialog-viewport-height\)-([\d.]+(?:px|rem))\)\]/)

  it('reads the visible box with the plain 10px inset when it is unset', () => {
    expect(top).not.toBeNull()
    expect(maxHeight).not.toBeNull()
    // top-2.5 before: 0.625rem.
    expect(top![1]).toBe('0.625rem')
    // No fallback: unset, the max height is invalid and so none, and the
    // drawer spans top-2.5 to bottom-2.5 exactly as before.
    expect(slideOver).toContain('bottom-2.5')
  })

  it('ends 10px above the keyboard when the box is set', () => {
    const box = { height: 471, offsetTop: 120 }
    const style = dialogViewportStyle(box) as Record<string, string>
    const placedTop = px(style['--dialog-viewport-top']) + px(top![1])
    const placedBottom = placedTop + px(style['--dialog-viewport-height']) - px(maxHeight![1])
    expect(placedTop).toBe(130)
    expect(placedBottom).toBe(120 + 471 - 10)
  })
})

describe('keyboard fit wiring', () => {
  it('marks a fitted panel with the attribute the reveal looks for', () => {
    expect(KEYBOARD_FIT_ATTRIBUTE).toBe('data-keyboard-fit')
  })

  it('fits every dialog: DialogContent renders its panel through useKeyboardFit inside the portal', () => {
    const dialog = source('dialog.tsx')
    expect(dialog).toMatch(/<DialogPortal>\s*<DialogOverlay \/>\s*<DialogPanel ref=\{ref\} \{\.\.\.props\} \/>\s*<\/DialogPortal>/)
    expect(dialog).toMatch(/const fit = useKeyboardFit\(style\)[\s\S]*?<DialogPrimitive\.Content\s+ref=\{ref\}\s+style=\{fit\.style\}\s+data-keyboard-fit=\{fit\.fitted \? "" : undefined\}/)
  })

  it('fits every drawer: SlideOverContent renders its panel through useKeyboardFit inside the portal', () => {
    const slideOver = source('slide-over.tsx')
    expect(slideOver).toMatch(/<SlideOverPanel ref=\{ref\} \{\.\.\.props\} \/>\s*<\/DialogPrimitive\.Portal>/)
    expect(slideOver).toMatch(/const fit = useKeyboardFit\(style\)[\s\S]*?<DialogPrimitive\.Content\s+ref=\{ref\}\s+style=\{fit\.style\}\s+data-keyboard-fit=\{fit\.fitted \? '' : undefined\}/)
  })
})

describe('category picker focus', () => {
  it('keeps the search from taking focus on a touch screen, so the keyboard does not cover the list', () => {
    const popover = readFileSync(join(__dirname, '../../transactions/CategoryPopover.tsx'), 'utf8')
    expect(popover).toMatch(
      /onOpenAutoFocus=\{\(e\) => \{\s*if \(!window\.matchMedia\('\(pointer: coarse\)'\)\.matches\) return\s*e\.preventDefault\(\)/,
    )
  })
})
