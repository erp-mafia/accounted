/**
 * Tests for the skattekonto API client's wire-shape normalization.
 *
 * Skatteverket's JSON schema for /transaktioner does NOT require the belopp
 * fields: rows with no SKV-side amount (e.g. amount at Kronofogden) omit
 * beloppSkatteverket entirely. Before normalization, such a row flowed as
 * undefined into the NOT NULL belopp_skatteverket column and made the whole
 * sync upsert fail for the company, permanently (issue #1821). The client
 * must therefore guarantee numbers on every row it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const skvRequestWithAuthMock = vi.fn()
vi.mock('../lib/api-client', () => ({
  skvRequestWithAuth: (...args: unknown[]) => skvRequestWithAuthMock(...args),
}))

import { getTransaktioner, SkatteverketSkattekontoError } from '../lib/skattekonto-client'
import type { SkvAuth } from '../lib/api-client'

const auth = { mode: 'system' } as SkvAuth

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('getTransaktioner normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults a missing beloppSkatteverket to 0 and missing beloppKronofogden to null', async () => {
    skvRequestWithAuthMock.mockResolvedValue(
      jsonResponse({
        tidigareTransaktioner: [
          {
            transaktionsidentitet: 42,
            transaktionsdatum: '2026-08-01',
            ranteberakningsdatum: '2026-08-01',
            transaktionstext: 'Överlämnad till Kronofogden',
            beloppKronofogden: -5000,
            // beloppSkatteverket intentionally absent (optional per SKV schema)
          },
        ],
        kommandeTransaktioner: [
          {
            transaktionsdatum: '2026-09-12',
            forfallodatum: '2026-09-12',
            ranteberakningsdatum: null,
            transaktionstext: 'Debiterad preliminärskatt',
            // both belopp fields absent
          },
        ],
      }),
    )

    const result = await getTransaktioner(auth, '165500000001')

    expect(result.tidigareTransaktioner).toHaveLength(1)
    expect(result.tidigareTransaktioner[0].beloppSkatteverket).toBe(0)
    expect(result.tidigareTransaktioner[0].beloppKronofogden).toBe(-5000)

    expect(result.kommandeTransaktioner).toHaveLength(1)
    expect(result.kommandeTransaktioner[0].beloppSkatteverket).toBe(0)
    expect(result.kommandeTransaktioner[0].beloppKronofogden).toBeNull()
    expect(result.kommandeTransaktioner[0].transaktionsidentitet).toBeNull()
  })

  it('passes real amounts through unchanged, including 0 and negatives', async () => {
    skvRequestWithAuthMock.mockResolvedValue(
      jsonResponse({
        tidigareTransaktioner: [
          {
            transaktionsidentitet: 1,
            transaktionsdatum: '2026-07-13',
            ranteberakningsdatum: '2026-07-13',
            transaktionstext: 'Arbetsgivaravgift juni 2026',
            beloppSkatteverket: -15710,
            beloppKronofogden: 0,
          },
        ],
        kommandeTransaktioner: [
          {
            transaktionsidentitet: 2,
            transaktionsdatum: '2026-09-12',
            forfallodatum: '2026-09-12',
            ranteberakningsdatum: '2026-09-12',
            transaktionstext: 'Moms aug 2026',
            beloppSkatteverket: 12000,
            beloppKronofogden: null,
          },
        ],
      }),
    )

    const result = await getTransaktioner(auth, '165500000001')

    expect(result.tidigareTransaktioner[0].beloppSkatteverket).toBe(-15710)
    expect(result.tidigareTransaktioner[0].beloppKronofogden).toBe(0)
    expect(result.kommandeTransaktioner[0].beloppSkatteverket).toBe(12000)
    expect(result.kommandeTransaktioner[0].beloppKronofogden).toBeNull()
    expect(result.kommandeTransaktioner[0].transaktionsidentitet).toBe(2)
  })

  it('coerces a null beloppSkatteverket to 0 as well', async () => {
    skvRequestWithAuthMock.mockResolvedValue(
      jsonResponse({
        tidigareTransaktioner: [
          {
            transaktionsidentitet: 7,
            transaktionsdatum: '2026-08-02',
            ranteberakningsdatum: '2026-08-02',
            transaktionstext: 'Utmätning Kronofogden',
            beloppSkatteverket: null,
            beloppKronofogden: null,
          },
        ],
      }),
    )

    const result = await getTransaktioner(auth, '165500000001')

    expect(result.tidigareTransaktioner[0].beloppSkatteverket).toBe(0)
    expect(result.tidigareTransaktioner[0].beloppKronofogden).toBeNull()
    expect(result.kommandeTransaktioner).toEqual([])
  })

  it('defaults missing arrays to empty lists', async () => {
    skvRequestWithAuthMock.mockResolvedValue(jsonResponse({}))

    const result = await getTransaktioner(auth, '165500000001')

    expect(result.tidigareTransaktioner).toEqual([])
    expect(result.kommandeTransaktioner).toEqual([])
  })

  it('still maps felkod errors to Swedish messages', async () => {
    skvRequestWithAuthMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ felkod: 3, felmeddelande: 'whatever' }, 404)),
    )

    const err = await getTransaktioner(auth, '165500000001').then(
      () => null,
      e => e as Error,
    )
    expect(err).toBeInstanceOf(SkatteverketSkattekontoError)
    expect(err?.message).toBe('Inget skattekonto är registrerat hos Skatteverket.')
  })
})
