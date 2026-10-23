import { describe, it, expect } from 'vitest'
import {
  amountToOre,
  buildStableExternalIds,
  contentBucketKey,
  descriptionsBridge,
  dropRepeatedBankRows,
  normalizeImportedDescription,
  reconcileStableExternalIds,
  FALLBACK_DESCRIPTION,
  idsProveDistinctBookings,
  BOOKING_DATE_ID_SOURCES,
  PROVIDER_BOOKING_ID_SOURCES,
} from '../external-id'

describe('amountToOre', () => {
  it('normalizes a JS number to integer öre', () => {
    expect(amountToOre(1234.5)).toBe(123450)
    expect(amountToOre(-250)).toBe(-25000)
    expect(amountToOre(0)).toBe(0)
  })

  it('normalizes a numeric string (PostgREST representation) to the same öre', () => {
    // The core fix: a DB-fetched numeric string and a raw JS number for the
    // same amount must collapse to the same integer.
    expect(amountToOre('1234.50')).toBe(123450)
    expect(amountToOre('1234.5')).toBe(amountToOre(1234.5))
    expect(amountToOre('-250.00')).toBe(amountToOre(-250))
    expect(amountToOre('100')).toBe(10000)
  })

  it('rounds sub-öre noise deterministically (never toFixed)', () => {
    expect(amountToOre(0.1 + 0.2)).toBe(30) // 0.30000000000000004 → 30
    expect(amountToOre(19.995)).toBe(2000)
  })
})

describe('buildStableExternalIds', () => {
  it('derives the id from account + date + öre, not from any bank id', () => {
    const ids = buildStableExternalIds('eb', 'SE123', [{ date: '2024-06-15', amount: -500 }])
    expect(ids).toEqual(['eb_SE123_2024-06-15_-50000_0'])
  })

  it('disambiguates genuinely identical transactions with an occurrence index', () => {
    const ids = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -250 },
    ])
    expect(ids).toEqual([
      'eb_acc_2024-06-15_-25000_0',
      'eb_acc_2024-06-15_-25000_1',
      'eb_acc_2024-06-15_-25000_2',
    ])
  })

  it('produces the SAME set of ids regardless of provider ordering (re-sync dedupe)', () => {
    const a = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-16', amount: -100 },
      { date: '2024-06-15', amount: -250 },
    ])
    // Same transactions, different order on a later sync.
    const b = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-16', amount: -100 },
    ])
    expect(new Set(a)).toEqual(new Set(b))
  })

  it('treats string and number amounts as the same id (provider type drift)', () => {
    const num = buildStableExternalIds('eb', 'acc', [{ date: '2024-06-15', amount: 1234.5 }])
    const str = buildStableExternalIds('eb', 'acc', [{ date: '2024-06-15', amount: '1234.50' }])
    expect(num).toEqual(str)
  })

  it('keeps distinct amounts and dates on separate occurrence counters', () => {
    const ids = buildStableExternalIds('eb', 'acc', [
      { date: '2024-06-15', amount: -250 },
      { date: '2024-06-15', amount: -100 },
      { date: '2024-06-16', amount: -250 },
      { date: '2024-06-15', amount: -250 },
    ])
    expect(ids).toEqual([
      'eb_acc_2024-06-15_-25000_0',
      'eb_acc_2024-06-15_-10000_0',
      'eb_acc_2024-06-16_-25000_0',
      'eb_acc_2024-06-15_-25000_1',
    ])
  })

  it('returns an empty array for an empty batch', () => {
    expect(buildStableExternalIds('eb', 'acc', [])).toEqual([])
  })

  // FORMAT-FREEZE guard. `external_id` is a STORED key: changing the template
  // string orphans every prior row (its stored id stops matching the new scheme)
  // and re-imports the lot on the next sync: the June 2026 fleet-wide incident.
  // If you must change the format, you MUST ship a coordinated backfill of
  // existing rows; updating this assertion without one is the bug.
  it('FORMAT IS FROZEN: changing this template silently orphans every prior external_id', () => {
    expect(
      buildStableExternalIds('eb', 'SE0000000000000000000000', [
        { date: '2026-04-07', amount: -11231 },
      ]),
    ).toEqual(['eb_SE0000000000000000000000_2026-04-07_-1123100_0'])
  })
})

