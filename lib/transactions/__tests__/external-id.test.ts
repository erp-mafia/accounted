import { describe, it, expect } from 'vitest'
import {
  amountToOre,
  buildStableExternalIds,
  contentBucketKey,
  descriptionsBridge,
  normalizeImportedDescription,
  shiftIsoDate,
  FALLBACK_DESCRIPTION,
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

describe('shiftIsoDate', () => {
  it('shifts a date forward and backward by whole days', () => {
    expect(shiftIsoDate('2024-06-15', 1)).toBe('2024-06-16')
    expect(shiftIsoDate('2024-06-15', -1)).toBe('2024-06-14')
    expect(shiftIsoDate('2024-06-15', 0)).toBe('2024-06-15')
  })

  it('crosses month and year boundaries', () => {
    expect(shiftIsoDate('2024-06-30', 1)).toBe('2024-07-01')
    expect(shiftIsoDate('2024-07-01', -1)).toBe('2024-06-30')
    expect(shiftIsoDate('2025-12-31', 1)).toBe('2026-01-01')
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('handles the leap day deterministically (no wall-clock dependency)', () => {
    expect(shiftIsoDate('2024-02-28', 1)).toBe('2024-02-29') // 2024 is a leap year
    expect(shiftIsoDate('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftIsoDate('2025-02-28', 1)).toBe('2025-03-01') // 2025 is not
  })
})
