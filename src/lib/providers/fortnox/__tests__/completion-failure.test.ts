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
