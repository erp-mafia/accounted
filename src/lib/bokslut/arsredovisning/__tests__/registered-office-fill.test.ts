import { describe, expect, it, vi } from 'vitest'
import { askRegisterForRegisteredOffice, loadReportWithRegisteredOffice } from '../registered-office-fill'

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('askRegisterForRegisteredOffice', () => {
  it('posts to the fill route and resolves the säte the server stored', async () => {
    const fetchImpl = answering(200, { data: { status: 'filled', registered_office: 'Sateskommunen' } })
    await expect(askRegisterForRegisteredOffice(fetchImpl)).resolves.toBe('Sateskommunen')
    expect(fetchImpl).toHaveBeenCalledWith('/api/settings/registered-office/from-register', { method: 'POST' })
  })

  it.each([
    ['the company already had a säte', 200, { data: { status: 'present', registered_office: 'X' } }],
    ['the register had none', 200, { data: { status: 'not_found' } }],
    ['no row changed', 200, { data: { status: 'not_saved' } }],
    ['the person may not change the settings', 403, { error: { code: 'FORBIDDEN' } }],
    ['the server failed', 500, { error: 'boom' }],
  ])('resolves null when %s', async (_why, status, body) => {
    await expect(askRegisterForRegisteredOffice(answering(status, body))).resolves.toBeNull()
  })

  it('resolves null, never rejects, when the call itself fails or answers no JSON', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(askRegisterForRegisteredOffice(offline)).resolves.toBeNull()
    const html = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await expect(askRegisterForRegisteredOffice(html)).resolves.toBeNull()
  })
})

describe('loadReportWithRegisteredOffice', () => {
  const report = (registeredOffice: string | null) => ({ data: { company: { registered_office: registeredOffice } } })

  it('asks nothing when the report has a säte', async () => {
    const loadReport = vi.fn(async () => report('Sateskommunen'))
    const askRegister = vi.fn(async () => 'Sateskommunen')
    await expect(loadReportWithRegisteredOffice({ loadReport, askRegister })).resolves.toEqual(report('Sateskommunen'))
    expect(askRegister).not.toHaveBeenCalled()
    expect(loadReport).toHaveBeenCalledTimes(1)
  })

  it.each([[null], [''], ['  ']])('asks the register for a report whose säte is %o and reads it again', async (missing) => {
    const loadReport = vi
      .fn<() => Promise<ReturnType<typeof report>>>()
      .mockResolvedValueOnce(report(missing))
      .mockResolvedValueOnce(report('Sateskommunen'))
    const askRegister = vi.fn(async () => 'Sateskommunen')
    await expect(loadReportWithRegisteredOffice({ loadReport, askRegister })).resolves.toEqual(report('Sateskommunen'))
    expect(askRegister).toHaveBeenCalledTimes(1)
    expect(loadReport).toHaveBeenCalledTimes(2)
  })

  it('keeps the first reading, with its blocker, when the register had no säte', async () => {
    const loadReport = vi.fn(async () => report(null))
    const askRegister = vi.fn(async () => null)
    await expect(loadReportWithRegisteredOffice({ loadReport, askRegister })).resolves.toEqual(report(null))
    expect(loadReport).toHaveBeenCalledTimes(1)
  })

  it('hands back a report that failed to load, with nothing asked', async () => {
    const askRegister = vi.fn(async () => 'Sateskommunen')
    for (const failed of [{ error: { code: 'PERIOD_NOT_FOUND' } }, { data: null }, {}]) {
      const loadReport = vi.fn(async () => failed)
      await expect(loadReportWithRegisteredOffice({ loadReport, askRegister })).resolves.toEqual(failed)
    }
    expect(askRegister).not.toHaveBeenCalled()
  })
})
