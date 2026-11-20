import { describe, expect, it } from 'vitest'
import { summariseMissingUnderlag } from '../missing-underlag'

/**
 * The Att göra row's detail line. The point of the feature is that the errand
 * is DERIVED from the ledger, so it is there before any agent has run and
 * survives the chat window being closed: these tests pin that the summary
 * comes out of the same classifier the agent's per-item sentence uses.
 */
describe('summariseMissingUnderlag', () => {
  it('names the most common errand among the sampled rows', () => {
    const summary = summariseMissingUnderlag(12, [
      { description: 'ICA Kvantum Solna' },
      { description: 'Coop Stadshagen' },
      { description: 'Hetzner Online GmbH' },
    ])
    expect(summary.top).toEqual({ kind: 'kivra', count: 2 })
    expect(summary.total).toBe(12)
    // The line must never imply it saw every row: total stays the full count,
    // sampled says how many were actually classified.
    expect(summary.sampled).toBe(3)
  })

  // crm#1582: SIE-imported verifikat have their underlag where the earlier
  // books were kept; the row says so instead of reading them as mail or Kivra.
  it('reads imported verifikat as imported, whatever their words, as the agent does', () => {
    const summary = summariseMissingUnderlag(180, [
      { description: 'ICA Kvantum Solna', source_type: 'import' },
      { description: 'Hetzner Online GmbH', source_type: 'import' },
      { description: 'Lön augusti', source_type: 'import' },
      { description: 'Coop Stadshagen', source_type: 'bank_transaction' },
    ])
    expect(summary.top).toEqual({ kind: 'imported', count: 3 })
  })

  it('separates paper purchases from mailbox ones', () => {
    const summary = summariseMissingUnderlag(3, [
      { description: 'EasyPark' },
      { description: 'Circle K Bromma' },
      { description: 'Hetzner Online GmbH' },
    ])
    expect(summary.top).toEqual({ kind: 'paper', count: 2 })
  })

  it('classifies what cannot come from mail at all', () => {
    const summary = summariseMissingUnderlag(2, [
      { description: 'Lön augusti' },
      { description: 'Skatteverket skattekonto' },
    ])
    expect(summary.top?.kind).toBe('not_mail')
    expect(summary.top?.count).toBe(2)
  })

  it('inherits canHaveEmailReceipt exactly, including its compound words', () => {
    // NO_EMAIL_RECEIPT_EXISTS (lib/receipt-hunt/select.ts) was widened to the
    // "löne-" compounds (agent feedback seq 956543), so "Löneutbetalning" now
    // reads as not_mail here too. Pinned so the row and the agent keep the
    // one predicate: a change to that regex updates this test, never only one side.
    const summary = summariseMissingUnderlag(1, [{ description: 'Löneutbetalning augusti' }])
    expect(summary.top?.kind).toBe('not_mail')
  })

  it('breaks a tie towards the larger amounts, which the RPC returns first', () => {
    const summary = summariseMissingUnderlag(2, [
      { description: 'ICA Maxi' },
      { description: 'EasyPark' },
    ])
    expect(summary.top).toEqual({ kind: 'kivra', count: 1 })
  })

  it('reads a supplier the company pointed at its own portal as a portal errand', () => {
    const rows = [{ description: 'ELLEVIO AB AUTOGIRO' }, { description: 'ELLEVIO AB AUTOGIRO' }, { description: 'ICA Maxi' }]
    expect(summariseMissingUnderlag(3, rows).top?.kind).not.toBe('portal')
    const ellevio = { id: 'p-ellevio', counterparty_key: 'ellevio', vendor_name: 'Ellevio', url: 'https://www.ellevio.se/foretag' }
    expect(summariseMissingUnderlag(3, rows, [ellevio]).top).toEqual({ kind: 'portal', count: 2 })
  })

  it('has nothing to say when there is no work, and never invents a row', () => {
    expect(summariseMissingUnderlag(0, [])).toEqual({ total: 0, sampled: 0, top: null })
    // A count with no page (an RPC that returned only the total) must not
    // produce a line rather than guessing what the rows were.
    expect(summariseMissingUnderlag(9, [])).toEqual({ total: 9, sampled: 0, top: null })
  })

  it('survives a row with no description instead of throwing', () => {
    const summary = summariseMissingUnderlag(1, [{ description: null }])
    expect(summary.top).not.toBeNull()
    expect(summary.sampled).toBe(1)
  })
})
