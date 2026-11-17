import { afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  dialogMaxHeight,
  dialogViewportStyle,
  fitTextarea,
  textareaHeight,
  type FittableTextarea,
  type ViewportBox,
} from '../composer-fit'

/**
 * PH 216: a customer writing a ten-line message in the support dialog saw
 * only the last four lines (a fixed 120px box with resize-none) and asked how
 * to move the box to read the whole message. On their tablet the on-screen
 * keyboard also covered the lower part of the dialog.
 *
 * crm#1973: the dialog then kept its own placement (its top at the middle of
 * the visual viewport, right while every dialog was centred with a
 * transform). Dialogs became top anchored, and the support dialog's lower
 * half, the thread, the reply box and the send button, sat below the screen.
 */

/** A textarea with a 1px border whose rendered height follows style.height. */
function fakeTextarea(textHeight: number, cssMin: number): FittableTextarea {
  const style = { height: '', overflowY: '' }
  const rendered = () => (style.height === 'auto' || style.height === '' ? cssMin : Math.max(cssMin, parseFloat(style.height)))
  return {
    style,
    get offsetHeight() {
      return rendered()
    },
    get clientHeight() {
      return rendered() - 2
    },
    get scrollHeight() {
      return Math.max(textHeight, rendered() - 2)
    },
  }
}

describe('textareaHeight', () => {
  it('keeps the min height for a short message', () => {
    expect(textareaHeight({ content: 66, chrome: 300, dialogMax: 788, min: 120 })).toBe(120)
  })

  it('shows a ten-line message in full when the dialog has room for it (PH 216)', () => {
    // 13 lines at 20px plus padding and border, beside about 300px of
    // dialog chrome in a dialog that may be 616px tall: it all fits, so it
    // all shows.
    const content = 13 * 20 + 24 + 2
    expect(textareaHeight({ content, chrome: 300, dialogMax: 616, min: 120 })).toBe(content)
  })

  it('stops growing where the rest of the dialog would pass its max height', () => {
    expect(textareaHeight({ content: 2000, chrome: 300, dialogMax: 616, min: 120 })).toBe(316)
  })

  it('keeps the min height when the dialog is too short for more, so the dialog scrolls instead', () => {
    expect(textareaHeight({ content: 2000, chrome: 300, dialogMax: 368, min: 120 })).toBe(120)
  })

  it('has less room while a keyboard is up, because the dialog max height follows the visible viewport', () => {
    const withKeyboard = textareaHeight({ content: 2000, chrome: 300, dialogMax: 439, min: 80 })
    const without = textareaHeight({ content: 2000, chrome: 300, dialogMax: 616, min: 80 })
    expect(withKeyboard).toBe(139)
    expect(withKeyboard).toBeLessThan(without)
  })
})

describe('fitTextarea', () => {
  it('sizes the box to its text, border included, with no inner scrollbar', () => {
    const el = fakeTextarea(284, 120)
    const height = fitTextarea(el, { scrollHeight: 300 + 120 }, 788)
    expect(height).toBe(286)
    expect(el.style.height).toBe('286px')
    expect(el.style.overflowY).toBe('hidden')
  })

  it('caps the box and scrolls inside once the text outgrows the room', () => {
    const el = fakeTextarea(1500, 120)
    // The panel measures at the box's min height: 300px of chrome around it.
    const height = fitTextarea(el, { scrollHeight: 300 + 120 }, 616)
    expect(height).toBe(316)
    expect(el.style.overflowY).toBe('auto')
  })

  it('shrinks back to the min height when the text is cleared', () => {
    const el = fakeTextarea(1500, 120)
    fitTextarea(el, { scrollHeight: 420 }, 788)
    const shrunk = fakeTextarea(0, 120)
    shrunk.style.height = el.style.height
    expect(fitTextarea(shrunk, { scrollHeight: 420 }, 788)).toBe(120)
  })
})

describe('dialogMaxHeight', () => {
  afterEach(() => vi.unstubAllGlobals())

  const panel = {} as Element
  const computed = (maxHeight: string) => vi.stubGlobal('getComputedStyle', () => ({ maxHeight }))

  it('reads the max height the dialog has right now', () => {
    computed('359px')
    expect(dialogMaxHeight(panel, 471)).toBe(359)
  })

  it('falls back when the dialog has no max height or is not mounted yet', () => {
    computed('none')
    expect(dialogMaxHeight(panel, 471)).toBe(471)
    expect(dialogMaxHeight(null, 900)).toBe(900)
  })
})

const dialogSource = readFileSync(path.resolve(__dirname, '../../ui/dialog.tsx'), 'utf8')

/** A CSS length the dialog classes use, in px (1rem is 16px). */
function px(length: string): number {
  return length.endsWith('rem') ? parseFloat(length) * 16 : parseFloat(length)
}

/** The one length a class of the shared DialogContent adds to (top) or takes from (max-h) the viewport. */
function dialogInset(pattern: RegExp): number {
  const found = dialogSource.match(pattern)
  if (!found) throw new Error(`components/ui/dialog.tsx no longer places DialogContent with ${pattern}`)
  return px(found[1])
}

/**
 * The shared DialogContent's placement, read from its own classes, so these
 * tests follow the real numbers: `phone` below the sm breakpoint, `wide` from
 * it up.
 */
