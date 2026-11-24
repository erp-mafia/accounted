import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')

const LIST = read('../JournalEntryList.tsx')
const FORM = read('../JournalEntryForm.tsx')
const DETAIL = read('../JournalEntryDetail.tsx')
const SV = JSON.parse(read('../../../messages/sv.json'))
const EN = JSON.parse(read('../../../messages/en.json'))

/**
 * The internal note on a verifikat was easy to miss (accounted#183): a muted
 * "+ Intern anteckning" link in the new-verifikat form, a muted "Ingen
 * anteckning" beside a quiet Ändra on the verifikat view, and nothing at all
 * on a list row until it was unfolded. The repo does not render components in
 * tests, so the source shape is pinned instead.
 */
describe('internal note on a verifikat is easy to find', () => {
  it('marks a list row that has a note, with the note readable on hover', () => {
    const start = LIST.indexOf('entry.notes?.trim() && (')
    expect(start).toBeGreaterThan(-1)
    const indicator = LIST.slice(start, LIST.indexOf('</span>', start))
    expect(indicator).toContain("aria-label={t('note_indicator_aria')}")
    expect(indicator).toContain('title={entry.notes}')
    expect(indicator).toContain('<ChatBubbleLeftIcon')
    // Before the attachment indicator, in the same control cell.
    expect(start).toBeLessThan(LIST.indexOf('attachmentCounts[entry.id] ? (', start))
  })

  it('opens the note from a real button in the new-verifikat form', () => {
    expect(FORM).not.toContain("+ {t('internal_note')}")
    const start = FORM.indexOf('onClick={() => setShowNotes(true)}')
    expect(start).toBeGreaterThan(-1)
    const button = FORM.slice(FORM.lastIndexOf('<Button', start), FORM.indexOf('</Button>', start))
    expect(button).toContain('variant="outline"')
    expect(button).toContain("{t('add_internal_note')}")
  })

  it('offers "Lägg till anteckning" on an empty, editable note in the verifikat view', () => {
    const start = DETAIL.indexOf(') : canWrite && !noteLock ? (')
    expect(start).toBeGreaterThan(-1)
    const branch = DETAIL.slice(start, DETAIL.indexOf("t('no_note')", start))
    expect(branch).toContain("{t('add_note')}")
    expect(branch).toContain('setEditingNotes(true)')
    // The quiet Ändra in the section header is for an existing note only.
    expect(DETAIL).toContain('!editingNotes && canWrite && !noteLock && entry.notes ? (')
  })

  it('has every new string in both locales', () => {
    for (const messages of [SV, EN]) {
      expect(messages.journal_list.note_indicator_aria).toBeTruthy()
      expect(messages.journal_detail.add_note).toBeTruthy()
      expect(messages.journal_form.add_internal_note).toBeTruthy()
    }
    expect(SV.journal_form.add_internal_note).toBe('Lägg till anteckning')
  })
})
