import { describe, expect, it, vi } from 'vitest'
import { createElement, type MouseEvent, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { SettingsInput } from '../SettingsRows'

type InputProps = React.InputHTMLAttributes<HTMLInputElement>

function field(type: string, extra: { disabled?: boolean; readOnly?: boolean } = {}) {
  return { type, disabled: false, readOnly: false, showPicker: vi.fn(), ...extra }
}

function click(props: InputProps, target: ReturnType<typeof field>, defaultPrevented = false) {
  const element = SettingsInput(props) as ReactElement<InputProps>
  element.props.onClick?.({ currentTarget: target, defaultPrevented } as unknown as MouseEvent<HTMLInputElement>)
}

// The settings date fields (fiscal year start and end, the lock date, tax
// notices, POS start) render SettingsInput, a plain <input>, not the shared
// Input: they missed the click-opens-calendar fix, and Chromium opens the
// calendar only from the small icon at the right edge.
describe('SettingsInput: a click on a date field opens its calendar', () => {
  it('opens the picker for a date field', () => {
    const input = field('date')
    click({ type: 'date' }, input)
    expect(input.showPicker).toHaveBeenCalledTimes(1)
  })

  it('leaves a text field alone', () => {
    const input = field('text')
    click({ type: 'text' }, input)
    expect(input.showPicker).not.toHaveBeenCalled()
  })

  it('does not open a disabled date field', () => {
    const input = field('date', { disabled: true })
    click({ type: 'date', disabled: true }, input)
    expect(input.showPicker).not.toHaveBeenCalled()
  })

  it("runs the caller's onClick first and respects preventDefault", () => {
    const onClick = vi.fn()
    const input = field('date')
    click({ type: 'date', onClick }, input, true)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(input.showPicker).not.toHaveBeenCalled()
  })

  it('still renders the same boxed input', () => {
    const html = renderToString(createElement(SettingsInput, { type: 'date', id: 'fp_end', defaultValue: '2026-12-31' }))
    expect(html).toContain('type="date"')
    expect(html).toContain('id="fp_end"')
    expect(html).toContain('value="2026-12-31"')
    expect(html).toContain('h-9')
  })
})
