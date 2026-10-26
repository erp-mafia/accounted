import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  DIALOG_VIEWPORT_MARGIN_PX,
  dialogViewportStyle,
  fitTextarea,
  textareaHeight,
  type FittableTextarea,
} from '../composer-fit'

/**
 * PH 216: a customer writing a ten-line message in the support dialog saw
 * only the last four lines (a fixed 120px box with resize-none) and asked how
 * to move the box to read the whole message. On their tablet the on-screen
 * keyboard also covered the lower part of the dialog.
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
    expect(textareaHeight({ content: 66, chrome: 300, viewport: 900, min: 120 })).toBe(120)
  })

  it('shows a ten-line message in full when the viewport has room for it (PH 216)', () => {
    // 13 lines at 20px plus padding and border, beside about 300px of
    // dialog chrome in a 648px tall viewport: it all fits, so it all shows.
    const content = 13 * 20 + 24 + 2
    expect(textareaHeight({ content, chrome: 300, viewport: 648, min: 120 })).toBe(content)
  })

  it('stops growing where the rest of the dialog would leave the viewport', () => {
    const room = 648 - DIALOG_VIEWPORT_MARGIN_PX - 300
    expect(textareaHeight({ content: 2000, chrome: 300, viewport: 648, min: 120 })).toBe(room)
  })

  it('keeps the min height when the viewport is too short for more, so the dialog scrolls instead', () => {
    expect(textareaHeight({ content: 2000, chrome: 300, viewport: 400, min: 120 })).toBe(120)
  })

  it('follows the visible viewport, not the layout one, while a keyboard is up', () => {
    const withKeyboard = textareaHeight({ content: 2000, chrome: 300, viewport: 471, min: 80 })
    const without = textareaHeight({ content: 2000, chrome: 300, viewport: 648, min: 80 })
    expect(withKeyboard).toBe(471 - DIALOG_VIEWPORT_MARGIN_PX - 300)
    expect(withKeyboard).toBeLessThan(without)
  })
})

describe('fitTextarea', () => {
  it('sizes the box to its text, border included, with no inner scrollbar', () => {
    const el = fakeTextarea(284, 120)
    const height = fitTextarea(el, { scrollHeight: 300 + 120 }, 900)
    expect(height).toBe(286)
    expect(el.style.height).toBe('286px')
    expect(el.style.overflowY).toBe('hidden')
  })

  it('caps the box and scrolls inside once the text outgrows the room', () => {
    const el = fakeTextarea(1500, 120)
    // The panel measures at the box's min height: 300px of chrome around it.
    const height = fitTextarea(el, { scrollHeight: 300 + 120 }, 648)
    expect(height).toBe(648 - DIALOG_VIEWPORT_MARGIN_PX - 300)
    expect(el.style.overflowY).toBe('auto')
  })

  it('shrinks back to the min height when the text is cleared', () => {
    const el = fakeTextarea(1500, 120)
    fitTextarea(el, { scrollHeight: 420 }, 900)
    const shrunk = fakeTextarea(0, 120)
    shrunk.style.height = el.style.height
    expect(fitTextarea(shrunk, { scrollHeight: 420 }, 900)).toBe(120)
  })
})

describe('dialogViewportStyle', () => {
  it('leaves the default placement alone when there is no visual viewport', () => {
    expect(dialogViewportStyle(null)).toBeUndefined()
  })

  it('centers the dialog in the visible part above the keyboard and caps it there', () => {
    expect(dialogViewportStyle({ height: 471, offsetTop: 0 })).toEqual({ top: 235.5, maxHeight: 439 })
  })

  it('follows a panned visual viewport', () => {
    expect(dialogViewportStyle({ height: 300, offsetTop: 120 })).toEqual({ top: 270, maxHeight: 268 })
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

  it('places the dialog by the visual viewport', () => {
    expect(source).toMatch(/<DialogContent[\s\S]*?ref=\{panelRef\}[\s\S]*?style=\{dialogViewportStyle\(viewport\)\}/)
  })
})
