import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Booking-feedback parity between the two booking paths on the transactions
 * page.
 *
 * The counterparty-template path (Bokför → "Tidigare motparter") used to end a
 * successful booking with nothing but `setExitingIds().add(id)`: no "Bokförd"
 * toast, no Ångra action, no unbooked-count decrement, and the id was never
 * removed from exitingIds again, so an undo would have restored the row's data
 * while leaving it filtered out of the inbox. Every other booking path ran
 * runCategorize's success tail.
 *
 * Both now go through one `finishBooking`. This repo runs Vitest in the `node`
 * environment and never renders components, so, like the sibling
 * invoice-match-dialog tests, these are file-level assertions: the two paths
 * must not drift apart again.
 */

const PAGE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../../app/(dashboard)/transactions/page.tsx'),
  'utf8',
)

const readMessages = (locale: 'sv' | 'en', namespace: string) =>
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, Record<string, string>>
  )[namespace]

describe('transactions page booking feedback', () => {
  it('defines exactly one success tail', () => {
    expect(PAGE_SRC).toContain('function finishBooking(')
    // One undo implementation, and one place that calls the storno endpoint.
    expect(PAGE_SRC.match(/altText="Ångra kategorisering"/g) ?? []).toHaveLength(1)
    expect(PAGE_SRC.match(/uncategorize`, \{ method: 'POST' \}/g) ?? []).toHaveLength(1)
  })

  it('routes every successful booking through it', () => {
    // runCategorize (category / catalog template / library template), the
    // counterparty-template booking, the counterparty activate-and-retry, and
    // the counterparty duplicate-warning "Bokför ändå" retry.
    expect(PAGE_SRC.match(/finishBooking\(\{/g) ?? []).toHaveLength(4)
  })

  it('no longer ends the counterparty path on a bare exitingIds add', () => {
    // The old tail: setExitingIds(...) immediately followed by `journalEntryId = cpJeId`.
    expect(PAGE_SRC).not.toMatch(
      /setExitingIds\(\(prev\) => new Set\(prev\)\.add\(id\)\)\s*\n\s*journalEntryId = cpJeId/,
    )
  })

  it('clears the id from exitingIds so an undo puts the row back', () => {
    // Without the delete, an undone booking restores is_business: null but the
    // row stays filtered out of the inbox (see uncategorizedTransactions).
    expect(PAGE_SRC).toMatch(/next\.delete\(id\)/)
  })

  it('lets a completed undo win over the delayed booked-state patch', () => {
    // The 350ms animation timer must not re-apply journal_entry_id after an
    // Ångra has already storno-reversed the verifikat server-side. The
    // closure-local flag covers the per-row Ångra; the shared undoneIdsRef
    // covers "Ångra alla", which runs outside finishBooking's closure.
    expect(PAGE_SRC).toMatch(/let undone = false/)
    expect(PAGE_SRC).toMatch(/undone = true/)
    expect(PAGE_SRC).toMatch(/if \(!undone && !undoneIdsRef\.current\.has\(id\)\) \{/)
    // Both undo paths record into the shared ref, and a fresh booking clears
    // its row's entry again so a re-booked row still gets its delayed patch.
    expect(PAGE_SRC).toMatch(/undoneIdsRef\.current\.add\(id\)/)
    expect(PAGE_SRC).toMatch(/undoneIdsRef\.current\.add\(undoneId\)/)
    expect(PAGE_SRC).toMatch(/undoneIdsRef\.current\.delete\(id\)/)
  })

  it('clears only the finished row\'s spinner', () => {
    // The shared tail runs for rows that never set processingId; an
    // unconditional clear would wipe an unrelated in-flight row.
    expect(PAGE_SRC).toMatch(/setProcessingId\(\(prev\) => \(prev === id \? null : prev\)\)/)
  })

  it('decrements the unbooked count on every path that removes a row', () => {
    // finishBooking, handleTransactionBooked (manual booking dialog / voucher
    // match), the three other single-row exits already on the page, the
    // duplicate-dialog "Ignorera transaktionen" tail, handleDeleteTransaction
    // (deleting a pending row must not leave the inbox badge stale: the
    // realtime echo is not guaranteed for DELETE), and applyExpensePayoutBooked
    // (a transfer booked as the repayment of utlägg leaves the inbox too).
    expect(
      PAGE_SRC.match(/setTotalUncategorizedCount\(\(prev\) => Math\.max\(0, \(prev \?\? 1\) - 1\)\)/g) ?? [],
    ).toHaveLength(8)
  })

  it('ships the undo strings it renders in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale, 'transactions')
      for (const key of [
        'undone_title',
        'undone_description',
        'undo_failed_title',
        'undo_failed_description',
        'partially_booked_title',
        'partially_booked_description',
      ]) {
        expect(messages[key], `${locale}.transactions.${key}`).toBeTruthy()
      }
    }
  })
})

/**
 * Duplicate-guard feedback parity: every client of POST /categorize must route
 * a TRANSACTION_BOOK_POSSIBLE_DUPLICATE 409 into DuplicateBookingDialog (which
 * offers match / ignore / book-anyway), never into a destructive toast that
 * names no way forward. The counterparty-template branch of
 * handleQuickReviewConfirm used to dead-end. (The old BankReconciliationView
 * quick-book was retired with the view on 2026-08-25; /reconciliation books
 * through the shared transactions inbox flow instead.)
 */

describe('duplicate-guard 409 routing parity', () => {
  it('handles the duplicate code on both booking paths of the transactions page', () => {
    // runCategorize AND the counterparty-template branch.
    expect(
      PAGE_SRC.match(/error\?\.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE'/g) ?? [],
    ).toHaveLength(2)
  })

  it('opens the dialog from the counterparty branch with a force-bound retry', () => {
    // The branch must set the shared duplicateWarning state (the dialog) and
    // bind the retry to the reviewed candidate's voucher.
    expect(PAGE_SRC).toMatch(
      /TRANSACTION_BOOK_POSSIBLE_DUPLICATE'[\s\S]{0,600}cpCategorize\(\{\s*\n?\s*expectedDuplicateJournalEntryId: candidate\.journal_entry_id,/,
    )
  })
})