describe('contentBucketKey', () => {
  it('keys off (date, öre) only: no description', () => {
    expect(contentBucketKey('2024-06-15', -250)).toBe('2024-06-15|-25000')
  })

  it('matches a JS number against a PostgREST numeric string for the same amount', () => {
    // A DB-fetched numeric string and a raw JS number for the same amount must
    // land in the SAME bucket, otherwise the bridge silently misses.
    expect(contentBucketKey('2024-06-15', -250)).toBe(contentBucketKey('2024-06-15', '-250.00'))
  })

  it('separates distinct amounts and dates into distinct buckets', () => {
    expect(contentBucketKey('2024-06-15', -250)).not.toBe(contentBucketKey('2024-06-15', -100))
    expect(contentBucketKey('2024-06-15', -250)).not.toBe(contentBucketKey('2024-06-16', -250))
  })
})

describe('descriptionsBridge', () => {
  it('bridges prefix-preserving PSD2 enrichment (the June 2026 drift)', () => {
    // The same transaction whose title grew between syncs must still bridge.
    // (Synthetic stand-ins for the real prefix-preserving enrichment pattern.)
    expect(descriptionsBridge('KAFFE', 'KAFFE  BG 0000000000 Bg-bet. via internet')).toBe(true)
    expect(descriptionsBridge('UTBETALNING Insättning', 'UTBETALNING')).toBe(true)
    expect(descriptionsBridge('REF 000000 Europabetalning', 'REF 000000')).toBe(true)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(descriptionsBridge('  Mataffär Solna  ', 'mataffär solna')).toBe(true)
  })

  it('bridges whitespace-only rendering drift, including a DROPPED space (2026-08-18 reconnect incident)', () => {
    // The same bank re-rendered the same transactions with different spacing
    // after a PSD2 reconnect; every pair below is a real observed twin shape.
    // CRLF vs space:
    expect(
      descriptionsBridge(
        '2025DEC58 BRANDHEROES\r\nURSPRUNGLIGT BELOPP M M: EUR',
        '2025DEC58 BRANDHEROES URSPRUNGLIGT BELOPP M M: EUR'
      )
    ).toBe(true)
    // Dropped space (collapse-only normalization would still miss this):
    expect(
      descriptionsBridge(
        '005 BaBylissURSPRUNGLIGT BELOPP M M: SEK',
        '005 BaByliss URSPRUNGLIGT BELOPP M M: SEK'
      )
    ).toBe(true)
    // Trailing padding + reference tail growth still bridges via prefix rule:
    expect(
      descriptionsBridge(
        'BRANDHEROES APSFAK 008URSPRUNGLIGT BELOPP M M: EUR',
        'BRANDHEROES APSFAK 008 URSPRUNGLIGT BELOPP M M: EUR                 2162943703022614'
      )
    ).toBe(true)
  })

  it('whitespace stripping does not bridge genuinely distinct references', () => {
    expect(descriptionsBridge('REF-AAAA 1111', 'REF-BBBB 2222')).toBe(false)
    // A whitespace-only description is still treated as blank (no wildcard).
    expect(descriptionsBridge(' \r\n ', 'anything')).toBe(false)
    expect(descriptionsBridge(' \r\n ', '  ')).toBe(true)
  })

  it('does NOT bridge genuinely distinct descriptions sharing a date+amount', () => {
    // Distinct reference codes on same-day same-amount rows (e.g. verification
    // micro-deposits) must NOT collapse: each is a real transaction.
    expect(descriptionsBridge('REF-AAAA1111', 'REF-BBBB2222')).toBe(false)
    // Same common stem, diverging tails: still distinct.
    expect(descriptionsBridge('PMT.Ref AAA', 'PMT.Ref BBB')).toBe(false)
    expect(descriptionsBridge('Coffee', 'Lunch')).toBe(false)
  })

  it('does not let a blank description wildcard-match a described row', () => {
    // A blank carries no signal: it must not consume a described same-(date,öre)
    // row. Live callers normalize blanks to FALLBACK_DESCRIPTION, so this is
    // defense-in-depth. Only two blanks bridge each other (date+öre identity).
    expect(descriptionsBridge('', 'anything')).toBe(false)
    expect(descriptionsBridge('anything', null)).toBe(false)
    expect(descriptionsBridge(undefined, '')).toBe(true)
  })
})

