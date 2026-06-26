/**
 * Single source of truth for the v1 REST surface.
 *
 * Every endpoint registers its Zod request/response schemas + agent-facing
 * metadata (description, use-when, do-not-use-for, pitfalls, example) +
 * OpenAPI `x-*` extensions (`x-action-risk`, `x-idempotent`, `x-reversible`,
 * `x-dry-run-supported`).
 *
 * Three artefacts are derived from this registry:
 *   1. The OpenAPI 3.1 spec at /api/v1/openapi.json (this file).
 *   2. The MCP tool list (future — Phase 5).
 *   3. Runtime validators (Zod itself, used by handlers).
 *
 * Phase 1 ships a minimal Zod→JSON-Schema converter. Phase 2 will swap in
 * `@asteasolutions/zod-to-openapi` once the schema surface justifies the
 * dependency. The registry shape stays stable across that change.
 */

import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import type { ApiKeyScope } from '@/lib/auth/api-keys'
import { API_V1_VERSION } from './version'

/**
 * The `meta` block echoed in every v1 response envelope (see
 * `lib/api/v1/response.ts`). List endpoints additionally populate
 * `next_cursor`; it is absent on the final page.
 */
export const ResponseMetaSchema = z.object({
  request_id: z.string(),
  api_version: z.string(),
  next_cursor: z.string().nullable().optional(),
})

/**
 * The `{ data, meta }` envelope that every list endpoint actually returns via
 * `paginated()`. Declare a list endpoint's `response.success` with this so the
 * OpenAPI contract matches the runtime body.
 *
 * Previously each list endpoint declared a bare `{ <name>: [...] }` success
 * object (e.g. `{ companies: [...] }`) that no handler ever emits — the
 * generated spec advertised a shape the API never returns. See issue #781.
 */
export function listEnvelope<T extends ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: ResponseMetaSchema,
  })
}

/**
 * The `{ data, meta }` envelope for an endpoint that returns a single OBJECT
 * under `data` (via `ok()`), rather than a bare array under `data`.
 *
 * Most list endpoints return `{ data: [...] }` (use {@link listEnvelope}). A
 * few — `accounts`, `fiscal-periods`, `webhooks` — deliberately wrap their
 * array in a named key (`{ data: { accounts: [...] } }`); their handlers and
 * route tests lock that shape in. Declare those with
 * `dataEnvelope(z.object({ <name>: z.array(Item) }))` so the OpenAPI contract
 * matches what they actually return.
 */
