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
 *   2. The MCP tool list (future: Phase 5).
 *   3. Runtime validators (Zod itself, used by handlers).
 *
 * Phase 1 ships a minimal Zod→JSON-Schema converter. Phase 2 will swap in
 * `@asteasolutions/zod-to-openapi` once the schema surface justifies the
 * dependency. The registry shape stays stable across that change.
 */

import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import type { V1RequiredScope } from '@/lib/auth/scopes'
import { PendingOperationView } from '@/lib/pending-operations/view'
import { MODULES, type ModuleId } from '@/lib/modules/manifest'
import { getModule, moduleForV1Path } from '@/lib/modules/resolve'
import { handleDeclarationFor, STAGED_PENDING_OPERATION_HANDLES, withHandleSchema } from './handles'
import { API_V1_VERSION } from './version'

/**
 * The audit block surfaced inline on write responses (see `AuditBlock` in
 * `lib/api/v1/response.ts`) so an agent gets the voucher number / audit-trail
 * URL without a second round-trip. Every field is optional.
 */
const ResponseAuditSchema = z.object({
  voucher_number: z.string().optional(),
  voucher_url: z.string().optional(),
  audit_trail_url: z.string().optional(),
  immutable_at: z.string().optional(),
})

/**
 * A non-blocking warning attached to a successful write (see `ResponseWarning`
 * in `lib/api/v1/response.ts`). The write went through; the warning says what
 * deserves a look, in both languages, with an optional remediation.
 */
const ResponseWarningSchema = z.object({
  code: z.string(),
  message_sv: z.string(),
  message_en: z.string(),
  remediation: z
    .object({
      description: z.string(),
      tool: z.string().optional(),
      args: z.record(z.string(), z.unknown()).optional(),
      resource: z.string().optional(),
    })
    .optional(),
  // Set when the warning is about one payment order the bank holds (see
  // ResponseWarning). Published, so a strict client accepts the answer.
  payment_order_id: z.string().optional(),
  supplier_invoice_id: z.string().optional(),
})

/**
 * The `meta` block echoed in every v1 response envelope (see
 * `lib/api/v1/response.ts`). List endpoints additionally populate
 * `next_cursor`; it is absent on the final page. Writes may surface an
 * `audit` block and a `warnings` list, and soft-degraded `?expand=` responses
 * a `partial_expansions` list: all optional, so reads and lists omit them.
 */
export const ResponseMetaSchema = z.object({
  request_id: z.string(),
  api_version: z.string(),
  next_cursor: z.string().nullable().optional(),
  audit: ResponseAuditSchema.optional(),
  // Non-blocking warnings about a write that succeeded (e.g. invoices.create
  // EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED). Absent when there are none.
  warnings: z.array(ResponseWarningSchema).optional(),
  partial_expansions: z.array(z.string()).optional(),
  // Endpoint-specific register-coverage disclosure (e.g. invoices.list:
  // { covers_from, has_pre_register_invoices }). Documented per endpoint.
  coverage: z.record(z.string(), z.unknown()).optional(),
})

/**
 * The `{ data, meta }` envelope that every list endpoint actually returns via
 * `paginated()`. Declare a list endpoint's `response.success` with this so the
 * OpenAPI contract matches the runtime body.
 *
 * Previously each list endpoint declared a bare `{ <name>: [...] }` success
 * object (e.g. `{ companies: [...] }`) that no handler ever emits: the
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
 * few (`accounts`, `fiscal-periods`, `webhooks`) deliberately wrap their
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

/**
 * Sentinel `response.success` for endpoints that return 204 No Content with an
 * empty body: e.g. DELETE handlers calling `noContent()`. The OpenAPI
 * generator emits a bare `204` response (no schema) for these instead of a
 * `200 { data, meta }`, and the envelope contract test exempts them.
 *
 * Identified by REFERENCE equality, so every 204 route MUST import this exact
 * constant rather than declaring its own `z.object({})`: that is what lets the
 * generator and the contract test recognise the "no body" intent.
 */
export const NoBodyResponse = z.object({})

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type ActionRisk = 'low' | 'medium' | 'high'

