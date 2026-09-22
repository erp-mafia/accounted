import { describe, it, expect } from 'vitest'
import { isJamkningEditable, jamkningPatch, type JamkningFormState } from '../jamkning-patch'

function state(overrides: Partial<JamkningFormState> = {}): JamkningFormState {
  return {
    f_skatt_status: 'a_skatt',
    is_sidoinkomst: false,
    jamkning_percentage: 20,
    jamkning_valid_from: '2026-01-01',
    jamkning_valid_to: '2026-12-31',
    jamkning_touched: true,
    ...overrides,
  }
}

describe('isJamkningEditable', () => {
  it('is true only for A-skatt without sidoinkomst', () => {
    expect(isJamkningEditable({ f_skatt_status: 'a_skatt', is_sidoinkomst: false })).toBe(true)
    expect(isJamkningEditable({ f_skatt_status: 'a_skatt', is_sidoinkomst: true })).toBe(false)
    expect(isJamkningEditable({ f_skatt_status: 'f_skatt', is_sidoinkomst: false })).toBe(false)
    expect(isJamkningEditable({ f_skatt_status: 'fa_skatt', is_sidoinkomst: false })).toBe(false)
    expect(isJamkningEditable({ f_skatt_status: 'not_verified', is_sidoinkomst: false })).toBe(false)
  })
})

describe('jamkningPatch', () => {
  it('sends the three keys with explicit values when the fields were visible and edited', () => {
    expect(jamkningPatch(state())).toEqual({
      jamkning_percentage: 20,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: '2026-12-31',
    })
  })

  it('sends explicit nulls when the user cleared the percentage (null = clear the beslut)', () => {
    const patch = jamkningPatch(
      state({ jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null })
    )
    expect(patch).toEqual({
      jamkning_percentage: null,
      jamkning_valid_from: null,
      jamkning_valid_to: null,
    })
    expect(Object.keys(patch)).toEqual(['jamkning_percentage', 'jamkning_valid_from', 'jamkning_valid_to'])
  })

  it('omits the keys entirely when sidoinkomst is ticked, even though the card reports nulls', () => {
    // The card hides the inputs and reports null/null/null in this branch; the
    // stored beslut must survive so it applies again when sidoinkomst is unticked.
    const patch = jamkningPatch(
      state({
        is_sidoinkomst: true,
        jamkning_percentage: null,
        jamkning_valid_from: null,
        jamkning_valid_to: null,
      })
    )
    expect(patch).toEqual({})
    expect('jamkning_percentage' in patch).toBe(false)
    expect('jamkning_valid_from' in patch).toBe(false)
    expect('jamkning_valid_to' in patch).toBe(false)
  })

  it.each(['f_skatt', 'fa_skatt', 'not_verified'])(
    'omits the keys for %s so an unrelated edit never wipes a stored beslut',
    (status) => {
      const patch = jamkningPatch(
        state({
          f_skatt_status: status,
          jamkning_percentage: null,
          jamkning_valid_from: null,
          jamkning_valid_to: null,
        })
      )
      expect(patch).toEqual({})
      expect('jamkning_percentage' in patch).toBe(false)
    }
  )

  it('omits the keys when the fields were visible but never touched (seeded from the row)', () => {
    // A row stored via the v1 API / MCP with valid_to = null is seeded into the
    // form as-is; an edit elsewhere on the page must not re-send (or alter) it.
    const patch = jamkningPatch(
      state({ jamkning_touched: false, jamkning_valid_to: null })
    )
    expect(patch).toEqual({})
    expect('jamkning_valid_to' in patch).toBe(false)
  })

  it('spreads cleanly into a sparse body', () => {
    const hidden = { first_name: 'A', ...jamkningPatch(state({ is_sidoinkomst: true })) }
    expect(Object.keys(hidden)).toEqual(['first_name'])
    const edited = { first_name: 'A', ...jamkningPatch(state()) }
    expect(Object.keys(edited)).toEqual([
      'first_name',
      'jamkning_percentage',
      'jamkning_valid_from',
      'jamkning_valid_to',
    ])
  })
})
