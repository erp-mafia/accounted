/**
 * GET /api/v1/companies/{companyId}/service-accounts/{id}: one service
 * account with its keys (never their secrets). Owners and admins only.
 */

import { ok } from '@/lib/api/v1/response'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { getServiceAccount } from '@/lib/service-accounts/service'
import {
  EXAMPLE_SERVICE_ACCOUNT,
  EXAMPLE_SERVICE_ACCOUNT_KEY,
  isUuid,
  SERVICE_ACCOUNT_GATE_ERROR_CODES,
  ServiceAccountDetailSchema,
  serviceAccountGate,
} from '@/lib/service-accounts/v1'

registerEndpoint({
  operation: 'service-accounts.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/service-accounts/:id',
  summary: 'Show one service account with its keys.',
  description:
    'Returns the service account, its sponsor and status, and every key it has (live and revoked, newest first) with prefix, scopes, ' +
    'mode, access and last use. A key\'s secret is never returned after it was minted.',
  useWhen: 'You check which keys an integration\'s service account has before rotating or revoking one.',
  doNotUseFor: 'Recovering a lost key: mint a new one and revoke the old one.',
  pitfalls: [
    'An id that is not one of this company\'s service accounts answers 404 SERVICE_ACCOUNT_NOT_FOUND.',
    'Needs a person\'s key with service_accounts:manage, held by an owner or admin of the company.',
  ],
  example: {
    response: {
      data: { ...EXAMPLE_SERVICE_ACCOUNT, keys: [EXAMPLE_SERVICE_ACCOUNT_KEY] },
      meta: { request_id: 'req_…', api_version: API_V1_VERSION },
    },
  },
  scope: 'service_accounts:manage',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: dataEnvelope(ServiceAccountDetailSchema),
    errorCodes: [...SERVICE_ACCOUNT_GATE_ERROR_CODES, 'SERVICE_ACCOUNT_NOT_FOUND'],
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'service-accounts.get',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const refused = await serviceAccountGate(ctx)
    if (refused) return refused

    const account = isUuid(id) ? await getServiceAccount(ctx.supabase, ctx.companyId!, id) : null
    if (!account) {
      return v1ErrorResponseFromCode('SERVICE_ACCOUNT_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { service_account_id: id },
      })
    }
    return ok(account, { requestId: ctx.requestId })
  },
)