export function dataEnvelope<T extends ZodTypeAny>(data: T) {
  return z.object({
    data,
    meta: ResponseMetaSchema,
  })
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type ActionRisk = 'low' | 'medium' | 'high'

export interface EndpointDefinition {
  /** HTTP method + path pattern, e.g. 'GET /api/v1/companies'. */
  operation: string
  method: HttpMethod
  path: string

  /** One-sentence summary; first sentence of the OpenAPI description. */
  summary: string

  /** Longer prose for the docs and the registered MCP tool description. */
  description: string

  /** Positive trigger — when should an agent reach for this endpoint? */
  useWhen: string

  /** Negative trigger — what looks similar but isn't this. */
  doNotUseFor: string

  /** Common pitfalls. Bullet-list style; agents see this in tool docs. */
  pitfalls: string[]

  /** One worked example (used by the contract-test suite). */
  example: {
    request?: Record<string, unknown>
    response: Record<string, unknown>
  }

  /** Required scope; null for public endpoints. */
  scope: ApiKeyScope | null

  /** Action risk — informs whether the agent should confirm before calling. */
  risk: ActionRisk

  /** True for GET requests and well-known idempotent writes. */
  idempotent: boolean

  /** True for writes that can be undone by a single subsequent call (e.g. credit invoice). */
  reversible: boolean

  /** True for write endpoints that accept ?dry_run=true. */
  dryRunSupported: boolean

  /** Optional Zod schemas. */
  request?: {
    /** Path params (companyId, id, ...). */
    params?: ZodTypeAny
    /** Query params. */
    query?: ZodTypeAny
    /** Request body. */
    body?: ZodTypeAny
    /**
     * Body content-type. Defaults to 'application/json' when omitted.
     * Set to 'multipart/form-data' for upload endpoints (Phase 4 PR-3:
     * documents). The OpenAPI generator emits the appropriate schema
     * (`{ type: 'string', format: 'binary' }` for the file part) so
     * code generators produce correct multipart clients.
     */
    contentType?: 'application/json' | 'multipart/form-data'
  }
  response: {
    /** Successful response body. */
    success: ZodTypeAny
    /** Stable error codes this endpoint can emit (cross-referenced with the docs). */
    errorCodes?: string[]
    /**
     * Override the default 'application/json' content type for non-JSON
     * responses (e.g. binary downloads). When set to 'application/pdf', the
     * OpenAPI generator emits a `{ type: 'string', format: 'binary' }` schema
     * instead of deriving from `success`. The `success` schema is still
     * required (use `z.unknown()` as a marker) so existing registry consumers
     * don't need to handle a missing field.
     */
    contentType?: string
  }
}

const ENDPOINTS = new Map<string, EndpointDefinition>()

/**
 * Register an endpoint. Called from the route file at module load time:
 *
 *   registerEndpoint({
 *     operation: 'companies.list',
 *     method: 'GET',
 *     path: '/api/v1/companies',
 *     ...
 *   })
 *
 * The wrapper does not depend on registration — scope resolution lives in
 * `lib/auth/scopes.ts` so a missing register() call only affects docs, not
 * runtime auth. CI test asserts every wrapped route appears in the registry.
 */
export function registerEndpoint(def: EndpointDefinition): void {
  const key = `${def.method} ${def.path}`
  if (ENDPOINTS.has(key)) {
    // Duplicate registration is a bug — log loudly. Throwing during a route
    // module's top-level eval would break unrelated routes; warn instead.
    // eslint-disable-next-line no-console
    console.warn(`[api/v1/registry] duplicate endpoint registration: ${key}`)
  }
  ENDPOINTS.set(key, def)
}

export function listEndpoints(): EndpointDefinition[] {
  return Array.from(ENDPOINTS.values())
}

export function getEndpoint(method: HttpMethod, path: string): EndpointDefinition | undefined {
  return ENDPOINTS.get(`${method} ${path}`)
}

/**
 * Resolve the registered endpoint for a CONCRETE request path (e.g.
 * `/api/v1/companies/abc/customers`) by matching it against the registered
 * `:param` patterns. Used by the wrapper to read an endpoint's `dryRunSupported`
 * flag at request time — the route module being served has already run its
 * `registerEndpoint()` call, so its pattern is present. Returns undefined when
 * no pattern matches (the wrapper treats that as "cannot be simulated").
 */
export function getEndpointByConcretePath(
  method: string,
  concretePath: string,
): EndpointDefinition | undefined {
  for (const def of ENDPOINTS.values()) {
    if (def.method !== method) continue
    const regex = new RegExp('^' + def.path.replace(/:[^/]+/g, '[^/]+') + '$')
    if (regex.test(concretePath)) return def
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────────
// Minimal Zod → JSON Schema converter
// ──────────────────────────────────────────────────────────────────
// Phase 1 only registers a handful of endpoints with simple schemas. We
// implement just enough to cover them: object, string, number, boolean,
// uuid, array, optional, enum, literal, date-string. When the registry
// surface grows past Phase 2, swap this for @asteasolutions/zod-to-openapi.

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  format?: string
  description?: string
  additionalProperties?: boolean | JsonSchema
}

function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def: { typeName?: string; type?: string } })._def

  // Zod 4 uses string discriminators on _def.type ('string', 'object', etc.).
  // Fall back to the legacy typeName for cross-version safety.
  const discriminator = def.type ?? def.typeName ?? ''

  switch (discriminator) {
    case 'string':
    case 'ZodString':
      return { type: 'string' }
    case 'number':
    case 'ZodNumber':
      return { type: 'number' }
    case 'boolean':
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'array':
    case 'ZodArray': {
      const inner = (def as { element?: ZodTypeAny; type?: ZodTypeAny }).element
        ?? (def as { type?: ZodTypeAny }).type
      return { type: 'array', items: inner ? zodToJsonSchema(inner) : {} }
    }
    case 'optional':
    case 'ZodOptional':
    case 'nullable':
    case 'ZodNullable': {
      const inner = (def as { innerType: ZodTypeAny }).innerType
      return zodToJsonSchema(inner)
    }
    case 'object':
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
        const valueDef = (value as unknown as { _def: { typeName?: string; type?: string } })._def
        const valueDisc = valueDef.type ?? valueDef.typeName ?? ''
        if (valueDisc !== 'optional' && valueDisc !== 'ZodOptional') {
          required.push(key)
        }
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      }
    }
    case 'enum':
    case 'ZodEnum': {
      const enumDef = def as { values?: unknown[]; entries?: Record<string, unknown> }
      const values =
        enumDef.values ??
        (enumDef.entries ? Object.values(enumDef.entries) : [])
      return { type: 'string', enum: values }
    }
    case 'literal':
    case 'ZodLiteral': {
      const value = (def as { value?: unknown; values?: unknown[] }).value
        ?? (def as { values?: unknown[] }).values?.[0]
      return { const: value }
    }
    case 'union':
    case 'ZodUnion': {
      // Best-effort: emit a oneOf with each member converted. No top-level
      // `type` constraint — the individual branches carry their own types
      // (valid JSON Schema for a union).
      const options = (def as { options?: ZodTypeAny[] }).options ?? []
      return { oneOf: options.map(zodToJsonSchema) } as unknown as JsonSchema
    }
    default:
      // Unknown construct → empty schema, accept anything.
      return {}
  }
}

