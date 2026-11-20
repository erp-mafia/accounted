import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Input, openNativePicker } from '../input'

function field(type: string, extra: { disabled?: boolean; readOnly?: boolean; showPicker?: () => void } = {}) {
  return { type, disabled: false, readOnly: false, showPicker: vi.fn(), ...extra }
}

// Chromium opens a native date input's calendar only from the icon at the
// right edge; a click on the text did nothing visible, and those fields were
// nearly every rage-clicked input in the app.
describe('Input: a click on a date field opens its calendar', () => {
  it.each(['date', 'datetime-local', 'month', 'week'])('opens the picker for type=%s', (type) => {
    const input = field(type)
    openNativePicker(input)
    expect(input.showPicker).toHaveBeenCalledTimes(1)
  })

  it.each(['text', 'number', 'email', 'search', 'time', 'checkbox'])('leaves type=%s alone', (type) => {
    const input = field(type)
    openNativePicker(input)
    expect(input.showPicker).not.toHaveBeenCalled()
  })

  it('does not open a disabled or read-only field', () => {
    const disabled = field('date', { disabled: true })
    const readOnly = field('date', { readOnly: true })
    openNativePicker(disabled)
    openNativePicker(readOnly)
    expect(disabled.showPicker).not.toHaveBeenCalled()
    expect(readOnly.showPicker).not.toHaveBeenCalled()
  })

  it('does nothing where the browser has no showPicker', () => {
    expect(() => openNativePicker({ type: 'date', disabled: false, readOnly: false })).not.toThrow()
  })

  it('keeps the browser behaviour when the picker is refused', () => {
    const input = field('date', {
      showPicker: () => {
        throw new DOMException('not allowed', 'NotAllowedError')
      },
    })
    expect(() => openNativePicker(input)).not.toThrow()
  })

  it('still renders the same input', () => {
    const html = renderToString(createElement(Input, { type: 'date', id: 'd', defaultValue: '2026-10-28' }))
    expect(html).toContain('type="date"')
    expect(html).toContain('id="d"')
    expect(html).toContain('value="2026-10-28"')
  })
})