const ANCHOR = {
  phone: {
    top: dialogInset(/[" ]top-\[calc\(var\(--dialog-viewport-top,0px\)\+([\d.]+(?:px|rem))\)\]/),
    maxHeightInset: dialogInset(/[" ]max-h-\[calc\(var\(--dialog-viewport-height,100dvh\)-([\d.]+(?:px|rem))\)\]/),
  },
  wide: {
    top: dialogInset(/ sm:top-\[calc\(var\(--dialog-viewport-top,0px\)\+([\d.]+(?:px|rem))\)\]/),
    maxHeightInset: dialogInset(/ sm:max-h-\[calc\(var\(--dialog-viewport-height,100dvh\)-([\d.]+(?:px|rem))\)\]/),
  },
}

/**
 * Where the dialog lands: the classes' calc() with the two custom properties
 * the support dialog sets. `layoutHeight` is 100dvh, the fallback a dialog
 * without the properties gets.
 */
function placed(box: ViewportBox | null, anchor: { top: number; maxHeightInset: number }, layoutHeight: number) {
  const style: Record<string, unknown> = { ...dialogViewportStyle(box) }
  const viewportTop = px(String(style['--dialog-viewport-top'] ?? '0px'))
  const viewportHeight = px(String(style['--dialog-viewport-height'] ?? `${layoutHeight}px`))
  const top = viewportTop + anchor.top
  const maxHeight = Math.max(0, viewportHeight - anchor.maxHeightInset)
  return { top, maxHeight, bottom: top + maxHeight }
}

describe('dialogViewportStyle', () => {
  it('leaves the default placement alone when there is no visual viewport', () => {
    expect(dialogViewportStyle(null)).toBeUndefined()
  })

  it('hands the dialog the visible viewport and no placement of its own', () => {
    expect(dialogViewportStyle({ height: 471, offsetTop: 120 })).toEqual({
      '--dialog-viewport-top': '120px',
      '--dialog-viewport-height': '471px',
    })
  })

  it('reads the anchor every dialog has: 16px on a phone, 72px from sm up', () => {
    expect(ANCHOR.phone).toEqual({ top: 16, maxHeightInset: 32 })
    expect(ANCHOR.wide).toEqual({ top: 72, maxHeightInset: 112 })
  })

  it('sits where every other dialog sits on a desktop (crm#1973)', () => {
    // 1440x900, nothing offset. Before: top 450 and 868 tall, so the lower
    // 418px were under the screen edge.
    const support = placed({ height: 900, offsetTop: 0 }, ANCHOR.wide, 900)
    expect(support).toEqual({ top: 72, maxHeight: 788, bottom: 860 })
    expect(support).toEqual(placed(null, ANCHOR.wide, 900))
  })

  it('starts at the top of a short phone viewport and ends inside it (crm#1975)', () => {
    // 471px visible. Before: top 235.5 and 439 tall, ending at 674.5.
    expect(placed({ height: 471, offsetTop: 0 }, ANCHOR.phone, 664)).toEqual({ top: 16, maxHeight: 439, bottom: 455 })
  })

  it('stays inside the part above the keyboard on a tablet, following a panned viewport (PH 216)', () => {
    // A 768px tall tablet, the keyboard leaves 471px, panned 120px down.
    const support = placed({ height: 471, offsetTop: 120 }, ANCHOR.wide, 768)
    expect(support).toEqual({ top: 192, maxHeight: 359, bottom: 551 })
    expect(support.top).toBeGreaterThanOrEqual(120)
    expect(support.bottom).toBeLessThanOrEqual(120 + 471)
    // Without the visible viewport the same dialog would run to 728, behind the keyboard.
    expect(placed(null, ANCHOR.wide, 768).bottom).toBe(728)
  })

  it('never ends below the visible viewport, whatever a keyboard or a zoom leaves', () => {
    // From 120px of visible height: under that not even the wide anchor
    // (72px) and the dialog's own padding fit, with or without this module.
    for (const anchor of [ANCHOR.phone, ANCHOR.wide]) {
      for (let height = 120; height <= 1400; height += 7) {
        for (const offsetTop of [0, 33.5, 120, 400]) {
          const { top, bottom } = placed({ height, offsetTop }, anchor, 1400)
          expect(top).toBeGreaterThanOrEqual(offsetTop)
          expect(bottom).toBeLessThanOrEqual(offsetTop + height)
        }
      }
    }
  })
})

describe('support dialog wiring', () => {
  const source = readFileSync(path.resolve(__dirname, '../../ui/support-link.tsx'), 'utf8')

  it('fits every message box in the dialog', () => {
    const boxes = source.match(/<Textarea[\s\S]*?\/>/g) ?? []
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    for (const box of boxes) expect(box).toContain('ref={textareaRef}')
    expect(source).toContain('fitTextarea(el, panelRef.current')
  })

  it('takes the room for the message box from the dialog itself, not from a margin of its own', () => {
    expect(source).toContain('dialogMaxHeight(panelRef.current')
  })

  it('hands the dialog the visual viewport', () => {
    expect(source).toMatch(/<DialogContent[\s\S]*?ref=\{panelRef\}[\s\S]*?style=\{dialogViewportStyle\(viewport\)\}/)
  })

  it('keeps no placement of its own: the shared DialogContent owns the top and the height', () => {
    const fit = readFileSync(path.resolve(__dirname, '../composer-fit.ts'), 'utf8')
    const code = fit.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\b(top|maxHeight|marginTop|bottom)\s*:/)
  })
})
