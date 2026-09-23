/**
 * The register import never posts.
 *
 * A provider migration brings the general ledger in through SIE and the
 * invoice registers through the provider API. The verifikat of every migrated
 * invoice and kreditfaktura is therefore already in the books, and the
 * register import only ever writes register rows and, afterwards, the
 * invoice-side link to the verifikat that exists. If it ever created a
 * journal entry, every migrated document would be booked twice.
 *
 * Typing supplier credit notes (#2838) makes this worth pinning: in-app, a
 * supplier credit note is created by Kreditera, which books the reversing
 * verifikat in the same request. A migrated one must never take that road.
 *
 * A source-level assertion is deliberate (same reasoning as
 * import-sie-no-direct-savemappings.test.ts): the failure mode is "a future
 * change imports the posting helper", which this catches however the code is
 * wired.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REGISTER_IMPORTERS = ['entity-mapper.ts', 'migration-job-worker.ts', 'migration-orchestrator.ts'] as const

const POSTING_PATHS = [
  /@\/lib\/bookkeeping\/engine/,
  /@\/lib\/bookkeeping\/supplier-invoice-entries/,
  /@\/lib\/bookkeeping\/invoice-entries/,
  /@\/lib\/core\/bookkeeping\/storno-service/,
  /\bcreateJournalEntry\b/,
  /\bcreateDraftEntry\b/,
  /\bcommitEntry\b/,
  /\bcreateSupplierCreditNoteEntry\b/,
  /\breverseEntry\b/,
  /\bcorrectEntry\b/,
]

describe('arcim-migration register import', () => {
  for (const file of REGISTER_IMPORTERS) {
    it(`${file} reaches no posting path`, () => {
      const source = readFileSync(fileURLToPath(new URL(`../lib/${file}`, import.meta.url)), 'utf8')
      for (const pattern of POSTING_PATHS) {
        expect(source, `${file} must not reference ${pattern}`).not.toMatch(pattern)
      }
    })
  }
})