export interface EndpointDefinition {
  /** HTTP method + path pattern, e.g. 'GET /api/v1/companies'. */
  operation: string
  method: HttpMethod
  path: string

  /**
   * The module (lib/modules/manifest.ts) the endpoint belongs to, published
   * as its OpenAPI tag and `x-module`. v1OperationHandler sets it from the
   * operation id; a hand-written route leaves it out and resolves from its
   * path (see endpointModule).
   */
  module?: ModuleId

  /** One-sentence summary; first sentence of the OpenAPI description. */
  summary: string

  /** Longer prose for the docs and the registered MCP tool description. */
  description: string

  /** Positive trigger: when should an agent reach for this endpoint? */
  useWhen: string

  /** Negative trigger: what looks similar but isn't this. */
  doNotUseFor: string

  /** Common pitfalls. Bullet-list style; agents see this in tool docs. */
  pitfalls: string[]

  /** One worked example (used by the contract-test suite). */
  example: {
    request?: Record<string, unknown>
    response: Record<string, unknown>
  }

  /**
   * Required scope, read by withApiV1 on every request; 'authenticated' for
   * an endpoint any valid key may call; null for a public endpoint.
   */
  scope: V1RequiredScope | null

  /** Action risk: informs whether the agent should confirm before calling. */
  risk: ActionRisk

  /** True for GET requests and well-known idempotent writes. */
  idempotent: boolean

  /** True for writes that can be undone by a single subsequent call (e.g. credit invoice). */
  reversible: boolean

  /** True for write endpoints that accept ?dry_run=true. */
  dryRunSupported: boolean

  /**
   * True for writes that accept ?stage=true: instead of committing, the
   * request creates a pending operation for approval (answered 202 with it)
   * through POST /pending-operations/{id}/approve or the app. Set by
   * v1OperationHandler for an operation write that stages over MCP
   * (`mcp.stage`); withApiV1 refuses stage=true everywhere else.
   */
  stageSupported?: boolean

  /**
   * True for writes whose dry run answers a `preview_token` and whose commit
   * accepts it back in the Preview-Token header, refusing with 409
   * PREVIEW_STALE when the preview no longer holds (lib/operations/
   * preview-token.ts). Set by v1OperationHandler for every operation write;
   * withApiV1 refuses the header everywhere else, so a token is never
   * silently ignored.
   */
  previewTokenSupported?: boolean

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
 * The definition is also the route's runtime contract: withApiV1 reads the
 * required scope from it (getEndpointForOperation), so a route that never
 * registers answers NOT_FOUND to every caller instead of running unscoped.
 */
export function registerEndpoint(def: EndpointDefinition): void {
  const key = `${def.method} ${def.path}`
  if (ENDPOINTS.has(key)) {
    // Duplicate registration is a bug: log loudly. Throwing during a route
    // module's top-level eval would break unrelated routes; warn instead.
    // eslint-disable-next-line no-console
    console.warn(`[api/v1/registry] duplicate endpoint registration: ${key}`)
  }
  ENDPOINTS.set(key, def)
}

/**
 * The endpoint a withApiV1 handler serves: its operation id and the request's
 * method. The route module registered it at load, before any request reached
 * the handler. Undefined for a handler whose route never registered.
 */
export function getEndpointForOperation(operation: string, method: string): EndpointDefinition | undefined {
  for (const def of ENDPOINTS.values()) {
    if (def.operation === operation && def.method === method) return def
  }
  return undefined
}

export function listEndpoints(): EndpointDefinition[] {
  return Array.from(ENDPOINTS.values())
}

/**
 * The module an endpoint belongs to: the one it declares (an operation-backed
 * endpoint carries its operation's module), else the one that claims its
 * path. Undefined only for a path no module claims, which the module
 * coverage test (lib/modules/__tests__) fails on.
 */
export function endpointModule(def: Pick<EndpointDefinition, 'module' | 'path'>): ModuleId | undefined {
  return def.module ?? moduleForV1Path(def.path)
}


/**
 * Resolve the registered endpoint for a CONCRETE request path (e.g.
 * `/api/v1/companies/abc/customers`) by matching it against the registered
 * `:param` patterns. Used by the wrapper to read an endpoint's `dryRunSupported`
 * flag at request time: the route module being served has already run its
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

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  format?: string
  pattern?: string
  description?: string
  additionalProperties?: boolean | JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
}

/**
 * Convert a registry Zod schema to the JSON Schema the spec, the generated
 * skill and the docs pages publish. Exported for the docs builder
 * (lib/docs/content/reference.ts), which renders the same shapes as tables.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const out = convertZod(schema)
  // `.describe()` text (Zod 4 keeps it in the global registry and reads it
  // back through `.description`) documents a field or query parameter.
  const description = (schema as unknown as { description?: string }).description
  return description && !out.description ? { ...out, description } : out
}

/**
 * OpenAPI 3.1 has no `nullable` keyword: null is a member of `type` (and of
 * `enum`, when there is one). Dropping it published every nullable field as
 * non-null, so strict generated clients rejected valid responses (#2515).
 */
function withNull(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.enum)) {
    const type = typeof schema.type === 'string' ? [schema.type, 'null'] : schema.type
    return { ...schema, ...(type ? { type } : {}), enum: [...schema.enum, null] }
  }
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] }
  if (Array.isArray(schema.type)) {
    return schema.type.includes('null') ? schema : { ...schema, type: [...schema.type, 'null'] }
  }
  // An empty schema already accepts null.
  if (Object.keys(schema).length === 0) return schema
  return { anyOf: [schema, { type: 'null' }] }
}

