import { describe, it, expect } from 'vitest'
import {
  applyNoteOverrides,
  editableNoteKeyForTitle,
  normalizeNoteOverrides,
} from '../note-overrides'
import type { NoteEntry } from '../types'

const notes: NoteEntry[] = [
  { number: 1, title: 'Redovisnings- och värderingsprinciper', body: 'Genererad princip.' },
  { number: 2, title: 'Medelantal anställda', body: 'Två.' },
  { number: 3, title: 'Väsentliga händelser efter balansdagen', body: 'Inga.' },
]

describe('normalizeNoteOverrides', () => {
  it('keeps known keys with text and drops blanks, unknown keys and non-strings', () => {
    expect(
      normalizeNoteOverrides({
        redovisningsprinciper: 'Egen.',
        vasentliga_handelser_efter_balansdagen: '  ',
        medelantal_anstallda: 'Tio.',
        other: 3,
      }),
    ).toEqual({ redovisningsprinciper: 'Egen.' })
  })

  it('returns an empty object for anything that is not an object', () => {
    expect(normalizeNoteOverrides(null)).toEqual({})
    expect(normalizeNoteOverrides('x')).toEqual({})
    expect(normalizeNoteOverrides(['x'])).toEqual({})
  })
})

describe('applyNoteOverrides', () => {
  it('replaces the body of an overridden note and keeps the generated text', () => {
    const result = applyNoteOverrides(notes, { redovisningsprinciper: 'Egen.' })
    expect(result[0]).toEqual({
      number: 1,
      title: 'Redovisnings- och värderingsprinciper',
      body: 'Egen.',
      key: 'redovisningsprinciper',
      generated_body: 'Genererad princip.',
    })
  })

  it('tags editable notes without an override and leaves computed notes alone', () => {
    const result = applyNoteOverrides(notes, {})
    expect(result[1]).toBe(notes[1])
    expect(result[2]).toEqual({ ...notes[2], key: 'vasentliga_handelser_efter_balansdagen' })
    expect(result[2].generated_body).toBeUndefined()
  })

  it('maps titles to keys', () => {
    expect(editableNoteKeyForTitle('Medelantal anställda')).toBeNull()
    expect(editableNoteKeyForTitle('Redovisnings- och värderingsprinciper')).toBe('redovisningsprinciper')
  })
})
