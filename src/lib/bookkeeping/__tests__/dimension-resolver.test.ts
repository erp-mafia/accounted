import { describe, it, expect } from 'vitest'
import {
  normalizeLineDimensions,
  coerceDimensionsBag,
  validateEntryDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
// Imported from errors.ts on purpose: proves the re-export surface every
// server consumer uses (the class itself lives in dimension-errors.ts).
import { DimensionValidationError } from '@/lib/bookkeeping/errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('normalizeLineDimensions', () => {
  it('returns empty map for a line with no dimension data', () => {
    expect(normalizeLineDimensions({})).toEqual({})
    expect(normalizeLineDimensions({ cost_center: null, project: null })).toEqual({})
  })

  it('maps the deprecated aliases to SIE keys 1 and 6', () => {
    expect(normalizeLineDimensions({ cost_center: 'KS01', project: 'P001' })).toEqual({
      '1': 'KS01',
      '6': 'P001',
    })
  })

  it('passes an explicit bag through', () => {
    expect(normalizeLineDimensions({ dimensions: { '1': 'KS01', '7': 'ANST-4' } })).toEqual({
      '1': 'KS01',
      '7': 'ANST-4',
    })
  })

  it('lets the explicit bag win over aliases per key', () => {
    expect(
      normalizeLineDimensions({
        dimensions: { '1': 'KS-BAG' },
        cost_center: 'KS-ALIAS',
        project: 'P-ALIAS',
      })
    ).toEqual({ '1': 'KS-BAG', '6': 'P-ALIAS' })
  })

  it('treats an explicit empty string in the bag as clearing that dimension', () => {
    expect(
      normalizeLineDimensions({ dimensions: { '1': '' }, cost_center: 'KS-ALIAS' })
    ).toEqual({})
  })

  it('trims whitespace and drops blank values', () => {
    expect(
      normalizeLineDimensions({ dimensions: { '6': '  P001  ' }, cost_center: '   ' })
    ).toEqual({ '6': 'P001' })
  })

  it('drops non-numeric and zero/negative keys', () => {
    expect(
      normalizeLineDimensions({
        dimensions: { projekt: 'X', '0': 'Y', '6': 'P001' } as Record<string, string>,
      })
    ).toEqual({ '6': 'P001' })
  })

  it("canonicalizes leading-zero keys ('01' -> '1') so the generated mirrors derive", () => {
    // The DB generates cost_center/project from keys '1'/'6' (PR9 cutover):
    // '01' must land on '1' or the generated mirror misses the value.
    const dims = normalizeLineDimensions({ dimensions: { '01': 'KS01', '06': 'P001' } })
    expect(dims).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it("clearing via a leading-zero key ('01': '') also clears the alias-filled '1'", () => {
    expect(
      normalizeLineDimensions({ dimensions: { '01': '' }, cost_center: 'KS-ALIAS' })
    ).toEqual({})
  })

  it('reversal parity: empty bag + populated aliases equals alias-only input', () => {
    // reverseEntry passes {dimensions: {}, cost_center, project} for legacy
    // rows; storno passes the row directly: both must normalize identically.
    expect(
      normalizeLineDimensions({ dimensions: {}, cost_center: 'KS01', project: 'P001' })
    ).toEqual(normalizeLineDimensions({ cost_center: 'KS01', project: 'P001' }))
  })
})

describe('coerceDimensionsBag (boundary validator for staged payloads)', () => {
  it('returns undefined for non-objects', () => {
    expect(coerceDimensionsBag(undefined)).toBeUndefined()
    expect(coerceDimensionsBag(null)).toBeUndefined()
    expect(coerceDimensionsBag('P001')).toBeUndefined()
    expect(coerceDimensionsBag(['6', 'P001'])).toBeUndefined()
  })

  it('accepts a valid bag and normalizes values', () => {
    expect(coerceDimensionsBag({ '6': ' P001 ', '1': 'KS01' })).toEqual({
      '6': 'P001',
      '1': 'KS01',
    })
  })

  it('rejects the WHOLE bag on any invalid entry: same as the API schema', () => {
    // Numeric value (no silent coercion), invalid key, leading-zero key:
    // exactly what CreateJournalEntryLineSchema would reject.
    expect(coerceDimensionsBag({ '6': 42 })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 42, '1': 'KS01' })).toBeUndefined()
    expect(coerceDimensionsBag({ projekt: 'P001', '6': 'P001' })).toBeUndefined()
    expect(coerceDimensionsBag({ '06': 'P001' })).toBeUndefined()
  })

  it('enforces the same length/charset constraints as the Zod line schema', () => {
    expect(coerceDimensionsBag({ '6': 'x'.repeat(41) })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 'P"1' })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 'P{1}' })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 'x'.repeat(40) })).toEqual({ '6': 'x'.repeat(40) })
  })

  it('returns undefined for an empty or whitespace-only bag', () => {
    expect(coerceDimensionsBag({})).toBeUndefined()
  })
})