function convertZod(schema: ZodTypeAny): JsonSchema {
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
    case 'nullable':
    case 'ZodNullable': {
      const inner = (def as { innerType: ZodTypeAny }).innerType
      return withNull(zodToJsonSchema(inner))
    }
    case 'optional':
    case 'ZodOptional':
    // A `.default()` field accepts the inner type on input; the object case
    // below additionally treats it as not-required.
    case 'default':
    case 'ZodDefault': {
      const inner = (def as { innerType: ZodTypeAny }).innerType
      return zodToJsonSchema(inner)
    }
    case 'record':
    case 'ZodRecord': {
      const valueType = (def as { valueType?: ZodTypeAny }).valueType
      return {
        type: 'object',
        additionalProperties: valueType ? zodToJsonSchema(valueType) : true,
      }
    }
    // `.transform()` / `.pipe()` wrappers: describe the INPUT side, which is
    // what an API caller must send. `z.preprocess()` is the mirror image:
    // its input side IS the callable (a ZodTransform, no describable type),
    // and the schema the cleaned value must satisfy sits on the output side.
    case 'pipe':
    case 'ZodPipeline': {
      const pipeDef = def as { in?: ZodTypeAny; out?: ZodTypeAny }
      const inDef = (pipeDef.in as unknown as { _def?: { type?: string; typeName?: string } } | undefined)?._def
      const inDisc = inDef?.type ?? inDef?.typeName ?? ''
      const side = ['transform', 'ZodEffects'].includes(inDisc) ? pipeDef.out : pipeDef.in
      return side ? zodToJsonSchema(side) : {}
    }
    case 'effects':
    case 'ZodEffects': {
      const inner = (def as { schema?: ZodTypeAny }).schema
      return inner ? zodToJsonSchema(inner) : {}
    }
    case 'object':
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
        // A field may be omitted exactly when the schema accepts undefined:
        // covers optional and defaulted fields, and wrappers that only carry
        // optionality inside (e.g. a preprocess pipe over `.optional()`),
        // which a top-level discriminator check misclassifies as required.
        const mayOmit = value.safeParse(undefined).success
        if (!mayOmit) {
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
      // `type` constraint: the individual branches carry their own types
      // (valid JSON Schema for a union).
      const options = (def as { options?: ZodTypeAny[] }).options ?? []
      return { oneOf: options.map(zodToJsonSchema) } as unknown as JsonSchema
    }
    default:
      // Unknown construct → empty schema, accept anything.
      return {}
  }
}

/**
 * The JSON Schema of an endpoint's success body as clients receive it: the
 * registered Zod schema plus the `handle` property the response layer stamps
 * on the endpoints in V1_HANDLE_COVERAGE (./handles.ts). The spec and the
 * docs builder both read this, so neither can publish a body without it.
 */
