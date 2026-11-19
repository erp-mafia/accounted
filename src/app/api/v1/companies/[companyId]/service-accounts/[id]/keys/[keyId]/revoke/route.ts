/**
 * POST /api/v1/companies/{companyId}/service-accounts/{id}/keys/{keyId}/revoke:
 * revoke one key of a service account. Idempotent. Owners and admins only.
 */

import { ok } from '@/lib/api/v1/response'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { revokeServiceAccountKey } from '@/lib/service-accounts/service'
import {
  EXAMPLE_SERVICE_ACCOUNT_KEY,
  isUuid,
  SERVICE_ACCOUNT_GATE_ERROR_CODES,
  ServiceAccountKeySchema,
  serviceAccountCaller,
  serviceAccountFailureResponse,
  serviceAccountGate,
} from '@/lib/service-accounts/v1'

registerEndpoint({
  operation: 'service-accounts.keys.revoke',
  method: 'POST',
  path: '/api/v1/companies/:companyId/service-accounts/:id/keys/:keyId/revoke',
  summary: 'Revoke one key of a service account.',
  description:
    'Revokes the key: the next request with it is refused. The account and its other keys are untouched. ' +
    'Revoking a revoked key answers it unchanged.',
  useWhen: 'You rotate a service account\'s key (after switching the integration to the new one) or a single key may have leaked.',
  doNotUseFor: 'Stopping the whole integration at once: revoke the account (POST /service-accounts/{id}/revoke).',
  pitfalls: [
    'Final: a revoked key cannot be restored. Mint a new one.',
    'A key that is not one of this account\'s keys in this company answers 404 SERVICE_ACCOUNT_KEY_NOT_FOUND.',
  ],
  example: {
    response: {
      data: { ...EXAMPLE_SERVICE_ACCOUNT_KEY, revoked_at: '2026-11-02T09:30:00Z' },
      meta: { request_id: 'req_…', api_version: API_V1_VERSION },
    },
  },
  scope: 'service_accounts:manage',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: dataEnvelope(ServiceAccountKeySchema),
    errorCodes: [...SERVICE_ACCOUNT_GATE_ERROR_CODES, 'SERVICE_ACCOUNT_KEY_NOT_FOUND'],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string; keyId: string }> }>(
  'service-accounts.keys.revoke',
  async (_request, ctx, { params }) => {
    const { id, keyId } = await params
    const refused = await serviceAccountGate(ctx)
    if (refused) return refused
    if (!isUuid(id) || !isUuid(keyId)) {
      return v1ErrorResponseFromCode('SERVICE_ACCOUNT_KEY_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { service_account_id: id, key_id: keyId },
      })
    }

    const result = await revokeServiceAccountKey(ctx.supabase, ctx.companyId!, serviceAccountCaller(ctx), id, keyId)
    if (!result.ok) return serviceAccountFailureResponse(ctx, result)
    ctx.log.info('service account key revoked', { serviceAccountId: id, keyId })
    return ok(result.value, { requestId: ctx.requestId })
  },
)
