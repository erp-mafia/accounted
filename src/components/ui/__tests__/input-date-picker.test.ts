import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderInLocale } from '@/tests/i18n-render'
import { Input, type InputProps } from '../input'

const render = (props: InputProps, locale: 'sv' | 'en' = 'sv') => renderInLocale(createElement(Input, props), locale)
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? []
const attr = (tag: string | undefined, name: string) => tag?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]

// crm#1954: a click on a date field opened the native calendar (showPicker),
// which in Chromium and Edge left no way to type a date. A date field is now a
// text field a date can be typed into, and the calendar opens from its icon.
describe('Input type="date": a typed date field with the calendar on its icon', () => {
  it('renders a text field that takes the typing, first in the box', () => {
    const html = render({ type: 'date', id: 'd', name: 'entry_date', defaultValue: '2026-10-28' })
    const [field, calendar] = tags(html, 'input')
    expect(attr(field, 'type')).toBe('text')
    expect(attr(field, 'id')).toBe('d')
    expect(attr(field, 'name')).toBe('entry_date')
    expect(attr(field, 'value')).toBe('2026-10-28')
    expect(attr(field, 'autoComplete')).toBe('off')
    expect(attr(calendar, 'type')).toBe('date')
  })

  it('shows a controlled value', () => {
    const [field] = tags(render({ type: 'date', value: '2026-11-20', onChange: () => {} }), 'input')
    expect(attr(field, 'value')).toBe('2026-11-20')
  })

  it('opens the calendar from a labelled button outside the tab order, not from the text', () => {
    const [button] = tags(render({ type: 'date' }), 'button')
    expect(attr(button, 'type')).toBe('button')
    expect(attr(button, 'aria-label')).toBe('Öppna kalendern')
    expect(attr(button, 'tabindex')).toBe('-1')
    expect(attr(button, 'disabled')).toBeUndefined()
  })

  it('keeps the native calendar input hidden, out of the tab order and out of every form', () => {
    const [, calendar] = tags(render({ type: 'date', min: '2026-01-01', max: '2026-12-31' }), 'input')
    expect(attr(calendar, 'aria-hidden')).toBe('true')
    expect(attr(calendar, 'tabindex')).toBe('-1')
    expect(attr(calendar, 'form')).toBe('date-field-calendar')
    expect(attr(calendar, 'name')).toBeUndefined()
    expect(attr(calendar, 'min')).toBe('2026-01-01')
    expect(attr(calendar, 'max')).toBe('2026-12-31')
    expect(attr(calendar, 'class')).toContain('pointer-events-none')
  })

  it('shows the format while empty, in the user language', () => {
    const sv = render({ type: 'date' })
    const en = render({ type: 'date' }, 'en')
    expect(attr(tags(sv, 'input')[0], 'placeholder')).toBe('ÅÅÅÅ-MM-DD')
    expect(attr(tags(en, 'input')[0], 'placeholder')).toBe('YYYY-MM-DD')
    expect(attr(tags(en, 'button')[0], 'aria-label')).toBe('Open the calendar')
    expect(attr(tags(render({ type: 'date', placeholder: 'Valfritt' }), 'input')[0], 'placeholder')).toBe('Valfritt')
  })

  it('keeps the calendar shut on a disabled or read-only field', () => {
    for (const props of [{ disabled: true }, { readOnly: true }]) {
      expect(attr(tags(render({ type: 'date', ...props }), 'button')[0], 'disabled')).toBe('')
    }
    expect(attr(tags(render({ type: 'date', disabled: true }), 'input')[0], 'disabled')).toBe('')
    expect(attr(tags(render({ type: 'date', readOnly: true }), 'input')[0], 'readOnly')).toBe('')
  })

  it('puts the classes that place the field on its box and the rest on the text field', () => {
    const html = render({ type: 'date', className: 'mt-1 h-9 w-40 tabular-nums' })
    const box = (attr(tags(html, 'span')[0], 'class') ?? '').split(' ')
    const field = (attr(tags(html, 'input')[0], 'class') ?? '').split(' ')
    expect(box).toEqual(expect.arrayContaining(['relative', 'block', 'w-40', 'mt-1']))
    expect(box).not.toContain('w-full')
    expect(box).not.toContain('tabular-nums')
    expect(field).toEqual(expect.arrayContaining(['field-surface', 'w-full', 'h-9', 'tabular-nums', 'pr-8']))
  })

  it('leaves the other input types alone', () => {
    const html = render({ type: 'number', id: 'n', defaultValue: 5 })
    expect(html.startsWith('<input')).toBe(true)
    expect(attr(tags(html, 'input')[0], 'type')).toBe('number')
    expect(tags(html, 'button')).toHaveLength(0)
  })
})
