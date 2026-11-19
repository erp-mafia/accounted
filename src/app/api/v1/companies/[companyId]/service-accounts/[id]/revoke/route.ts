/**
 * POST /api/v1/companies/{companyId}/service-accounts/{id}/revoke: revoke a
 * service account and every key it has. Soft and final: the account stays,
 * marked revoked, so the processing history keeps naming it. Owners and
 * admins only.
 */

import { ok } from '@/lib/api/v1/response'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { revokeServiceAccount } from '@/lib/service-accounts/service'
import {
  EXAMPLE_SERVICE_ACCOUNT,
  isUuid,
  SERVICE_ACCOUNT_GATE_ERROR_CODES,
  ServiceAccountSchema,
  serviceAccountCaller,
  serviceAccountFailureResponse,
  serviceAccountGate,
} from '@/lib/service-accounts/v1'

registerEndpoint({
  operation: 'service-accounts.revoke',
  method: 'POST',
  path: '/api/v1/companies/:companyId/service-accounts/:id/revoke',
  summary: 'Revoke a service account and all its keys.',
  description:
    'Revokes the service account and, in the same transaction, every key it has: the next request with any of them is refused. ' +
    'The account is never deleted: it stays listed with status revoked, so the processing history keeps naming it. ' +
    'Revoking a revoked account answers it unchanged.',
  useWhen: 'An integration is retired, or a key may have leaked and you want everything the account can do stopped at once.',
  doNotUseFor: 'Rotating one key: mint a new key, then revoke the old one with POST /service-accounts/{id}/keys/{keyId}/revoke.',
  pitfalls: [
    'Final: a revoked account cannot get new keys or be restored. Create a new account (the name is free again).',
    'Writes the account made stay as they are; they keep naming the account and its sponsor.',
  ],
  example: {
    response: {
      data: {
        ...EXAMPLE_SERVICE_ACCOUNT,
        status: 'revoked',
        revoked_at: '2026-11-02T09:30:00Z',
        revoked_by: EXAMPLE_SERVICE_ACCOUNT.created_by,
      },
      meta: { request_id: 'req_…', api_version: API_V1_VERSION },
    },
  },
  scope: 'service_accounts:manage',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: dataEnvelope(ServiceAccountSchema),
    errorCodes: [...SERVICE_ACCOUNT_GATE_ERROR_CODES, 'SERVICE_ACCOUNT_NOT_FOUND'],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'service-accounts.revoke',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const refused = await serviceAccountGate(ctx)
    if (refused) return refused
    if (!isUuid(id)) {
      return v1ErrorResponseFromCode('SERVICE_ACCOUNT_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { service_account_id: id },
      })
    }

    const result = await revokeServiceAccount(ctx.supabase, ctx.companyId!, serviceAccountCaller(ctx), id)
    if (!result.ok) return serviceAccountFailureResponse(ctx, result)
    ctx.log.info('service account revoked', { serviceAccountId: id })
    return ok(result.value, { requestId: ctx.requestId })
  },
)
