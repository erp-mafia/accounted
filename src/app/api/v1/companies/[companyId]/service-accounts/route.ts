/**
 * /api/v1/companies/{companyId}/service-accounts: list and create service
 * accounts (lib/service-accounts).
 *
 * A service account is a non-human principal the company owns, with a human
 * sponsor (an owner or admin) who answers for it. It acts through its own
 * keys (POST /service-accounts/{id}/keys), and everything it writes is
 * recorded as the service account, acting for its sponsor.
 *
 * Owners and admins only, through a person's key with service_accounts:manage.
 */

import { z } from 'zod'
import { created, ok } from '@/lib/api/v1/response'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { v1ValidationError } from '@/lib/api/v1/errors'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { createServiceAccount, listServiceAccounts } from '@/lib/service-accounts/service'
import {
  CreateServiceAccountBody,
  EXAMPLE_SERVICE_ACCOUNT,
  SERVICE_ACCOUNT_GATE_ERROR_CODES,
  ServiceAccountSchema,
  serviceAccountCaller,
  serviceAccountFailureResponse,
  serviceAccountGate,
} from '@/lib/service-accounts/v1'

const ServiceAccountsListResponse = dataEnvelope(z.object({ service_accounts: z.array(ServiceAccountSchema) }))

registerEndpoint({
  operation: 'service-accounts.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/service-accounts',
  summary: 'List the company\'s service accounts.',
  description:
    'Returns every service account of the company, live ones first, then the revoked ones, each with its sponsor and status. ' +
    'Keys are listed per account on GET /service-accounts/{id}.',
  useWhen:
    'You manage the non-human principals of a company: to find the account an integration runs as, or to check that none is suspended.',
  doNotUseFor:
    'Listing the API keys of people (not exposed over the API). Reading a key\'s secret: it is returned once, when the key is minted.',
  pitfalls: [
    'Needs a person\'s key with service_accounts:manage, held by an owner or admin of the company. A service account\'s own key is refused (403 SERVICE_ACCOUNT_KEY_NOT_PERMITTED).',
    'status suspended means the sponsor is no longer an owner or admin: the account\'s keys answer 403 SERVICE_ACCOUNT_SUSPENDED until the role is restored.',
  ],
  example: {
    response: {
      data: { service_accounts: [EXAMPLE_SERVICE_ACCOUNT] },
      meta: { request_id: 'req_…', api_version: API_V1_VERSION },
    },
  },
  scope: 'service_accounts:manage',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: ServiceAccountsListResponse,
    errorCodes: SERVICE_ACCOUNT_GATE_ERROR_CODES,
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'service-accounts.list',
  async (_request, ctx) => {
    const refused = await serviceAccountGate(ctx)
    if (refused) return refused
    const accounts = await listServiceAccounts(ctx.supabase, ctx.companyId!)
    return ok({ service_accounts: accounts }, { requestId: ctx.requestId })
  },
)

registerEndpoint({
  operation: 'service-accounts.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/service-accounts',
  summary: 'Create a service account with a human sponsor.',
  description:
    'Creates a service account in the company: a non-human principal for an integration or agent, with a sponsor who answers for it. ' +
    'The sponsor must be an owner or admin member of the company and defaults to the user of the calling key. ' +
    'The account has no key yet: mint one with POST /service-accounts/{id}/keys. ' +
    'Everything its keys write is recorded with the actor service_account (the account\'s name), acting for the sponsor.',
  useWhen:
    'You connect an integration or agent that should act under its own name in the books rather than as the person who set it up.',
  doNotUseFor:
    'Giving a person access (invite them to the company instead). Changing the sponsor or the name: revoke the account and create a new one.',
  pitfalls: [
    'A service account can never do more than its sponsor: when the sponsor stops being an owner or admin, every key of the account is refused (403 SERVICE_ACCOUNT_SUSPENDED) until the role is restored.',
    'Names are unique among the company\'s live accounts (409 SERVICE_ACCOUNT_NAME_TAKEN); a revoked account frees its name.',
    'At most 25 live service accounts per company (409 SERVICE_ACCOUNT_LIMIT).',
    'Not available with a test key (403 TEST_KEY_WRITE_BLOCKED): there is no dry-run.',
  ],
  example: {
    request: { name: 'Nattlig fakturasynk' },
    response: {
      data: EXAMPLE_SERVICE_ACCOUNT,
      meta: { request_id: 'req_…', api_version: API_V1_VERSION },
    },
  },
  scope: 'service_accounts:manage',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { body: CreateServiceAccountBody },
  response: {
    success: dataEnvelope(ServiceAccountSchema),
    errorCodes: [
      ...SERVICE_ACCOUNT_GATE_ERROR_CODES,
      'VALIDATION_ERROR',
      'SERVICE_ACCOUNT_SPONSOR_INVALID',
      'SERVICE_ACCOUNT_NAME_TAKEN',
      'SERVICE_ACCOUNT_LIMIT',
      'IDEMPOTENCY_KEY_REUSE',
    ],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'service-accounts.create',
  async (request, ctx) => {
    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const parsed = CreateServiceAccountBody.safeParse(raw.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const refused = await serviceAccountGate(ctx)
    if (refused) return refused

    const result = await createServiceAccount(ctx.supabase, ctx.companyId!, serviceAccountCaller(ctx), {
      name: parsed.data.name.trim(),
      ...(parsed.data.sponsor_user_id ? { sponsorUserId: parsed.data.sponsor_user_id } : {}),
    })
    if (!result.ok) return serviceAccountFailureResponse(ctx, result)
    ctx.log.info('service account created', { serviceAccountId: result.value.id })
    return created(result.value, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
