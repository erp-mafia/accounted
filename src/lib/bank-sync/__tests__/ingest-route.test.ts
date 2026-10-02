import { describe, expect, it, vi } from 'vitest'
import { isBankRouteUnresolved, isBankRoutingConflict, resolveBankIngestRoute } from '../ingest-route'

const route = { connectionId: 'connection', accountUid: 'uid', currency: 'SEK', sessionId: 'session',
  cashAccountId: 'cash', ledgerAccount: '1930', token: 'token' }
describe('resolveBankIngestRoute', () => {
  it('requests the company-scoped UID route and returns its checked context', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: route, error: null })
    expect(await resolveBankIngestRoute({ rpc } as never, 'company', 'connection', 'uid', 'sek')).toEqual(route)
    expect(rpc).toHaveBeenCalledWith('resolve_bank_ingest_route', {
      p_company_id: 'company', p_connection_id: 'connection', p_account_uid: 'uid', p_currency: 'sek',
    })
  })
  it.each([null, { ...route, token: null }, { ...route, accountUid: 'different' }, { ...route, currency: 'EUR' }])('rejects missing or inconsistent context', async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null })
    await expect(resolveBankIngestRoute({ rpc } as never, 'company', 'connection', 'uid', 'SEK')).rejects.toThrow('could not be resolved')
  })
  it('does not convert a database error into an unbound destination', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '40001', message: 'route changed' } })
    await expect(resolveBankIngestRoute({ rpc } as never, 'company', 'connection', 'uid', 'SEK')).rejects.toMatchObject({ code: '40001' })
  })
  it('keeps a PT409 refusal name verbatim so it stays dispatchable', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'PT409', message: 'BANK_INGEST_ROUTE_UNRESOLVED' } })
    const error = await resolveBankIngestRoute({ rpc } as never, 'company', 'connection', 'uid', 'SEK').catch(e => e)
    expect(error).toMatchObject({ code: 'PT409', message: 'BANK_INGEST_ROUTE_UNRESOLVED' })
    expect(isBankRouteUnresolved(error)).toBe(true)
  })
})

describe('isBankRouteUnresolved', () => {
  it('matches only the unresolved route, not other routing conflicts', () => {
    const other = Object.assign(new Error('BANK_INGEST_ACCOUNT_CHANGED'), { code: 'PT409' })
    expect(isBankRoutingConflict(other)).toBe(true)
    expect(isBankRouteUnresolved(other)).toBe(false)
    expect(isBankRouteUnresolved(Object.assign(new Error('BANK_INGEST_ROUTE_UNRESOLVED'), { code: '40001' }))).toBe(false)
    expect(isBankRouteUnresolved(null)).toBe(false)
  })
})
