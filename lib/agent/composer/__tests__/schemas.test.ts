import { describe, expect, it } from 'vitest'
import { AtomSelectionSchema, ATOM_SELECTION_TOOL_SCHEMA } from '../schemas'

describe('AtomSelectionSchema', () => {
  it('accepts a minimal valid selection', () => {
    const result = AtomSelectionSchema.safeParse({
      horizontal_atoms: ['horizontal/swedish-vat'],
      vertical_atoms: [],
      modifier_atoms: [],
      is_multi_vertical: false,
      verification_questions: [],
      uncertainty_notes: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing fields', () => {
    const result = AtomSelectionSchema.safeParse({
      horizontal_atoms: ['horizontal/swedish-vat'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects wrong types', () => {
    const result = AtomSelectionSchema.safeParse({
      horizontal_atoms: 'not-an-array',
      vertical_atoms: [],
      modifier_atoms: [],
      is_multi_vertical: false,
      verification_questions: [],
      uncertainty_notes: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('ATOM_SELECTION_TOOL_SCHEMA', () => {
  it('declares the same required fields as the Zod schema', () => {
    // Sanity: both schemas must list the same required keys, or atom selection
    // requests will silently drop fields the Zod parser then rejects.
    expect(ATOM_SELECTION_TOOL_SCHEMA.required).toEqual([
      'horizontal_atoms',
      'vertical_atoms',
      'modifier_atoms',
      'is_multi_vertical',
      'verification_questions',
      'uncertainty_notes',
    ])
  })

  it('forbids additional properties so hallucinated keys fail loudly', () => {
    expect(ATOM_SELECTION_TOOL_SCHEMA.additionalProperties).toBe(false)
  })
})