// lineDimensionColumns() tests were removed with the function in the PR9
// cutover: mirror derivation now lives in the database as GENERATED columns
// and is covered by tests/pg/dimensions-generated-cutover.pg.test.ts.

describe('validateEntryDimensions (soft registry validation, PR3)', () => {
  const enabledSettings = { data: { dimensions_enabled: true } }
  const registry = {
    data: [
      { id: 'dim-ks', sie_dim_no: 1, name: 'Kostnadsställe' },
      { id: 'dim-proj', sie_dim_no: 6, name: 'Projekt' },
    ],
  }

  function queriedTables(q: ReturnType<typeof createQueuedMockSupabase>): string[] {
    return q.supabase.from.mock.calls.map((call) => call[0] as string)
  }

  function run(
    q: ReturnType<typeof createQueuedMockSupabase>,
    lines: Parameters<typeof validateEntryDimensions>[2]
  ) {
    return validateEntryDimensions(q.supabase as unknown as SupabaseClient, 'company-1', lines)
  }

  it('makes ZERO queries when no line carries a dimension', async () => {
    const q = createQueuedMockSupabase()
    await expect(
      run(q, [
        { dimensions: {} },
        { cost_center: null, project: null },
        {},
      ])
    ).resolves.toBeUndefined()
    expect(q.supabase.from).not.toHaveBeenCalled()
  })

  it('passes through without registry queries when dimensions_enabled is false', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: { dimensions_enabled: false } })
    await expect(run(q, [{ dimensions: { '6': 'HELT-OKÄND' } }])).resolves.toBeUndefined()
    expect(queriedTables(q)).toEqual(['company_settings'])
  })

  it('passes through when the company has no settings row (backward compatible)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null })
    await expect(run(q, [{ dimensions: { '6': 'P001' } }])).resolves.toBeUndefined()
    expect(queriedTables(q)).toEqual(['company_settings'])
  })

  it('fails open when the settings query errors (soft validation never blocks)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: { message: 'column does not exist' } })
    await expect(run(q, [{ dimensions: { '6': 'P001' } }])).resolves.toBeUndefined()
  })

  it('rejects an unknown dimension number when enabled', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue({ data: [] }) // no registry row for dim 9
    const promise = run(q, [{ dimensions: { '9': 'X' } }])
    await expect(promise).rejects.toBeInstanceOf(DimensionValidationError)
    await expect(promise).rejects.toMatchObject({
      code: 'DIMENSION_VALIDATION_FAILED',
      issues: [{ sie_dim_no: '9', code: null, reason: 'unknown_dimension' }],
    })
    await expect(promise).rejects.toThrow(
      'Okänd dimension 9. Skapa dimensionen i registret först.'
    )
    // All dims unknown → the values query is skipped entirely.
    expect(queriedTables(q)).toEqual(['company_settings', 'dimensions'])
  })

  it('rejects a code with no dimension_values row', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue(registry)
    q.enqueue({ data: [] })
    const promise = run(q, [{ dimensions: { '6': 'X' } }])
    await expect(promise).rejects.toMatchObject({
      issues: [{ sie_dim_no: '6', code: 'X', reason: 'unknown_value', dimension_name: 'Projekt' }],
    })
    await expect(promise).rejects.toThrow(
      'Okänt värde "X" i Projekt (dimension 6). Skapa värdet i registret först.'
    )
  })

  it('names a custom dimension by its registry name, never as kostnadsställe/projekt', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue({ data: [{ id: 'dim-kb', sie_dim_no: 21, name: 'Kostnadsbärare' }] })
    q.enqueue({ data: [{ dimension_id: 'dim-kb', code: 'KB-GAMMAL', is_active: false }] })
    const promise = run(q, [{ dimensions: { '21': 'KB7' } }, { dimensions: { '21': 'KB-GAMMAL' } }])
    await expect(promise).rejects.toMatchObject({
      issues: [
        { sie_dim_no: '21', code: 'KB7', reason: 'unknown_value', dimension_name: 'Kostnadsbärare' },
        { sie_dim_no: '21', code: 'KB-GAMMAL', reason: 'archived_value', dimension_name: 'Kostnadsbärare' },
      ],
    })
    await expect(promise).rejects.toThrow(
      'Okänt värde "KB7" i Kostnadsbärare (dimension 21). Skapa värdet i registret först. ' +
        '"KB-GAMMAL" i Kostnadsbärare (dimension 21) är arkiverat: återaktivera värdet för att använda det.'
    )
    await expect(promise).rejects.not.toThrow(/kostnadsställe\/projekt/i)
  })

  it('rejects an archived (is_active = false) value', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue(registry)
    q.enqueue({ data: [{ dimension_id: 'dim-proj', code: 'X', is_active: false }] })
    const promise = run(q, [{ dimensions: { '6': 'X' } }])
    await expect(promise).rejects.toMatchObject({
      issues: [{ sie_dim_no: '6', code: 'X', reason: 'archived_value' }],
    })
    await expect(promise).rejects.toThrow(
      '"X" i Projekt (dimension 6) är arkiverat: återaktivera värdet för att använda det.'
    )
  })

  it('rejects every code of an archived dimension, even an active value, without a value lookup', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue({ data: [{ id: 'dim-kb', sie_dim_no: 21, name: 'Kostnadsbärare', is_active: false }] })
    const promise = run(q, [{ dimensions: { '21': 'KB1' } }, { dimensions: { '21': 'KB2' } }])
    await expect(promise).rejects.toBeInstanceOf(DimensionValidationError)
    await expect(promise).rejects.toMatchObject({
      issues: [
        { sie_dim_no: '21', code: 'KB1', reason: 'archived_dimension', dimension_name: 'Kostnadsbärare' },
        { sie_dim_no: '21', code: 'KB2', reason: 'archived_dimension', dimension_name: 'Kostnadsbärare' },
      ],
    })
    await expect(promise).rejects.toThrow(
      '"KB1" i Kostnadsbärare (dimension 21): dimensionen är arkiverad. Återaktivera dimensionen för att använda värdet.'
    )
    // The archived dimension was the only one referenced: no value query.
    expect(queriedTables(q)).toEqual(['company_settings', 'dimensions'])
  })

  it('judges an archived dimension apart from the active ones in the same entry', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue({
      data: [
        { id: 'dim-proj', sie_dim_no: 6, name: 'Projekt', is_active: true },
        { id: 'dim-kb', sie_dim_no: 21, name: 'Kostnadsbärare', is_active: false },
      ],
    })
    q.enqueue({ data: [{ dimension_id: 'dim-proj', code: 'P001', is_active: true }] })
    const promise = run(q, [{ dimensions: { '6': 'P001', '21': 'KB1' } }])
    await expect(promise).rejects.toMatchObject({
      issues: [{ sie_dim_no: '21', code: 'KB1', reason: 'archived_dimension' }],
    })
    // Only the active dimension's values are looked up.
    const valueLookup = q.findCall('dimension_values', 'in')
    expect(valueLookup).toEqual(['dimension_id', ['dim-proj']])
  })

  it('accepts valid active codes: three queries total, never per line', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue(registry)
    q.enqueue({
      data: [
        { dimension_id: 'dim-ks', code: 'KS01', is_active: true },
        { dimension_id: 'dim-proj', code: 'P001', is_active: true },
      ],
    })
    await expect(
      run(q, [
        { dimensions: { '1': 'KS01', '6': 'P001' } },
        { dimensions: { '6': 'P001' } },
        { cost_center: 'KS01' }, // deprecated alias participates too
        {}, // untagged line adds nothing
      ])
    ).resolves.toBeUndefined()
    expect(queriedTables(q)).toEqual(['company_settings', 'dimensions', 'dimension_values'])
  })

  it('does not false-pass when the same code exists under a different dimension', async () => {
    // "100" is a registered kostnadsställe but the line tags it as projekt:
    // lookups key on (dimension_id, code), so this must still reject.
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue(registry)
    q.enqueue({ data: [{ dimension_id: 'dim-ks', code: '100', is_active: true }] })
    await expect(run(q, [{ dimensions: { '6': '100' } }])).rejects.toMatchObject({
      issues: [{ sie_dim_no: '6', code: '100', reason: 'unknown_value' }],
    })
  })

  it('collects every offending code into one rejection', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue(registry)
    q.enqueue({ data: [{ dimension_id: 'dim-ks', code: 'KS-GAMMAL', is_active: false }] })
    const promise = run(q, [
      { dimensions: { '9': 'X' } },
      { dimensions: { '1': 'KS-GAMMAL' } },
      { dimensions: { '6': 'P999' } },
    ])
    await expect(promise).rejects.toMatchObject({
      issues: [
        { sie_dim_no: '9', code: null, reason: 'unknown_dimension' },
        { sie_dim_no: '1', code: 'KS-GAMMAL', reason: 'archived_value' },
        { sie_dim_no: '6', code: 'P999', reason: 'unknown_value' },
      ],
    })
  })

  it('fails open when a registry query errors', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue(enabledSettings)
    q.enqueue({ data: null, error: { message: 'transient' } })
    await expect(run(q, [{ dimensions: { '6': 'P001' } }])).resolves.toBeUndefined()
  })
})