export function responseJsonSchema(def: Pick<EndpointDefinition, 'operation' | 'response'>): JsonSchema {
  return withHandleSchema(zodToJsonSchema(def.response.success), handleDeclarationFor(def.operation))
}

// ──────────────────────────────────────────────────────────────────
// OpenAPI 3.1 spec generation
// ──────────────────────────────────────────────────────────────────

interface OpenApiTag {
  name: string
  description: string
  'x-display-name': string
  'x-experimental': true
}

interface OpenApiSpec {
  openapi: '3.1.0'
  info: { title: string; version: string; description: string }
  servers: Array<{ url: string }>
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }
  security: Array<Record<string, unknown[]>>
  tags: OpenApiTag[]
  paths: Record<string, Record<string, unknown>>
}

const SCHEME_NAME = 'ApiKey'
/** components.schemas entry for the 202 a staged write answers. */
const STAGED_SCHEMA_NAME = 'StagedPendingOperation'

export interface QueryParameter {
  name: string
  required: boolean
  description?: string
  schema: JsonSchema
}

/**
 * The endpoint's query parameters, from its registered `request.query`
 * schema. The spec used to derive parameters from the path pattern only, so
 * every list filter lived in prose and nowhere a client generator could see
 * it (#2515). Shared with the docs builder so the page and the spec agree.
 */
export function queryParameters(def: EndpointDefinition): QueryParameter[] {
  const params: QueryParameter[] = []
  if (def.request?.query) {
    const json = zodToJsonSchema(def.request.query)
    const required = new Set(json.required ?? [])
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      const { description, ...schema } = prop
      params.push({ name, required: required.has(name), ...(description ? { description } : {}), schema })
    }
  }
  // withApiV1 reads ?dry_run on every request (lib/api/v1/with-api-v1.ts);
  // only the endpoints that honour it advertise it.
  if (def.dryRunSupported && !params.some((p) => p.name === 'dry_run')) {
    params.push({
      name: 'dry_run',
      required: false,
      description: 'true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits.',
      schema: { type: 'string' },
    })
  }
  // withApiV1 reads ?stage on every request and refuses it where unsupported.
  if (def.stageSupported && !params.some((p) => p.name === 'stage')) {
    params.push({
      name: 'stage',
      required: false,
      description:
        'true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision.',
      schema: { type: 'string' },
    })
  }
  return params
}

