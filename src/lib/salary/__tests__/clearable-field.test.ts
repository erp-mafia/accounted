/**
 * clearableField: what the employee edit form sends for an optional field it
 * loaded from the row (#3008). An emptied field must reach the PATCH as null
 * (clear), an untouched empty one must stay out of it.
 */
import { describe, expect, it } from 'vitest'
import { clearableField } from '../clearable-field'

describe('clearableField', () => {
  it('sends a typed value as is', () => {
    expect(clearableField('2026-06-30', null)).toBe('2026-06-30')
    expect(clearableField('2026-06-30', '2026-12-31')).toBe('2026-06-30')
  })

  it('sends null when the user emptied a field the row had a value for', () => {
    expect(clearableField('', '2026-06-30')).toBeNull()
  })

  it('treats a whitespace-only input as emptied', () => {
    expect(clearableField('   ', 'anna@example.test')).toBeNull()
  })

  it('omits the key when the field was empty on load and still is', () => {
    expect(clearableField('', null)).toBeUndefined()
    expect(clearableField('', undefined)).toBeUndefined()
    expect(clearableField('', '')).toBeUndefined()
  })

  it('omits the key when the input was not rendered or was disabled (FormData.get returned null)', () => {
    expect(clearableField(null, '2026-06-30')).toBeUndefined()
  })
})