// ──────────────────────────────────────────────────────────────────
// OpenAPI 3.1 spec generation
// ──────────────────────────────────────────────────────────────────

interface OpenApiSpec {
  openapi: '3.1.0'
  info: { title: string; version: string; description: string }
  servers: Array<{ url: string }>
  components: { securitySchemes: Record<string, unknown> }
  security: Array<Record<string, unknown[]>>
  paths: Record<string, Record<string, unknown>>
}

const SCHEME_NAME = 'ApiKey'

export function generateOpenApiSpec(serverUrl: string): OpenApiSpec {
  const paths: OpenApiSpec['paths'] = {}

  for (const def of ENDPOINTS.values()) {
    // OpenAPI path syntax: {param} instead of :param.
    const openApiPath = def.path.replace(/:([^/]+)/g, '{$1}')

    // Binary responses (e.g. application/pdf) declare a `format: binary`
    // schema rather than deriving from the Zod success type.
    const successContent = def.response.contentType && def.response.contentType !== 'application/json'
      ? { [def.response.contentType]: { schema: { type: 'string', format: 'binary' } } }
      : { 'application/json': { schema: zodToJsonSchema(def.response.success) } }

    const operationDef: Record<string, unknown> = {
      operationId: def.operation,
      summary: def.summary,
      description: [
        def.description,
        '',
        `**Use when:** ${def.useWhen}`,
        `**Do not use for:** ${def.doNotUseFor}`,
        ...(def.pitfalls.length > 0 ? ['', '**Pitfalls:**', ...def.pitfalls.map((p) => `- ${p}`)] : []),
      ].join('\n'),
      'x-action-risk': def.risk,
      'x-idempotent': def.idempotent,
      'x-reversible': def.reversible,
      'x-dry-run-supported': def.dryRunSupported,
      ...(def.scope ? { 'x-required-scope': def.scope } : {}),
      responses: {
        '200': {
          description: 'Success',
          content: successContent,
        },
        '400': { description: 'Validation error', $ref: '#/components/responses/Error' },
        '401': { description: 'Unauthorized', $ref: '#/components/responses/Error' },
        '403': { description: 'Insufficient scope', $ref: '#/components/responses/Error' },
        '404': { description: 'Not found', $ref: '#/components/responses/Error' },
        '429': { description: 'Rate limited', $ref: '#/components/responses/Error' },
        '500': { description: 'Internal error', $ref: '#/components/responses/Error' },
      },
    }

    if (!paths[openApiPath]) paths[openApiPath] = {}
    paths[openApiPath][def.method.toLowerCase()] = operationDef
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Accounted API',
      version: API_V1_VERSION,
      description:
        'Public REST API for Accounted — Swedish double-entry bookkeeping. ' +
        'Every write supports dry-run via `?dry_run=true`. Every request must include ' +
        '`Authorization: Bearer gnubok_sk_...`. See /docs/api for the cookbook.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        [SCHEME_NAME]: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'gnubok_sk_<live|test>_<random>',
        },
      },
    },
    security: [{ [SCHEME_NAME]: [] }],
    paths,
  }
}

/**
 * Test-only escape hatch. Clears the registry — used in unit tests so a test
 * that registers a fake endpoint doesn't leak into the next test.
 */
export function _resetRegistryForTests(): void {
  ENDPOINTS.clear()
}
