import { describe, it, expect } from 'vitest'
import type { UploadedFile } from '../DocumentUploadZone'
import { shownUnderlag, underlagPaneOpen, viewableUnderlag } from '../underlag-pane'

/**
 * crm#1954: Ny verifikation shows the attached underlag beside the
 * konteringsrader. Which file the pane shows and whether it is open.
 */

function file(
  key: string,
  status: UploadedFile['status'],
  { id, type = 'application/pdf' }: { id?: string; type?: string } = {},
): UploadedFile {
  return {
    id,
    file: { type } as File,
    status,
    fileName: `${key}.pdf`,
    fileSize: 1000,
    uploadKey: key,
  }
}

describe('viewableUnderlag', () => {
  it('keeps only finished uploads that have their document id, in list order', () => {
    const files = [
      file('a', 'uploading'),
      file('b', 'uploaded', { id: 'doc-b' }),
      file('c', 'error'),
      file('d', 'uploaded', { id: 'doc-d', type: 'image/jpeg' }),
      file('e', 'uploaded'),
    ]
    expect(viewableUnderlag(files)).toEqual([
      { id: 'doc-b', fileName: 'b.pdf', mime: 'application/pdf' },
      { id: 'doc-d', fileName: 'd.pdf', mime: 'image/jpeg' },
    ])
  })

  it('leaves the type to the viewer when the browser did not know it', () => {
    expect(viewableUnderlag([file('a', 'uploaded', { id: 'doc-a', type: '' })])).toEqual([
      { id: 'doc-a', fileName: 'a.pdf', mime: null },
    ])
  })

  it('lists a document once when two uploads answered with the same id', () => {
    const files = [file('a', 'uploaded', { id: 'doc-x' }), file('b', 'uploaded', { id: 'doc-x' })]
    expect(viewableUnderlag(files).map((u) => u.id)).toEqual(['doc-x'])
  })

  it('is empty with nothing uploaded yet', () => {
    expect(viewableUnderlag([])).toEqual([])
    expect(viewableUnderlag([file('a', 'uploading')])).toEqual([])
  })
})

describe('shownUnderlag', () => {
  const underlag = viewableUnderlag([
    file('a', 'uploaded', { id: 'doc-a' }),
    file('b', 'uploaded', { id: 'doc-b' }),
  ])

  it('shows the first one until another is picked', () => {
    expect(shownUnderlag(underlag, null)?.id).toBe('doc-a')
  })

  it('shows the picked one while it is attached', () => {
    expect(shownUnderlag(underlag, 'doc-b')?.id).toBe('doc-b')
  })

  it('falls back to the first when the picked one was removed', () => {
    expect(shownUnderlag(underlag, 'doc-gone')?.id).toBe('doc-a')
  })

  it('shows nothing with nothing uploaded', () => {
    expect(shownUnderlag([], 'doc-a')).toBeNull()
  })
})

describe('underlagPaneOpen', () => {
  it('never opens with nothing to show, whatever was chosen', () => {
    expect(underlagPaneOpen({ hasUnderlag: false, wide: true, choice: null })).toBe(false)
    expect(underlagPaneOpen({ hasUnderlag: false, wide: true, choice: true })).toBe(false)
  })

  it('opens by itself where it fits beside the form', () => {
    expect(underlagPaneOpen({ hasUnderlag: true, wide: true, choice: null })).toBe(true)
  })

  it('waits to be asked on a narrow screen', () => {
    expect(underlagPaneOpen({ hasUnderlag: true, wide: false, choice: null })).toBe(false)
    expect(underlagPaneOpen({ hasUnderlag: true, wide: false, choice: true })).toBe(true)
  })

  it('stays hidden once hidden, also on a wide screen', () => {
    expect(underlagPaneOpen({ hasUnderlag: true, wide: true, choice: false })).toBe(false)
  })
})