describe('normalizeImportedDescription', () => {
  it('maps empty / whitespace-only titles to the Swedish neutral', () => {
    expect(normalizeImportedDescription('')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription('   ')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription(null)).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription(undefined)).toBe(FALLBACK_DESCRIPTION)
  })

  it('maps the legacy English "Unknown" sentinel to the Swedish neutral (case-insensitive)', () => {
    expect(normalizeImportedDescription('Unknown')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription('unknown')).toBe(FALLBACK_DESCRIPTION)
    expect(normalizeImportedDescription('  UNKNOWN  ')).toBe(FALLBACK_DESCRIPTION)
  })

  it('preserves a real title and trims surrounding whitespace', () => {
    expect(normalizeImportedDescription('ICA Maxi Solna')).toBe('ICA Maxi Solna')
    expect(normalizeImportedDescription('  Lön juni  ')).toBe('Lön juni')
  })

  it('does NOT clobber a real title that merely contains the word "unknown"', () => {
    expect(normalizeImportedDescription('Unknown Pizza AB')).toBe('Unknown Pizza AB')
  })
})

describe('reconcileStableExternalIds', () => {
  const id = (n: number) => `eb_SE47_2026-09-21_20000_${n}`
  const stored = [
    { externalId: id(0), desc: '12305999102631' },
    { externalId: id(1), desc: '12305999102621' },
  ]

  it('gives a late-booked sibling a fresh index instead of a stored row\'s id', () => {
    // The bank returns a third 200 kr row for the same day, ordered so the
    // newcomer lands on index 1, which the stored ...621 row already holds.
    const ids = reconcileStableExternalIds(
      [
        { external_id: id(0), description: '12305999102631' },
        { external_id: id(1), description: '12305999102641' },
        { external_id: id(2), description: '12305999102621' },
      ],
      stored,
    )
    expect(ids).toEqual([id(0), id(2), id(1)])
  })

  it('maps an unchanged set back onto the stored ids whatever the order', () => {
    const ids = reconcileStableExternalIds(
      [
        { external_id: id(0), description: '12305999102621' },
        { external_id: id(1), description: '12305999102631' },
      ],
      stored,
    )
    expect(ids).toEqual([id(1), id(0)])
  })

  it('keeps the id of a row whose description drifted without bridging', () => {
    const ids = reconcileStableExternalIds(
      [{ external_id: id(0), description: 'Insättning' }],
      [{ externalId: id(0), desc: '12305999102631' }],
    )
    expect(ids).toEqual([id(0)])
  })

  it('gives a late identical-description twin the next free index', () => {
    const ids = reconcileStableExternalIds(
      [
        { external_id: id(0), description: 'Swish' },
        { external_id: id(1), description: 'Swish' },
      ],
      [{ externalId: id(0), desc: 'swish' }],
    )
    expect(ids).toEqual([id(0), id(1)])
  })

  it('leaves non-stable ids and families without stored rows untouched', () => {
    const ids = reconcileStableExternalIds(
      [
        { external_id: 'csv_lunar_ab12cd34', description: '12305999102621' },
        { external_id: 'eb_SE47_2026-09-22_20000_0', description: '12305999102621' },
      ],
      [...stored, { externalId: 'csv_lunar_ab12cd34', desc: 'other' }],
    )
    expect(ids).toEqual(['csv_lunar_ab12cd34', 'eb_SE47_2026-09-22_20000_0'])
  })
})

