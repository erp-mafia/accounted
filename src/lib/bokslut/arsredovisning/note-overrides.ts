import type { NoteEntry } from './types'

/**
 * User-edited note texts for the K3 årsredovisning.
 *
 * The generated text stays the default; an override replaces only the body
 * of one note, keyed by a stable note key (never the note number, which
 * shifts with the notes present). Only text notes are editable: a note whose
 * body is computed from the books (anläggningstillgångar, medelantal,
 * uppskjutna skatter, aktiekapital) must keep tying to the statements, and
 * the ställda säkerheter / eventualförpliktelser / koncern notes already
 * have their own fields.
 */
export const EDITABLE_NOTE_KEYS = [
  'redovisningsprinciper',
  'vasentliga_handelser_efter_balansdagen',
] as const

export type EditableNoteKey = (typeof EDITABLE_NOTE_KEYS)[number]

export type NoteOverrides = Partial<Record<EditableNoteKey, string>>

/** Max length of one override (API cap; the DB CHECK bounds the whole object). */
export const NOTE_OVERRIDE_MAX_LENGTH = 8000

const TITLE_BY_KEY: Record<EditableNoteKey, string> = {
  redovisningsprinciper: 'Redovisnings- och värderingsprinciper',
  vasentliga_handelser_efter_balansdagen: 'Väsentliga händelser efter balansdagen',
}

export function isEditableNoteKey(value: string): value is EditableNoteKey {
  return (EDITABLE_NOTE_KEYS as readonly string[]).includes(value)
}

export function editableNoteKeyForTitle(title: string): EditableNoteKey | null {
  for (const key of EDITABLE_NOTE_KEYS) {
    if (TITLE_BY_KEY[key] === title) return key
  }
  return null
}

/**
 * Keep only known keys with non-blank text. Blank means "use the generated
 * text", so it is dropped rather than stored.
 */
export function normalizeNoteOverrides(value: unknown): NoteOverrides {
  const result: NoteOverrides = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (!isEditableNoteKey(key) || typeof text !== 'string') continue
    if (text.trim() === '') continue
    result[key] = text
  }
  return result
}

/**
 * Tag the editable notes with their key and swap in the user's text. The
 * generated body travels along on overridden notes so the studio can offer
 * "reset to generated text" without another round trip.
 */
export function applyNoteOverrides(notes: NoteEntry[], overrides: NoteOverrides): NoteEntry[] {
  return notes.map((note) => {
    const key = editableNoteKeyForTitle(note.title)
    if (!key) return note
    const override = overrides[key]
    if (override === undefined) return { ...note, key }
    return { ...note, key, body: override, generated_body: note.body }
  })
}
