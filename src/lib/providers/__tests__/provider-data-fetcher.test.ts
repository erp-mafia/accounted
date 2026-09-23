import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Locks fetchCompanyInfoDirect's failure contract.
 *
 * It used to wrap the whole body in try/catch and return null on ANY error, so
 * a Visma company whose api_standard module is off looked exactly like a
 * company with no details: /preview answered 200 with companyInfo: null and
 * its classify-and-rethrow remediation (PROVIDER_API_MODULE_INACTIVE, with the
 * "Appar och tillägg" instructions) was unreachable code. The customer read
 * "connected" and only found out after an empty migration.
 *
 * Contract now: provider errors propagate, and null keeps its one meaning,
 * "there is nothing to fetch here".
 */

const { vismaGet, bokioGetCompany, fortnoxGetPaginated } = vi.hoisted(() => ({
  vismaGet: vi.fn(),
  bokioGetCompany: vi.fn(),
  fortnoxGetPaginated: vi.fn(),
}))

vi.mock('../fortnox/client', () => ({
  FortnoxClient: class {
    getPaginated = fortnoxGetPaginated
  },
  FortnoxApiError: class FortnoxApiError extends Error {},
}))

vi.mock('../visma/client', () => ({
  VismaClient: class {
    get = vismaGet
  },
}))

vi.mock('../bokio/client', () => ({
  BokioClient: class {
    getCompany = bokioGetCompany
  },
  BokioApiError: class BokioApiError extends Error {},
}))

import { fetchAccountingAccountsDirect, fetchCompanyInfoDirect } from '../provider-data-fetcher'

const VISMA_MODULE_BODY =
  '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'

function vismaError(statusCode: number, body?: string): Error {
  const e = new Error(`Visma API error: ${statusCode}`) as Error & {
    statusCode: number
    body?: string
  }
  e.statusCode = statusCode
  e.body = body
  return e
}

describe('fetchCompanyInfoDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('propagates a provider failure instead of swallowing it into null', async () => {
    vismaGet.mockRejectedValue(vismaError(403, VISMA_MODULE_BODY))

    await expect(fetchCompanyInfoDirect('visma', 'tok')).rejects.toMatchObject({
      statusCode: 403,
      body: VISMA_MODULE_BODY,
    })
  })

  it('propagates transient failures too: the caller decides what is soft', async () => {
    vismaGet.mockRejectedValue(vismaError(500))

    await expect(fetchCompanyInfoDirect('visma', 'tok')).rejects.toMatchObject({ statusCode: 500 })
  })

  it('still returns null when there is nothing to fetch, without calling the provider', async () => {
    // Bokio needs the provider company id to address the company endpoint.
    await expect(fetchCompanyInfoDirect('bokio', 'tok')).resolves.toBeNull()
    expect(bokioGetCompany).not.toHaveBeenCalled()
  })
})

describe('fetchAccountingAccountsDirect (#2585)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps every Fortnox account with its VATCode', async () => {
    fortnoxGetPaginated.mockResolvedValue([
      { Number: 3041, Description: 'Försäljn tjänst 25% sv', VATCode: 'MP1', Active: true },
      { Number: 4056, Description: 'Inköp varor EU', VATCode: 'IVEU', Active: true },
      { Number: 1930, Description: 'Bank', Active: true },
    ])

    const accounts = await fetchAccountingAccountsDirect('fortnox', 'tok')

    expect(fortnoxGetPaginated).toHaveBeenCalledWith('tok', '/accounts', 'Accounts', { pageSize: 500 })
    expect(accounts.map((a) => [a.accountNumber, a.vatCode])).toEqual([
      ['3041', 'MP1'],
      ['4056', 'IVEU'],
      ['1930', undefined],
    ])
  })

  it('propagates a Fortnox failure: the caller decides whether the codes are optional', async () => {
    fortnoxGetPaginated.mockRejectedValue(new Error('Fortnox API error: 500'))
    await expect(fetchAccountingAccountsDirect('fortnox', 'tok')).rejects.toThrow('500')
  })

  it('answers [] for providers whose codes are not translated yet, without a request', async () => {
    for (const provider of ['visma', 'briox', 'bokio', 'bjornlunden', 'wint'] as const) {
      await expect(fetchAccountingAccountsDirect(provider, 'tok')).resolves.toEqual([])
    }
    expect(vismaGet).not.toHaveBeenCalled()
    expect(fortnoxGetPaginated).not.toHaveBeenCalled()
  })
})
