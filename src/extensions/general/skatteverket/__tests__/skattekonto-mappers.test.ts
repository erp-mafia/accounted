import { describe, it, expect } from 'vitest'
import { computeDedupKey } from '../lib/skattekonto-sync'
import type {
  SkatteverketSaldoResponse,
  SkatteverketTransaktionerResponse,
} from '../types'

// Fixtures inlined verbatim from Skatteverket's official Skattekonto v2.1.0
// API examples (dev_docs/skattekonto(2.1.0)/examples/*.json). The dev_docs
// directory is gitignored, so the fixtures must live alongside the test.
const saldoResponseExample = {
  nastaAvstamningsdatum: '2019-06-01',
  senastUppdaterad: '2019-05-06T03:04:05Z',
  informationstext: [],
  saldoSkatteverket: -14487,
  saldoKronofogden: -145409,
  rantaSkatteverket: -12,
  rantaKronofogden: -10,
  ocrNummer: '1948040320946',
}

const transaktionerResponseExample = {
  nastaAvstamningsdatum: '2019-06-01',
  senastUppdaterad: '2019-05-06T03:04:05Z',
  informationstext: ['Test av informationstext'],
  ocrNummer: '1948040320946',
  datumFrom: '2017-10-28',
  tidigareTransaktioner: [
    {
      transaktionsidentitet: 746876987,
      transaktionsdatum: '2019-04-16',
      ranteberakningsdatum: '2019-04-13',
      transaktionstext: 'Inbetalning bokförd 190412',
      beloppSkatteverket: 1292,
    },
    {
      transaktionsidentitet: 746876988,
      transaktionsdatum: '2019-04-16',
      ranteberakningsdatum: '2019-04-13',
      transaktionstext: 'Debiterad preliminärskatt',
      beloppSkatteverket: -1292,
    },
    {
      transaktionsidentitet: 746876989,
      transaktionsdatum: '2019-04-16',
      ranteberakningsdatum: '2019-04-12',
      transaktionstext: 'Inbetalning bokförd 190411',
      beloppSkatteverket: 5402,
    },
    {
      transaktionsidentitet: 746876990,
      transaktionsdatum: '2019-04-16',
      ranteberakningsdatum: '2019-04-13',
      transaktionstext: 'Avdragen skatt mars 2019',
      beloppSkatteverket: -3000,
    },
    {
      transaktionsidentitet: 746876991,
      transaktionsdatum: '2019-04-16',
      ranteberakningsdatum: '2019-04-13',
      transaktionstext: 'Arbetsgivaravgift mars 2019',
      beloppSkatteverket: -2402,
    },
  ],
  kommandeTransaktioner: [
    {
      transaktionsdatum: '2019-03-13',
      forfallodatum: '2019-05-13',
      ranteberakningsdatum: '2019-05-14',
      transaktionstext: 'Debiterad prelimniärskatt',
      beloppSkatteverket: -1292,
    },
  ],
}

describe('skattekonto example payloads', () => {
  it('saldoResponse.json fits SkatteverketSaldoResponse', () => {
    const saldo = saldoResponseExample as SkatteverketSaldoResponse
    expect(saldo.saldoSkatteverket).toBe(-14487)
    expect(saldo.saldoKronofogden).toBe(-145409)
    expect(saldo.ocrNummer).toBe('1948040320946')
    expect(saldo.nastaAvstamningsdatum).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(saldo.informationstext)).toBe(true)
  })

  it('transaktionerResponse.json fits SkatteverketTransaktionerResponse', () => {
    const tx = transaktionerResponseExample as SkatteverketTransaktionerResponse
    expect(Array.isArray(tx.tidigareTransaktioner)).toBe(true)
    expect(Array.isArray(tx.kommandeTransaktioner)).toBe(true)

    const booked = tx.tidigareTransaktioner[0]
    expect(typeof booked.transaktionsidentitet).toBe('number')
    expect(booked.transaktionsdatum).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof booked.beloppSkatteverket).toBe('number')
  })
})

describe('computeDedupKey', () => {
  it('uses transaktionsidentitet when present', () => {
    const key = computeDedupKey({
      transaktionsidentitet: 746876987,
      transaktionsdatum: '2019-04-16',
      beloppSkatteverket: 1292,
      transaktionstext: 'Inbetalning bokförd 190412',
    })
    expect(key).toBe('id:746876987')
  })

  it('falls back to a content hash when transaktionsidentitet is missing', () => {
    const key = computeDedupKey({
      transaktionsidentitet: null,
      transaktionsdatum: '2019-05-13',
      beloppSkatteverket: -1292,
      transaktionstext: 'Debiterad preliminärskatt',
    })
    expect(key).toMatch(/^h:[0-9a-f]{64}$/)
  })

  it('produces stable keys for the same content', () => {
    const tx = {
      transaktionsidentitet: null,
      transaktionsdatum: '2019-05-13',
      beloppSkatteverket: -1292,
      transaktionstext: 'Debiterad preliminärskatt',
    }
    expect(computeDedupKey(tx)).toBe(computeDedupKey(tx))
  })

  it('produces different keys for different content', () => {
    const a = computeDedupKey({
      transaktionsidentitet: null,
      transaktionsdatum: '2019-05-13',
      beloppSkatteverket: -1292,
      transaktionstext: 'A',
    })
    const b = computeDedupKey({
      transaktionsidentitet: null,
      transaktionsdatum: '2019-05-13',
      beloppSkatteverket: -1292,
      transaktionstext: 'B',
    })
    expect(a).not.toBe(b)
  })

  it('treats undefined transaktionsidentitet the same as null', () => {
    const a = computeDedupKey({
      transaktionsdatum: '2019-05-13',
      beloppSkatteverket: -1292,
      transaktionstext: 'X',
    })
    const b = computeDedupKey({
      transaktionsidentitet: null,
      transaktionsdatum: '2019-05-13',
      beloppSkatteverket: -1292,
      transaktionstext: 'X',
    })
    expect(a).toBe(b)
  })
})
