import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  computeDedupKey,
  contentSignature,
  assignFileDedupKeys,
  partitionFileRows,
  type ExistingSkattekontoRow,
} from '../skattekonto-dedup'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('computeDedupKey', () => {
  it('uses transaktionsidentitet when present', () => {
    expect(
      computeDedupKey({
        transaktionsidentitet: 123456789,
        transaktionsdatum: '2026-07-13',
        beloppSkatteverket: -15710,
        transaktionstext: 'Arbetsgivaravgift juni 2026',
      }),
    ).toBe('id:123456789')
  })

  // GOLDEN KEY: this literal pins the hash-material contract
  // `${datum}|${belopp}|${text}`. Every hash-keyed row in prod was written
  // with it (originally from skattekonto-sync.ts, moved here). If this test
  // fails, the change would duplicate every company's rows on next sync:
  // fix the code, never the expected value.
  it('produces the exact historical hash for id-less rows', () => {
    expect(
      computeDedupKey({
        transaktionsidentitet: null,
        transaktionsdatum: '2026-07-13',
        beloppSkatteverket: -15710,
        transaktionstext: 'Arbetsgivaravgift juni 2026',
      }),
    ).toBe('h:7914fe867adca79f75ef43f276d45dfc22ac622a676a3a6e9ac163104ea3465b')
  })

  it('formats decimal amounts with JS number semantics', () => {
    expect(
      computeDedupKey({
        transaktionsdatum: '2026-07-13',
        beloppSkatteverket: -15710.5,
        transaktionstext: 'Arbetsgivaravgift juni 2026',
      }),
    ).toBe('h:5bf604ecb527622aab5ee1d764f832554613532844bc63394fe871b26f6ceb61')
  })

  it('is the hash of the content signature', () => {
    const sig = contentSignature('2026-07-13', -15710, 'Arbetsgivaravgift juni 2026')
    expect(sig).toBe('2026-07-13|-15710|Arbetsgivaravgift juni 2026')
  })
})

describe('assignFileDedupKeys', () => {
  const row = {
    transaktionsdatum: '2026-07-13',
    transaktionstext: 'Arbetsgivaravgift juni 2026',
    belopp: -15710,
  }

  it('assigns the plain content hash to unique rows', () => {
    const [entry] = assignFileDedupKeys([row])
    expect(entry.dedupKey).toBe(
      'h:7914fe867adca79f75ef43f276d45dfc22ac622a676a3a6e9ac163104ea3465b',
    )
    expect(entry.index).toBe(0)
  })

  it('suffixes later occurrences of identical rows deterministically', () => {
    const [first, second] = assignFileDedupKeys([row, { ...row }])
    expect(first.dedupKey).toBe(
      'h:7914fe867adca79f75ef43f276d45dfc22ac622a676a3a6e9ac163104ea3465b',
    )
    expect(second.dedupKey).toBe(
      'h:e464c2f7f8d9c4534e7c0dd140036eb9282a35c061e3346649723bcf9096f1d3',
    )
    // Re-running over the same content yields the same keys.
    expect(assignFileDedupKeys([row, { ...row }]).map((e) => e.dedupKey)).toEqual([
      first.dedupKey,
      second.dedupKey,
    ])
  })
})

describe('partitionFileRows', () => {
  const fileRow = {
    transaktionsdatum: '2026-07-13',
    transaktionstext: 'Arbetsgivaravgift juni 2026',
    belopp: -15710,
  }

  const existingBooked: ExistingSkattekontoRow = {
    id: 'row-booked',
    dedup_key: 'id:123456789',
    status: 'booked',
    transaktionsdatum: '2026-07-13',
    transaktionstext: 'Arbetsgivaravgift juni 2026',
    belopp_skatteverket: -15710,
  }

  const existingUpcoming: ExistingSkattekontoRow = {
    ...existingBooked,
    id: 'row-upcoming',
    dedup_key: 'h:7914fe867adca79f75ef43f276d45dfc22ac622a676a3a6e9ac163104ea3465b',
    status: 'upcoming',
  }

  it('skips file rows whose content matches an existing booked row regardless of key form', () => {
    const result = partitionFileRows(assignFileDedupKeys([fileRow]), [existingBooked])
    expect(result.duplicates).toHaveLength(1)
    expect(result.duplicates[0].existingId).toBe('row-booked')
    expect(result.toInsert).toHaveLength(0)
    expect(result.promotions).toHaveLength(0)
  })

  it('promotes an existing upcoming row instead of inserting', () => {
    const result = partitionFileRows(assignFileDedupKeys([fileRow]), [existingUpcoming])
    expect(result.promotions).toHaveLength(1)
    expect(result.promotions[0].existingId).toBe('row-upcoming')
    expect(result.toInsert).toHaveLength(0)
  })

  it('prefers a booked match over an upcoming match', () => {
    const result = partitionFileRows(assignFileDedupKeys([fileRow]), [
      existingUpcoming,
      existingBooked,
    ])
    expect(result.duplicates.map((d) => d.existingId)).toEqual(['row-booked'])
    expect(result.promotions).toHaveLength(0)
  })

  it('consumes each existing row at most once (multiset semantics)', () => {
    const result = partitionFileRows(assignFileDedupKeys([fileRow, { ...fileRow }]), [
      existingBooked,
    ])
    expect(result.duplicates).toHaveLength(1)
    expect(result.toInsert).toHaveLength(1)
  })

  it('inserts rows with no content match', () => {
    const other = { ...fileRow, belopp: -999 }
    const result = partitionFileRows(assignFileDedupKeys([other]), [
      existingBooked,
      existingUpcoming,
    ])
    expect(result.toInsert).toHaveLength(1)
    expect(result.duplicates).toHaveLength(0)
    expect(result.promotions).toHaveLength(0)
  })
})
