import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { canDetachDocument, resolveDetachErrorMessage } from '../detach-underlag'

/**
 * "Ta bort underlag" on a transaction (#2132).
 *
 * Vitest runs in the `node` environment here and never renders components,
 * so the menu-item gate and the error mapping live in a pure helper both
 * row components and the page call. The rendering side is pinned with
 * file-level assertions, like the sibling dialog tests: the components must
 * route through the helper, and the strings must exist in both locales.
 */

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), 'utf8')
const readMessages = (locale: 'sv' | 'en', namespace: string) =>
  (JSON.parse(read(`messages/${locale}.json`)) as Record<string, Record<string, string>>)[
    namespace
  ]

const ROUTE_409_MESSAGE =
  'Bilagan är kopplad till en bokförd verifikation och kan inte tas bort. Storno verifikationen först.'

describe('canDetachDocument', () => {
  const base = { isBooked: false, canWrite: true, documentId: 'doc-1', hasHandler: true }

  it('shows the item on an unbooked, writable row that carries a pin', () => {
    expect(canDetachDocument(base)).toBe(true)
  })

  it('hides the item once the row is booked (the route would answer 409)', () => {
    expect(canDetachDocument({ ...base, isBooked: true })).toBe(false)
  })

  it('hides the item for read-only members', () => {
    expect(canDetachDocument({ ...base, canWrite: false })).toBe(false)
  })

  it('hides the item when there is nothing to detach', () => {
    expect(canDetachDocument({ ...base, documentId: null })).toBe(false)
    expect(canDetachDocument({ ...base, documentId: undefined })).toBe(false)
    expect(canDetachDocument({ ...base, documentId: '' })).toBe(false)
  })

  it('hides the item when no handler is wired', () => {
    expect(canDetachDocument({ ...base, hasHandler: false })).toBe(false)
  })
})

describe('resolveDetachErrorMessage', () => {
  it('renders the 409 server message unchanged', () => {
    expect(resolveDetachErrorMessage(409, { error: ROUTE_409_MESSAGE })).toBe(ROUTE_409_MESSAGE)
  })

  it('does not treat a 409 without a message as verbatim', () => {
    const msg = resolveDetachErrorMessage(409, { error: '' })
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })

  it('maps other statuses through the shared translator to a Swedish message', () => {
    const msg = resolveDetachErrorMessage(500, { error: 'Failed to detach document' })
    expect(msg).not.toBe('Failed to detach document')
    expect(msg.length).toBeGreaterThan(0)
    expect(resolveDetachErrorMessage(404, null).length).toBeGreaterThan(0)
  })
})

describe('detach affordance wiring', () => {
  const inboxCard = read('components/transactions/TransactionInboxCard.tsx')
  const historyList = read('components/transactions/TransactionHistoryList.tsx')
  const attachDialog = read('components/transactions/TransactionAttachDocumentDialog.tsx')
  const page = read('app/(dashboard)/transactions/page.tsx')

  it('both row components gate the item through canDetachDocument', () => {
    expect(inboxCard).toContain('canDetachDocument({')
    expect(historyList).toContain('canDetachDocument({')
    expect(inboxCard).toContain("tDetach('menu_item')")
    expect(historyList).toContain("tDetach('menu_item')")
  })

  it('the inbox card only offers detach under the attach gate (unbooked and canWrite)', () => {
    expect(inboxCard).toMatch(/showDetachDocumentItem =\s*showAttachDocumentItem &&/)
  })

  it('the attach dialog offers detach only for unbooked rows', () => {
    expect(attachDialog).toContain('onDetach && !transaction.journal_entry_id')
  })

  it('the page confirms before DELETE and renders 409 through the verbatim path', () => {
    expect(page).toContain("variant: 'warning'")
    expect(page).toContain("/attach-document`, { method: 'DELETE' }")
    expect(page).toContain('resolveDetachErrorMessage(res.status, result)')
  })

  it('strings exist in both locales with the same keys', () => {
    const sv = readMessages('sv', 'tx_detach')
    const en = readMessages('en', 'tx_detach')
    const required = [
      'menu_item',
      'confirm_title',
      'confirm_body',
      'confirm_label',
      'cancel_label',
      'toast_done',
      'toast_failed',
    ]
    for (const key of required) {
      expect(sv[key], `sv.tx_detach.${key}`).toBeTruthy()
      expect(en[key], `en.tx_detach.${key}`).toBeTruthy()
    }
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort())
    expect(sv.menu_item).toBe('Ta bort underlag')
  })
})