describe('dropRepeatedBankRows (crm#1295)', () => {
  type Row = { ptid?: string | null; date: string; amount: number | string; description: string }
  const swish = (ptid: string | null, description = `Swish ${ptid}`, amount: number | string = 250): Row =>
    ({ ptid, date: '2026-06-15', amount, description })
  const drop = (rows: Row[]) => dropRepeatedBankRows(rows, (r) => ({
    providerTransactionId: r.ptid, date: r.date, amount: r.amount, description: r.description,
  }))

  it('drops a bank entry the response served twice, keeping the first copy in place', () => {
    const rows = [swish('P1'), swish('P2'), swish('P1'), swish('P3'), swish('P2')]
    expect(drop(rows)).toEqual([rows[0], rows[1], rows[3]])
  })

  it('keeps two equal payments on the same day: different bank ids are different entries', () => {
    const rows = [swish('P1', 'Swish'), swish('P2', 'Swish')]
    expect(drop(rows)).toEqual(rows)
  })

  it('never drops rows without a bank id, however alike', () => {
    const rows = [swish(null, 'Kaffe'), swish(null, 'Kaffe'), swish('', 'Kaffe'), swish('  ', 'Kaffe')]
    expect(drop(rows)).toEqual(rows)
  })

  it('keeps rows that share a bank id but differ in date, amount or description', () => {
    const rows: Row[] = [
      swish('2026-06-15.0', 'ICA'),
      { ...swish('2026-06-15.0', 'ICA'), date: '2026-06-16' },
      swish('2026-06-15.0', 'ICA', 500),
      swish('2026-06-15.0', 'Coop'),
    ]
    expect(drop(rows)).toEqual(rows)
  })

  it('compares amounts in öre, so a numeric string and a number are the same amount', () => {
    expect(drop([swish('P1', 'Swish', 250), swish('P1', 'Swish', '250.00')])).toHaveLength(1)
  })

  // The crm#1295 sequence on a small scale. Fetch 1 pages unstably: it serves
  // 4 and 3 twice and leaves out 7 and 6. Fetch 2 is complete. Each fetch is
  // mapped the way the bank syncs map it, the first one is stored, and the
  // second one is re-keyed against it the way ingest does.
  describe('a repeating fetch followed by a complete one', () => {
    const entry = (n: number): Row => swish(`P${n}`, `Swish ref-${n}`)
    const fetch1 = [8, 5, 4, 3, 4, 3, 2, 1].map(entry)
    const fetch2 = [8, 7, 6, 5, 4, 3, 2, 1].map(entry)
    const idsOf = (rows: Row[]) => buildStableExternalIds('eb', 'SE00', rows.map((r) => ({ date: r.date, amount: r.amount })))
    const secondSync = (dropRepeats: boolean) => {
      const first = dropRepeats ? drop(fetch1) : fetch1
      const stored = idsOf(first).map((externalId, i) => ({ externalId, desc: first[i].description }))
      const second = dropRepeats ? drop(fetch2) : fetch2
      const incoming = idsOf(second).map((external_id, i) => ({ external_id, description: second[i].description }))
      return { stored, ids: reconcileStableExternalIds(incoming, stored) }
    }

    it('stores each entry once and imports both rows the first fetch left out', () => {
      const { stored, ids } = secondSync(true)
      expect(stored).toHaveLength(6)
      const storedIds = new Set(stored.map((s) => s.externalId))
      const storedIdOf = (n: number) => stored.find((s) => s.desc === `Swish ref-${n}`)!.externalId
      // 7 and 6 (positions 1 and 2) are new: ids no stored row holds.
      expect(storedIds.has(ids[1])).toBe(false)
      expect(storedIds.has(ids[2])).toBe(false)
      expect(ids[1]).not.toBe(ids[2])
      // Every other row is re-keyed onto its own stored row: a Layer-1 duplicate.
      for (const [position, n] of [[0, 8], [3, 5], [4, 4], [5, 3], [6, 2], [7, 1]]) {
        expect(ids[position]).toBe(storedIdOf(n))
      }
    })

    it('without the drop, a stored copy swallows a row the first fetch left out', () => {
      const { stored, ids } = secondSync(false)
      expect(stored).toHaveLength(8)
      // Row 6 takes the id of the second copy of 4 and Layer 1 would skip it.
      expect(new Set(stored.map((s) => s.externalId)).has(ids[2])).toBe(true)
    })
  })
})

