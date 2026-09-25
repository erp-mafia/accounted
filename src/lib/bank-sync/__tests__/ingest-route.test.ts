import { describe, expect, it, vi } from 'vitest'
import { resolveBankIngestRoute } from '../ingest-route'

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
})