export function generateOpenApiSpec(serverUrl: string): OpenApiSpec {
  const paths: OpenApiSpec['paths'] = {}
  const usedModules = new Set<ModuleId>()

  for (const def of ENDPOINTS.values()) {
    // The building block the endpoint belongs to (lib/modules/manifest.ts):
    // one tag per operation, so a client or an agent can take the API one
    // module at a time.
    const moduleId = endpointModule(def)
    const mod = moduleId ? getModule(moduleId) : undefined
    if (mod) usedModules.add(mod.id)

    // OpenAPI path syntax: {param} instead of :param.
    const openApiPath = def.path.replace(/:([^/]+)/g, '{$1}')

    // Binary responses (e.g. application/pdf) declare a `format: binary`
    // schema rather than deriving from the Zod success type.
    // The registry's worked `example` travels with the schema as an OpenAPI
    // media-type `example`. Without this the examples reached only the docs
    // markdown builder (lib/docs/content/reference.ts): the spec itself carried
    // none, so neither /api/v1/openapi.json consumers nor the generated
    // skills/accounted-api ever saw a concrete request or response body.
    // Attached to JSON media types only: a binary response (application/pdf)
    // has no meaningful JSON example to show.
    const successContent = def.response.contentType && def.response.contentType !== 'application/json'
      ? { [def.response.contentType]: { schema: { type: 'string', format: 'binary' } } }
      : {
          'application/json': {
            schema: responseJsonSchema(def),
            example: def.example.response,
          },
        }

    // 204 No Content endpoints (DELETEs returning noContent()) carry no body:
    // emit a bare 204 instead of a 200 { data, meta } so the spec stops
    // advertising a response shape these handlers never send.
    const successResponse = def.response.success === NoBodyResponse
      ? { '204': { description: 'No Content' } }
      : { '200': { description: 'Success', content: successContent } }
    // ?stage=true answers 202 with the pending operation instead (one shared
    // component, so 75 writes do not each inline the same schema).
    const stagedResponse = def.stageSupported
      ? {
          '202': {
            description: 'Staged for approval (stage=true): the pending operation, task_state working. Nothing was committed.',
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${STAGED_SCHEMA_NAME}` } } },
          },
        }
      : {}

    // Path parameters, derived from the `:param` pattern itself so every
    // templated segment is declared even though routes don't register a
    // params schema. All v1 path params are string ids.
    const parameters: Array<Record<string, unknown>> = [
      ...[...def.path.matchAll(/:([^/]+)/g)].map(([, name]) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...queryParameters(def).map(({ name, required, description, schema }) => ({
        name,
        in: 'query',
        required,
        ...(description ? { description } : {}),
        schema,
      })),
    ]

    // Request body from the registered Zod schema. In multipart bodies a
    // part registered as `z.unknown()` is by convention the binary file part
    // (see documents.upload); the converter turns it into an empty schema,
    // which is rewritten here to `format: binary` so client generators
    // produce correct multipart uploads.
    let requestBody: Record<string, unknown> | undefined
    if (def.request?.body) {
      const contentType = def.request.contentType ?? 'application/json'
      let bodySchema = zodToJsonSchema(def.request.body)
      if (contentType === 'multipart/form-data' && bodySchema.properties) {
        bodySchema = {
          ...bodySchema,
          properties: Object.fromEntries(
            Object.entries(bodySchema.properties).map(([key, prop]) => [
              key,
              Object.keys(prop).length === 0
                ? { type: 'string', format: 'binary' }
                : prop,
            ]),
          ),
        }
      }
      requestBody = {
        required: true,
        content: {
          [contentType]: {
            schema: bodySchema,
            // Only JSON bodies carry a worked example; a multipart upload's
            // example would be a file part, which JSON cannot express.
            ...(def.example.request && contentType === 'application/json'
              ? { example: def.example.request }
              : {}),
          },
        },
      }
    }

    const operationDef: Record<string, unknown> = {
      operationId: def.operation,
      ...(mod ? { tags: [mod.id] } : {}),
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
      ...(def.stageSupported ? { 'x-stage-supported': true } : {}),
      ...(def.previewTokenSupported ? { 'x-preview-token-supported': true } : {}),
      ...(mod ? { 'x-module': mod.id } : {}),
      // 'authenticated' is not a scope: such an endpoint carries the global
      // bearer requirement and no x-required-scope.
      ...(def.scope && def.scope !== 'authenticated' ? { 'x-required-scope': def.scope } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        ...successResponse,
        ...stagedResponse,
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
        'Public REST API for Accounted: Swedish double-entry bookkeeping. ' +
        'Every write supports dry-run via `?dry_run=true`. Every request must include ' +
        '`Authorization: Bearer gnubok_sk_...`. See /docs/api for the cookbook.',
    },
    servers: [{ url: serverUrl }],
    components: {
      schemas: {
        [STAGED_SCHEMA_NAME]: withHandleSchema(
          zodToJsonSchema(dataEnvelope(PendingOperationView)),
          STAGED_PENDING_OPERATION_HANDLES,
        ),
      },
      securitySchemes: {
        [SCHEME_NAME]: {
          type: 'http',
          scheme: 'bearer',
          // Live keys are gnubok_sk_<random>, test keys gnubok_sk_test_<random>
          // (generateApiKey in lib/auth/api-keys.ts): there is no live_ infix.
          bearerFormat: 'gnubok_sk_[test_]<random>',
        },
      },
    },
    security: [{ [SCHEME_NAME]: [] }],
    // One tag per module that has an endpoint, in manifest order (kernels first).
    // Experimental until the per-company module switch settles the module
    // boundaries: ids may still be split or renamed until then.
    tags: MODULES.filter((m) => usedModules.has(m.id)).map((m) => ({
      name: m.id,
      description: m.summary,
      'x-display-name': m.name,
      'x-experimental': true as const,
    })),
    paths,
  }
}

