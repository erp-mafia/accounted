/**
 * The skattekonto client's reading of Skatteverket's non-200 answers (B07).
 *
 * Prod: newly formed companies get a bare 404 `{"message": "Not found"}` on
 * /skattekonton/{id}/saldo and /transaktioner; the same identifier on the
 * same consent answers 200 once Skatteverket has opened the account. That is
 * "no skattekonto yet", the felkod 3 state, not a failed request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requestMock = vi.fn()
vi.mock('../lib/api-client', () => ({
  skvRequestWithAuth: (...args: unknown[]) => requestMock(...args),
}))

import {
  getSaldo,
  getTransaktioner,
  isSkattekontoMissing,
  SkatteverketSkattekontoError,
} from '../lib/skattekonto-client'

const AUTH = { mode: 'system' } as const
const ACTOR = { companyId: 'company-1', userId: null }

async function saldoError(response: Response): Promise<unknown> {
  requestMock.mockResolvedValue(response)
  try {
    await getSaldo(AUTH, '165560000000', ACTOR)
  } catch (err) {
    return err
  }
  throw new Error('expected getSaldo to throw')
}

describe('skattekonto client: error answers', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('a bare 404 (no felkod) means no skattekonto yet, with the Swedish sentence', async () => {
    const err = await saldoError(new Response('{\n  "message": "Not found"\n}', { status: 404 }))
    expect(err).toBeInstanceOf(SkatteverketSkattekontoError)
    expect((err as SkatteverketSkattekontoError).message).toBe('Inget skattekonto är registrerat hos Skatteverket.')
    expect((err as SkatteverketSkattekontoError).httpStatus).toBe(404)
    expect(isSkattekontoMissing(err)).toBe(true)
  })

  it('the transaktioner read classifies the same 404 the same way', async () => {
    requestMock.mockResolvedValue(new Response('{"message":"Not found"}', { status: 404 }))
    const err = await getTransaktioner(AUTH, '165560000000', undefined, ACTOR).catch((e: unknown) => e)
    expect(isSkattekontoMissing(err)).toBe(true)
  })

  it('felkod 3 is the same state', async () => {
    const err = await saldoError(
      new Response(JSON.stringify({ felkod: 3, felmeddelande: 'Skattekonto saknas' }), { status: 400 }),
    )
    expect(isSkattekontoMissing(err)).toBe(true)
  })

  it('a real failure stays a failure: felkod 4 and a bare 500 are not "missing"', async () => {
    const internal = await saldoError(
      new Response(JSON.stringify({ felkod: 4, felmeddelande: 'Internt fel' }), { status: 500 }),
    )
    expect(isSkattekontoMissing(internal)).toBe(false)
    const bare500 = await saldoError(new Response('oops', { status: 500 }))
    expect(isSkattekontoMissing(bare500)).toBe(false)
    expect((bare500 as Error).message).toBe('Skatteverket svarade med 500')
  })

  it('a 200 still returns the saldo', async () => {
    requestMock.mockResolvedValue(new Response(JSON.stringify({ saldoSkatteverket: 0 }), { status: 200 }))
    await expect(getSaldo(AUTH, '165560000000', ACTOR)).resolves.toMatchObject({ saldoSkatteverket: 0 })
  })
})

describe('skattekonto client: transaktioner lists', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('a body with its lists is listed, an empty kommande list included', async () => {
    requestMock.mockResolvedValue(
      new Response(JSON.stringify({ tidigareTransaktioner: [], kommandeTransaktioner: [] }), { status: 200 }),
    )
    const res = await getTransaktioner(AUTH, '165560000000', undefined, ACTOR)
    expect(res).toEqual({ tidigareTransaktioner: [], kommandeTransaktioner: [], listed: true })
  })

  it('a body with only the booked list is still listed: no kommande rows', async () => {
    requestMock.mockResolvedValue(new Response(JSON.stringify({ tidigareTransaktioner: [] }), { status: 200 }))
    const res = await getTransaktioner(AUTH, '165560000000', undefined, ACTOR)
    expect(res.listed).toBe(true)
    expect(res.kommandeTransaktioner).toEqual([])
  })

  it('a body with neither list is not listed', async () => {
    requestMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const res = await getTransaktioner(AUTH, '165560000000', undefined, ACTOR)
    expect(res.listed).toBe(false)
  })
})
