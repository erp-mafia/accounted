import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * One booking path on the transactions page.
 *
 * The counterparty-template path (Bokför → "Tidigare motparter") once had a
 * booking call of its own and ended a success with nothing but
 * `setExitingIds().add(id)`: no "Bokförd" toast, no Ångra action, no
 * unbooked-count decrement, and the id was never removed from exitingIds
 * again, so an undo restored the row's data while leaving it filtered out of
 * the inbox. It was then given the shared success tail, and finally the
 * separate call went away: every proposal, whatever proposed it, books
 * through `bookProposalNow` → `runCategorize` → `finishBooking`
 * (lib/bookkeeping/proposal.ts decides the request body).
 *
 * This repo runs Vitest in the `node` environment and never renders
 * components, so, like the sibling invoice-match-dialog tests, these are
 * file-level assertions: the path must not fork again.
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
    expect(PAGE_SRC.match(/altText=\{t\('undo_categorize_alt'\)\}/g) ?? []).toHaveLength(1)
    expect(PAGE_SRC.match(/uncategorize`, \{ method: 'POST' \}/g) ?? []).toHaveLength(1)
  })

  it('routes every successful booking through it', () => {
    // One call site, because there is one booking path.
    expect(PAGE_SRC.match(/finishBooking\(\{/g) ?? []).toHaveLength(1)
  })

  it('books through exactly one request, whatever proposed it', () => {
    // A counterparty rule is a body field on the same call, not a call of its
    // own: `counterparty_template_id` appears once on the wire and once where
    // the proposal's body is unpacked.
    expect(PAGE_SRC.match(/fetch\(`\/api\/transactions\/\$\{id\}\/categorize`/g) ?? []).toHaveLength(1)
    expect(PAGE_SRC).not.toContain('cpCategorize')
    expect(PAGE_SRC.match(/counterparty_template_id/g) ?? []).toHaveLength(2)
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
  it('handles the duplicate code once, on the one booking path', () => {
    expect(
      PAGE_SRC.match(/error\?\.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE'/g) ?? [],
    ).toHaveLength(1)
  })

  it('retries the same booking, force-bound to the reviewed candidate', () => {
    // The retry spreads the original args, so a counterparty rule (or a
    // template, or an account) is retried as what it was, not as a bare
    // category. Losing that spread would silently book something else.
    expect(PAGE_SRC).toMatch(
      /TRANSACTION_BOOK_POSSIBLE_DUPLICATE'[\s\S]{0,900}runCategorize\(\{\s*\n?\s*\.\.\.args,\s*\n?\s*force: true,\s*\n?\s*expectedDuplicateJournalEntryId: candidate\.journal_entry_id,/,
    )
  })

  /**
   * Issue #2488: a batch books N rows through one bounded pool, and every
   * flagged row used to write the page's single `duplicateWarning` slot. Only
   * the last writer's dialog rendered; the rest were counted in
   * `failedCount = ids.length - successCount` with nothing said about why. The
   * guard has to be asked once per batch, not once per row.
   */
  it('parks a batch row instead of clobbering the single-row modal slot', () => {
    // The silent branch sits inside the duplicate handler and parks, never
    // opens. One writer of the single-row slot, and it is the branch the
    // silent rows never reach.
    expect(PAGE_SRC).toMatch(
      /TRANSACTION_BOOK_POSSIBLE_DUPLICATE'[\s\S]{0,1600}if \(silent\) \{[\s\S]{0,600}batchDuplicatesRef\.current\.push\(\{ transactionId: id, candidate, retry \}\)/,
    )
    expect(PAGE_SRC.match(/setDuplicateWarning\(\{/g) ?? []).toHaveLength(1)
  })

  it('gives a parked row its own outcome so the batch tally never calls it failed', () => {
    // A third state, distinct from ok and from a plain failure: the aggregate
    // toast reports it as held back, not as "misslyckades".
    expect(PAGE_SRC).toMatch(/return \{ ok: false, journalEntryId: null, deferredDuplicate: true \}/)
    // The batch tail derives its counts from the shared reducer rather than
    // from `ids.length - successCount`, which cannot see the third state.
    expect(PAGE_SRC).toContain('tallyBatchOutcomes(ids, results)')
    expect(PAGE_SRC).not.toContain('const failedCount = ids.length - successCount')
  })

  it('asks once after the pool settles and replays the parked retries', () => {
    // One collector reset per batch, one question, and the confirmation runs
    // the stored retries through the same bounded pool.
    expect(PAGE_SRC).toMatch(
      /batchDuplicatesRef\.current = \[\][\s\S]{0,400}mapWithConcurrency\(ids, BATCH_CONCURRENCY/,
    )
    expect(PAGE_SRC).toMatch(/await askBatchDuplicates\(deferred\)/)
    expect(PAGE_SRC).toMatch(/runDeferredDuplicateRetries\(\s*\n?\s*deferred,\s*\n?\s*BATCH_CONCURRENCY,/)
    expect(PAGE_SRC).toContain('foldDeferredRetries(tally, retried)')
  })

  it('ships the batch duplicate strings it renders in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale, 'transactions')
      for (const key of [
        'dialog_batch_duplicate_title',
        'dialog_batch_duplicate_body',
        'dialog_batch_duplicate_col_date',
        'dialog_batch_duplicate_col_transaction',
        'dialog_batch_duplicate_col_amount',
        'dialog_batch_duplicate_col_voucher',
        'dialog_batch_duplicate_book_all',
        'batch_categorize_duplicates_held_back',
      ]) {
        expect(messages[key], `${locale}.transactions.${key}`).toBeTruthy()
      }
    }
  })
})
