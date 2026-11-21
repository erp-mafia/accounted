import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderInLocale } from '@/tests/i18n-render'
import { SettingsInput } from '../SettingsRows'

type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const render = (props: InputProps) => renderInLocale(createElement(SettingsInput, props), 'sv')
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? []
const attr = (tag: string | undefined, name: string) => tag?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]

// The settings date fields (fiscal year start and end, the lock date, tax
// notices, POS start) render SettingsInput, not the shared Input. They take the
// shared typed date field (crm#1954): a click places the cursor, a date can be
// typed, and the calendar opens from its icon.
describe('SettingsInput: a date field is the shared typed date field', () => {
  it('renders a text field with the calendar button', () => {
    const html = render({ type: 'date', id: 'fp_end', defaultValue: '2026-12-31' })
    const [field, calendar] = tags(html, 'input')
    expect(attr(field, 'type')).toBe('text')
    expect(attr(field, 'id')).toBe('fp_end')
    expect(attr(field, 'value')).toBe('2026-12-31')
    expect(attr(calendar, 'type')).toBe('date')
    expect(attr(tags(html, 'button')[0], 'aria-label')).toBe('Öppna kalendern')
  })

  it('keeps the boxed look and the control column sizing', () => {
    const html = render({ type: 'date', className: 'max-w-40 flex-none tabular-nums' })
    const box = (attr(tags(html, 'span')[0], 'class') ?? '').split(' ')
    const field = (attr(tags(html, 'input')[0], 'class') ?? '').split(' ')
    expect(box).toEqual(expect.arrayContaining(['min-w-0', 'max-w-40', 'flex-none']))
    expect(box).not.toContain('flex-1')
    expect(field).toEqual(expect.arrayContaining(['field-surface', 'h-8', 'tabular-nums']))
  })

  it('keeps the calendar shut on a disabled field', () => {
    expect(attr(tags(render({ type: 'date', disabled: true }), 'button')[0], 'disabled')).toBe('')
  })

  it('leaves a text field a plain boxed input', () => {
    const html = render({ type: 'text', id: 'name', defaultValue: 'Exempel AB' })
    expect(html.startsWith('<input')).toBe(true)
    expect(attr(tags(html, 'input')[0], 'class')).toContain('field-surface')
    expect(tags(html, 'button')).toHaveLength(0)
  })
})
