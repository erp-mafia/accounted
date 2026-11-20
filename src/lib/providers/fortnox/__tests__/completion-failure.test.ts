import { expect, it } from 'vitest'
import { FortnoxApiError } from '../client'
import { fortnoxCompletionBlock } from '../completion-failure'
import { ProviderCallError } from '../../with-provider-call'

it('requires explicit evidence before blocking a connection', () => {
  for (const error of [new Error('invalid_grant'), new FortnoxApiError('denied', 401), new FortnoxApiError('denied', 403),
    new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'opaque'),
    new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'visma', 'expired', { providerCode: 'invalid_grant' }),
    new FortnoxApiError('outage', 503, '{"ErrorInformation":{"code":2001103}}')]) {
    expect(fortnoxCompletionBlock(error)).toBeNull()
  }
})

it('blocks on the documented refusal codes only, read by the shared classifier', () => {
  const fortnox = (status: number, code: number, message: string) =>
    new FortnoxApiError('refused', status, JSON.stringify({ ErrorInformation: { error: 1, message, code } }))
  expect(fortnoxCompletionBlock(fortnox(400, 2001103, 'Api-licens saknas.'))).toBe('PROVIDER_LICENSE_MISSING')
  expect(fortnoxCompletionBlock(fortnox(400, 2001101, 'Det finns ingen aktiv licens för önskat scope.'))).toBe('PROVIDER_RESOURCE_FORBIDDEN')
  expect(fortnoxCompletionBlock(fortnox(403, 2000663, 'Har inte behörighet för scope.'))).toBe('PROVIDER_RESOURCE_FORBIDDEN')
  // A refusal that names a register by an undocumented code is still not
  // enough to suspend scheduled work.
  expect(fortnoxCompletionBlock(fortnox(400, 2002182, 'Saknar behörighet för leverantörsfaktura.'))).toBeNull()
})
