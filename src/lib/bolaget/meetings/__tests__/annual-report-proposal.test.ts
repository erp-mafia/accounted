/**
 * The årsstämma template reads the board's proposal from the narrative while
 * no årsredovisning version exists. The editor stores no text while it shows
 * the generated sentence, and an older save stored the no-dividend sentence
 * beside a dividend: neither may reach the minutes as a contradiction.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { NO_DIVIDEND_DISPOSITION_TEXT } from '@/lib/bokslut/arsredovisning/disposition-text'
import { loadAnnualReportProposal } from '../template'

const db = createQueuedMockSupabase()

beforeEach(() => {
  db.reset()
})

async function proposalFromNarrative(resultatdisposition: string | null, proposedDividend: number) {
  db.enqueue({ data: [] }) // no årsredovisning version yet
  db.enqueue({ data: { resultatdisposition, proposed_dividend: proposedDividend } })
  return loadAnnualReportProposal(db.supabase as never, 'company-1', 'fp-1')
}

describe('the proposal before any årsredovisning version', () => {
  it('is the board text as written', async () => {
    expect(await proposalFromNarrative('Vinsten balanseras.', 50_000)).toMatchObject({
      resultatdisposition: 'Vinsten balanseras.',
      proposedDividend: 50_000,
    })
  })

  it('is the no-dividend sentence without a dividend, also when none is stored', async () => {
    expect((await proposalFromNarrative(null, 0))?.resultatdisposition).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
  })

  it('never says the result is carried forward beside a dividend', async () => {
    expect((await proposalFromNarrative(NO_DIVIDEND_DISPOSITION_TEXT, 50_000))?.resultatdisposition).toBeNull()
  })
})