describe('idsProveDistinctBookings (crm#1271)', () => {
  const stripe = (external_id: string | null, over: Record<string, unknown> = {}) => ({
    external_id,
    import_source: 'stripe',
    bank_connection_id: null,
    ...over,
  })

  it('lists only feeds whose stored ids are the provider\'s own per-booking references', () => {
    expect([...PROVIDER_BOOKING_ID_SOURCES]).toEqual(['stripe'])
  })

  it('proves two Stripe rows with different balance-transaction ids distinct', () => {
    expect(idsProveDistinctBookings(
      stripe('stripe_acct_A_txn_1_fee'),
      stripe('stripe_acct_A_txn_2_fee'),
    )).toBe(true)
  })

  it('does not prove anything for the same id', () => {
    expect(idsProveDistinctBookings(stripe('stripe_acct_A_txn_1'), stripe('stripe_acct_A_txn_1'))).toBe(false)
  })

  it('does not prove anything when either id is missing', () => {
    expect(idsProveDistinctBookings(stripe(null), stripe('stripe_acct_A_txn_1'))).toBe(false)
    expect(idsProveDistinctBookings(stripe('stripe_acct_A_txn_1'), stripe(null))).toBe(false)
    expect(idsProveDistinctBookings({}, stripe('stripe_acct_A_txn_1'))).toBe(false)
  })

  it('does not prove anything across two channels (Stripe vs a hand-entered or file row)', () => {
    expect(idsProveDistinctBookings(stripe('stripe_acct_A_txn_1'), stripe('x', { import_source: 'mcp' }))).toBe(false)
    expect(idsProveDistinctBookings(stripe('stripe_acct_A_txn_1'), stripe('y', { import_source: 'csv_generic_csv' }))).toBe(false)
  })

  it('does not prove anything across two bank connections of the same feed', () => {
    expect(idsProveDistinctBookings(
      stripe('stripe_acct_A_txn_1', { bank_connection_id: 'bc-1' }),
      stripe('stripe_acct_A_txn_2', { bank_connection_id: 'bc-2' }),
    )).toBe(false)
  })

  it('never trusts derived ids: bank feeds and file imports dedup on content', () => {
    // buildStableExternalIds' occurrence index and bank-file row hashes can
    // change for the same booking, so two different values prove nothing.
    expect(idsProveDistinctBookings(
      { external_id: 'eb_SE00_2026-10-01_-443_0', import_source: 'enable_banking', bank_connection_id: 'bc-1' },
      { external_id: 'eb_SE00_2026-10-01_-443_1', import_source: 'enable_banking', bank_connection_id: 'bc-1' },
    )).toBe(false)
    expect(idsProveDistinctBookings(
      { external_id: 'eb_SE00_2026-10-01_-443_0', import_source: 'open_payments', bank_connection_id: null },
      { external_id: 'eb_SE00_2026-10-01_-443_1', import_source: 'open_payments', bank_connection_id: null },
    )).toBe(false)
    expect(idsProveDistinctBookings(
      { external_id: 'generic_csv_aaaa', import_source: 'csv_generic_csv' },
      { external_id: 'generic_csv_bbbb', import_source: 'csv_generic_csv' },
    )).toBe(false)
  })
})

