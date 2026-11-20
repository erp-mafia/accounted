/**
 * The matcher run (startIngestMatchers): which matchers a row reaches, in
 * which order, and what a throw or an outcome does to the rest of the run.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import type { RawTransaction } from '@/types'
import {
  createIngestClaims,
  startIngestMatchers,
  type IngestBatch,
  type IngestMatcher,
  type MatchOutcome,
  type PassOutcome,
} from '../ingest-matcher'

const batch = { companyId: 'company-1' } as IngestBatch
const raw = {} as RawTransaction
const row = (amount: number, reread = false) => ({ tx: makeTransaction({ id: `tx-${amount}`, amount }), raw, reread })

function recorder() {
  const calls: string[] = []
  const tallies: Array<[string, PassOutcome]> = []
  const matcher = (
    id: string,
    order: number,
    direction: 'income' | 'expense',
    outcome: MatchOutcome | 'throw',
    extra: Partial<IngestMatcher> = {},
  ): IngestMatcher => ({
    id,
    order,
    module: 'invoicing',
    direction,
    onReread: true,
    async match(_batch, state) {
      calls.push(`${id}${state === undefined ? '' : `(${String(state)})`}`)
      if (outcome === 'throw') throw new Error(`${id} failed`)
      return outcome
    },
    ...extra,
  })
  const tally = (pass: string, outcome: PassOutcome) => {
    tallies.push([pass, outcome])
  }
  return { calls, tallies, matcher, tally }
}

describe('startIngestMatchers', () => {
  it('runs the matchers of the row direction by order, past a hint, a nothing and a throw, until one explains the row', async () => {
    const { calls, tallies, matcher, tally } = recorder()
    const run = startIngestMatchers(
      [
        matcher('explains', 50, 'expense', 'explained'),
        matcher('throws', 10, 'expense', 'throw'),
        matcher('income-only', 15, 'income', 'explained'),
        matcher('hints', 20, 'expense', 'hinted'),
        matcher('nothing', 30, 'expense', 'none'),
        matcher('after', 60, 'expense', 'explained'),
      ],
      batch,
      tally,
    )

    expect(await run.match(row(-100))).toBe(true)
    expect(calls).toEqual(['throws', 'hints', 'nothing', 'explains'])
    expect(tallies).toEqual([
      ['throws', 'failed'],
      ['hints', 'hinted'],
      ['explains', 'explained'],
    ])
  })

  it('answers false when no matcher explains the row, and a zero row reaches none', async () => {
    const { calls, matcher, tally } = recorder()
    const run = startIngestMatchers(
      [matcher('in', 1, 'income', 'hinted'), matcher('out', 2, 'expense', 'explained')],
      batch,
      tally,
    )
    expect(await run.match(row(100))).toBe(false)
    expect(await run.match(row(0))).toBe(false)
    expect(calls).toEqual(['in'])
  })

  it('gives a re-read only the matchers that take one', async () => {
    const { calls, matcher, tally } = recorder()
    const run = startIngestMatchers(
      [matcher('new-only', 1, 'income', 'none', { onReread: false }), matcher('both', 2, 'income', 'none')],
      batch,
      tally,
    )
    await run.match(row(100, true))
    await run.match(row(100))
    expect(calls).toEqual(['both', 'new-only', 'both'])
  })

  it('hands each matcher the state its own prepare read, and finish the inbound ids; without prepare the state is undefined', async () => {
    const { calls, matcher, tally } = recorder()
    const finish = vi.fn()
    const matchers = [
      matcher('prepared', 1, 'income', 'none', { prepare: async () => 'state-a' }),
      matcher('finisher', 2, 'income', 'none', { prepare: async () => 'state-b', finish }),
    ]

    const prepared = startIngestMatchers(matchers, batch, tally)
    await prepared.prepare()
    await prepared.match(row(100))
    prepared.finish(['tx-1'])
    expect(calls).toEqual(['prepared(state-a)', 'finisher(state-b)'])
    expect(finish).toHaveBeenLastCalledWith(batch, 'state-b', ['tx-1'])

    // A raw insert never prepares, but its batch still finishes.
    const raw = startIngestMatchers(matchers, batch, tally)
    raw.finish(['tx-2'])
    expect(finish).toHaveBeenLastCalledWith(batch, undefined, ['tx-2'])
  })
})

describe('createIngestClaims', () => {
  it('keeps one set per kind, and exposes the live set', () => {
    const claims = createIngestClaims()
    const customer = claims.ids('customer_invoice')
    claims.add('customer_invoice', 'inv-1')
    claims.add('supplier_invoice', 'si-1')
    expect(claims.has('customer_invoice', 'inv-1')).toBe(true)
    expect(claims.has('supplier_invoice', 'inv-1')).toBe(false)
    expect(customer.has('inv-1')).toBe(true)
    expect([...claims.ids('payment_order')]).toEqual([])
  })
})
