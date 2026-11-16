/**
 * POST /api/v1/companies/{companyId}/service-accounts/{id}/keys: mint an API
 * key for a service account. The secret is returned exactly once and stored
 * only as its SHA-256. Owners and admins only.
 *
 * Idempotency-Key is deliberately not honoured here (withApiV1
 * secretResponse): replaying the response would mean keeping the plaintext
 * key in idempotency_keys for a day. A repeat mints a second key, which the
 * caller sees on GET /service-accounts/{id} and can revoke.
 */

import { created } from '@/lib/api/v1/response'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { mintServiceAccountKey } from '@/lib/service-accounts/service'
import {
  EXAMPLE_SERVICE_ACCOUNT,
  EXAMPLE_SERVICE_ACCOUNT_KEY,
  isUuid,
  MintedServiceAccountKeySchema,
  MintServiceAccountKeyBody,
  SERVICE_ACCOUNT_GATE_ERROR_CODES,
  serviceAccountCaller,
  serviceAccountFailureResponse,
  serviceAccountGate,
} from '@/lib/service-accounts/v1'

/** Neither a CDN, a proxy nor a browser cache may keep the secret. */
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
}

registerEndpoint({
  operation: 'service-accounts.keys.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/service-accounts/:id/keys',
  summary: 'Mint an API key for a service account; the secret is shown once.',
  description:
    'Creates a gnubok_sk_ key that acts as the service account: it reaches only the account\'s company, acts with the access of the account\'s sponsor, ' +
    'and everything it writes is recorded with the actor service_account (the account\'s name), acting for the sponsor. ' +
    'The response carries the secret in key, exactly once. Its scopes must be ones the calling key holds itself; ' +
    'service_accounts:manage is never granted, so a service account cannot mint keys or create accounts.',
  useWhen: 'You set up the integration that runs as the service account, or rotate its key (mint the new one, switch, revoke the old one).',
  doNotUseFor:
    'A key for a person (create it in Agents > Connect an agent). Recovering a lost secret: mint a new key and revoke the old one.',
  pitfalls: [
    'The secret is returned exactly once. Idempotency-Key is not honoured: a repeated call mints a second key, so check GET /service-accounts/{id} and revoke any extra.',
    'Each requested scope must be held by the calling key (403 SERVICE_ACCOUNT_SCOPE_NOT_HELD, details.not_held lists the rest).',
    'A staging write scope together with pending_operations:approve needs acknowledge_sod: true (409 API_KEY_SOD_CONFLICT otherwise).',
    'At most 5 live keys per account (409 SERVICE_ACCOUNT_KEY_LIMIT). A revoked account takes no new key (409 SERVICE_ACCOUNT_REVOKED); a suspended one neither (403 SERVICE_ACCOUNT_SUSPENDED).',
    'When the sponsor stops being an owner or admin, the key is refused at every call with 403 SERVICE_ACCOUNT_SUSPENDED until the role is restored.',
  ],
  example: {
    request: { scopes: ['invoices:read', 'invoices:write'] },
    response: {
      data: {
        ...EXAMPLE_SERVICE_ACCOUNT_KEY,
        service_account_id: EXAMPLE_SERVICE_ACCOUNT.id,
        key: 'gnubok_sk_Xb3kQ9aZ…',
      },
      meta: { request_id: 'req_…', api_version: API_V1_VERSION },
    },
  },
  scope: 'service_accounts:manage',
  risk: 'high',
  idempotent: false,
  reversible: true,
  dryRunSupported: false,
  request: { body: MintServiceAccountKeyBody },
  response: {
    success: dataEnvelope(MintedServiceAccountKeySchema),
    errorCodes: [
      ...SERVICE_ACCOUNT_GATE_ERROR_CODES,
      'VALIDATION_ERROR',
      'SERVICE_ACCOUNT_NOT_FOUND',
      'SERVICE_ACCOUNT_REVOKED',
      'SERVICE_ACCOUNT_SCOPE_NOT_HELD',
      'SERVICE_ACCOUNT_KEY_LIMIT',
      'API_KEY_SOD_CONFLICT',
    ],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'service-accounts.keys.create',
  async (request, ctx, { params }) => {
    const { id } = await params
    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const parsed = MintServiceAccountKeyBody.safeParse(raw.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const refused = await serviceAccountGate(ctx)
    if (refused) return refused
    if (!isUuid(id)) {
      return v1ErrorResponseFromCode('SERVICE_ACCOUNT_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { service_account_id: id },
      })
    }

    const body = parsed.data
    const result = await mintServiceAccountKey(ctx.supabase, ctx.companyId!, serviceAccountCaller(ctx), id, {
      scopes: body.scopes,
      ...(body.name ? { name: body.name.trim() } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.read_only ? { readOnly: true } : {}),
      ...(body.acknowledge_sod ? { acknowledgeSod: true } : {}),
    })
    if (!result.ok) return serviceAccountFailureResponse(ctx, result)

    const { key, secret, sodAcknowledged } = result.value
    // Never the scopes or the secret in the log: the prefix and ids identify it.
    ctx.log.info('service account key minted', { serviceAccountId: id, keyId: key.id, keyPrefix: key.key_prefix })
    if (sodAcknowledged) {
      ctx.log.warn('api_key.sod_acknowledged', { serviceAccountId: id, keyId: key.id, acknowledgedBy: ctx.userId })
    }
    return created(
      { ...key, service_account_id: id, key: secret },
      { requestId: ctx.requestId, headers: NO_STORE_HEADERS },
    )
  },
  { secretResponse: true },
)