describe('idsProveDistinctBookings: bank feeds and bank files (crm#1312)', () => {
  const feed = (external_id: string | null, over: Record<string, unknown> = {}) => ({
    external_id,
    import_source: 'enable_banking',
    bank_connection_id: 'bc-1',
    provider_transaction_id: null as string | null,
    ...over,
  })

  it('lists the feeds whose ids carry the booking date', () => {
    expect([...BOOKING_DATE_ID_SOURCES].sort()).toEqual(['enable_banking', 'open_payments'])
  })

  it('proves two rows of one feed booked on different days distinct (a second Swish batch of the same price)', () => {
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-15_39500_3'),
      feed('eb_SE00_2026-10-14_39500_3'),
    )).toBe(true)
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-15_39500_0', { import_source: 'open_payments' }),
      feed('eb_SE00_2026-10-16_39500_0', { import_source: 'open_payments' }),
    )).toBe(true)
  })

  it('proves two same-day rows of one amount distinct when both carry a bank id and the ids differ', () => {
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-14_39500_140', { provider_transaction_id: 'ref-b' }),
      feed('eb_SE00_2026-10-14_39500_2', { provider_transaction_id: 'ref-a' }),
    )).toBe(true)
  })

  it('still calls a page the bank served twice a copy: same day, same bank id (crm#1295)', () => {
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-14_39500_7', { provider_transaction_id: 'ref-a' }),
      feed('eb_SE00_2026-10-14_39500_2', { provider_transaction_id: ' ref-a ' }),
    )).toBe(false)
  })

  it('proves nothing for same-day rows of one amount without two bank ids', () => {
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-14_39500_1', { provider_transaction_id: 'ref-a' }),
      feed('eb_SE00_2026-10-14_39500_0'),
    )).toBe(false)
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-14_39500_1', { provider_transaction_id: '' }),
      feed('eb_SE00_2026-10-14_39500_0', { provider_transaction_id: 'ref-a' }),
    )).toBe(false)
  })

  it('proves nothing across a reconnect, another account scope, another feed or an old id format', () => {
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-15_39500_0'),
      feed('eb_SE00_2026-10-14_39500_0', { bank_connection_id: 'bc-2' }),
    )).toBe(false)
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-15_39500_0'),
      feed('eb_SE99_2026-10-14_39500_0'),
    )).toBe(false)
    // Enable Banking and Open Payments share the 'eb' namespace: an account
    // that moved between them is one account seen through two feeds.
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-15_39500_0'),
      feed('eb_SE00_2026-10-14_39500_0', { import_source: 'open_payments' }),
    )).toBe(false)
    // The pre-June-2026 scheme keyed on the bank's id: a re-sync under the
    // new scheme stored the same movement again.
    expect(idsProveDistinctBookings(
      feed('eb_SE00_2026-10-15_39500_0'),
      feed('eb_acct-uid_8c2f0d'),
    )).toBe(false)
  })

  it('proves two rows of one uploaded bank file distinct, never two uploads', () => {
    const file = (external_id: string, bank_file_import_id: string | null) => ({
      external_id, import_source: 'csv_nordea_business', bank_connection_id: null, bank_file_import_id,
    })
    expect(idsProveDistinctBookings(file('nordea_aaaa', 'bfi-1'), file('nordea_bbbb', 'bfi-1'))).toBe(true)
    expect(idsProveDistinctBookings(file('nordea_aaaa', 'bfi-1'), file('nordea_bbbb', 'bfi-2'))).toBe(false)
    expect(idsProveDistinctBookings(file('nordea_aaaa', 'bfi-1'), file('nordea_bbbb', null))).toBe(false)
    expect(idsProveDistinctBookings(file('nordea_aaaa', 'bfi-1'), file('nordea_aaaa', 'bfi-1'))).toBe(false)
  })
})
