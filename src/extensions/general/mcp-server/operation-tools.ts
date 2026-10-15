/**
 * MCP door for operations (see src/lib/operations/types.ts): every operation
 * with an `mcp` binding becomes a tool, with its inputSchema generated from
 * the operation's Zod input, so the tool and the v1 endpoint accept exactly
 * the same request (once a stringified top-level scalar is read back as the
 * number or null it stands for: coerceStringifiedScalars).
 *
 * Reads run directly. Writes stage: the tool validates the input, asks the
 * operation for a dry-run preview (which runs every check the commit will
 * run), and stages a pending operation of `mcp.stage.pendingType` with the
 * input as params. Approval (gnubok_approve_pending_operation) reaches
 * commitPendingOperation, which runs the same operation for real
 * (commitRegisteredOperation in lib/pending-operations/commit.ts).
 *
 * Generated tools are search-only unless the binding says otherwise, so a
 * new operation costs nothing in the tools/list budget and is reachable
 * through gnubok_search_tools, gnubok_call_tool and gnubok_stage_tool.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fieldValidationError, zodFieldIssues } from '@/lib/errors/refusal'
import { throwOutcomeFailure } from '@/lib/operations/errors'
import { planStagedOperation } from '@/lib/operations/stage'
import type { AnyOperation } from '@/lib/operations/types'
import type { ApiKeyScope } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type { ActorContext, McpTool, McpToolAnnotations } from './server'
import type { NextActionHint } from './tool-result'

const log = createLogger('mcp-operation-tools')

/**
 * MCP-only input preparation for one operation, run on the raw arguments
 * before they are validated: what agents may send that the operation's own
 * contract does not take (a dimension value given by its name). It rewrites
 * the arguments into the operation's input and may name what it resolved,
 * which the staged preview then carries. It may read; it never writes.
 */
export type PrepareOperationInput = (
  args: Record<string, unknown>,
  context: { supabase: SupabaseClient; companyId: string },
) => Promise<{ args: Record<string, unknown>; preview?: Record<string, unknown> }>

interface Deps {
  /** By operation id: see PrepareOperationInput. */
  prepareInput?: Record<string, PrepareOperationInput>
  readOnly: McpToolAnnotations
  stagedWrite: McpToolAnnotations
  stagedSchema: Record<string, unknown>
  stagingArgs: Record<string, unknown>
  stagePendingOperation: (
    supabase: SupabaseClient,
    companyId: string,
    userId: string,
    operationType: string,
    title: string,
    params: Record<string, unknown>,
    previewData: Record<string, unknown>,
    actor?: ActorContext,
    next?: NextActionHint,
    options?: { dryRun?: boolean; idempotencyKey?: string; dateForPeriodCheck?: string; complianceNote?: string },
  ) => Promise<unknown>
}

type JsonSchema = Record<string, unknown>

/**
 * Zod's JSON Schema, trimmed for a tool definition: no $schema header, no
 * regex spelled out next to a `format` that already says it (uuid), no
 * MAX_SAFE_INTEGER bounds, a nullable scalar as one node, no `type: string`
 * on propertyNames (a key is always a string), and closed objects so an
 * agent's stray key is refused rather than ignored.
 */
export function toolInputSchema(input: z.ZodTypeAny): JsonSchema {
  const raw = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  delete raw.$schema
  return compact(raw) as JsonSchema
}

const COMPOSITE_KEYWORDS = ['enum', 'const', 'anyOf', 'oneOf', 'allOf'] as const

/**
 * `.nullable()` on a plain scalar comes out as anyOf [X, {type: 'null'}];
 * the same schema is X with type [X.type, 'null'], a node shorter in every
 * tools/list. Left alone when X lists values (an enum's values would then
 * refuse the null) or composes further.
 */
function foldNullable(obj: Record<string, unknown>): Record<string, unknown> {
  const options = obj.anyOf
  if (!Array.isArray(options) || options.length !== 2) return obj
  const isNull = (o: unknown) =>
    typeof o === 'object' && o !== null && (o as Record<string, unknown>).type === 'null' && Object.keys(o).length === 1
  const other = (isNull(options[0]) ? options[1] : isNull(options[1]) ? options[0] : null) as Record<string, unknown> | null
  if (!other || typeof other.type !== 'string' || COMPOSITE_KEYWORDS.some((k) => k in other)) return obj
  const { anyOf: _anyOf, ...rest } = obj
  return { ...other, ...rest, type: [other.type, 'null'] }
}

const jsonType = (value: unknown) => (value === null ? 'null' : typeof value)

/**
 * A multi-value literal (`z.literal([0, 0.06, null])`) comes out as a bare
 * `enum` with no `type`, and MCP clients send a parameter whose type they
 * cannot read as a string: default_vat_rate 0 arrived as "0" and was refused
 * (agent feedback seq 1088767). An enum listing a number or boolean therefore
 * names its types. An enum of strings (plus null) stays bare: its values
 * already arrive as the strings they are, and every byte of it ships in
 * tools/list (coerceStringifiedScalars takes a stringified null back).
 */
function typeEnum(obj: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(obj.enum) || obj.type !== undefined) return obj
  const types = [...new Set(obj.enum.map(jsonType))]
  if (!types.every((t) => ['number', 'boolean', 'string', 'null'].includes(t))) return obj
  if (types.every((t) => t === 'string' || t === 'null')) return obj
  return { type: types.length === 1 ? types[0] : types, ...obj }
}

function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact)
  if (typeof node !== 'object' || node === null) return node
  const obj = typeEnum(foldNullable({ ...(node as Record<string, unknown>) }))
  if (typeof obj.format === 'string' && typeof obj.pattern === 'string') delete obj.pattern
  if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum
  if (obj.minimum === Number.MIN_SAFE_INTEGER) delete obj.minimum
  const names = obj.propertyNames as Record<string, unknown> | undefined
  if (names && typeof names === 'object' && names.type === 'string') {
    const { type: _string, ...rest } = names
    obj.propertyNames = rest
  }
  if (obj.type === 'object' && obj.properties && obj.additionalProperties === undefined) {
    obj.additionalProperties = false
  }
  for (const [k, v] of Object.entries(obj)) obj[k] = compact(v)
  return obj
}

/**
 * The operation's output as a read tool's outputSchema. Left open at every
 * level: clients cache tools/list and validate responses against it, so a
 * closed object would make every connected session refuse a response the
 * moment the resource gains a field (output-schema.test.ts).
 */
export function toolOutputSchema(output: z.ZodTypeAny): JsonSchema {
  const raw = z.toJSONSchema(output, { io: 'output', unrepresentable: 'any' }) as JsonSchema
  delete raw.$schema
  return open(raw) as JsonSchema
}

function open(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(open)
  if (typeof node !== 'object' || node === null) return node
  const obj = { ...(node as Record<string, unknown>) }
  if (obj.additionalProperties === false) delete obj.additionalProperties
  for (const [k, v] of Object.entries(obj)) obj[k] = open(v)
  return obj
}

export function createOperationTools(operations: readonly AnyOperation[], deps: Deps): McpTool[] {
  const tools: McpTool[] = []
  for (const op of operations) {
    const binding = op.mcp
    if (!binding) continue
    const inputSchema = toolInputSchema(op.input as unknown as z.ZodTypeAny)
    const description = binding.description ?? op.docs.summary

    if (op.kind === 'read') {
      tools.push({
        name: binding.name,
        title: binding.title,
        description,
        inputSchema,
        outputSchema: toolOutputSchema(op.output as unknown as z.ZodTypeAny),
        annotations: deps.readOnly,
        catalogVisibility: binding.visibility ?? 'search',
        keywords: binding.keywords,
        async execute(args, companyId, userId, supabase) {
          const input = parseOrThrow(op, inputSchema, args)
          const outcome = await op.run(
            { supabase, companyId, userId, log: log.child({ operation: op.id }) },
            input,
            { dryRun: false },
          )
          if (!outcome.ok) throwOutcomeFailure(outcome)
          if (outcome.dryRun) return outcome.preview
          return outcome.data
        },
      })
      continue
    }

    const stage = binding.stage
    if (!stage) {
      throw new Error(`operation ${op.id} is a write without mcp.stage: MCP writes always stage`)
    }
    const properties = { ...((inputSchema.properties as JsonSchema) ?? {}), ...deps.stagingArgs }
    tools.push({
      name: binding.name,
      title: binding.title,
      description,
      inputSchema: { ...inputSchema, type: 'object', additionalProperties: false, properties },
      outputSchema: deps.stagedSchema,
      annotations: {
        ...deps.stagedWrite,
        ...(binding.hints?.destructive ? { destructiveHint: true } : {}),
        ...(binding.hints?.idempotent ? { idempotentHint: true } : {}),
      },
      catalogVisibility: binding.visibility ?? 'search',
      keywords: binding.keywords,
      async execute(args, companyId, userId, supabase, actor) {
        // __keyScopes: the calling key's grant, injected by the dispatcher
        // for the tools whose refusal names a follow-up call.
        const { dry_run, idempotency_key, __keyScopes, ...rest } = args
        const prepare = deps.prepareInput?.[op.id]
        const prepared = prepare ? await prepare(rest, { supabase, companyId }) : { args: rest }
        const input = parseOrThrow(op, inputSchema, prepared.args)
        // The preview runs every check the commit will run, so a staged
        // operation that could never commit is refused here, not at approval.
        const preview = await op.run(
          { supabase, companyId, userId, log: log.child({ operation: op.id }) },
          input,
          { dryRun: true },
        )
        if (!preview.ok) {
          const refusal = preview.error
            ? undefined
            : stage.refusal?.(
                { code: preview.code, details: preview.details },
                input as Record<string, unknown>,
                Array.isArray(__keyScopes) ? (__keyScopes as ApiKeyScope[]) : undefined,
              )
          if (refusal) throw refusal
          throwOutcomeFailure(preview)
        }
        // The same plan the v1 stage mode stages (lib/operations/stage.ts):
        // pinned params (e.g. the payee each payment goes to) make the commit
        // refuse when what the approver saw no longer holds.
        const plan = planStagedOperation(
          stage,
          input as Record<string, unknown>,
          preview.dryRun ? preview.preview : {},
        )
        const extras = plan.extras
        return deps.stagePendingOperation(
          supabase,
          companyId,
          userId,
          plan.pendingType,
          plan.title,
          plan.params,
          { ...plan.preview, ...(prepared.preview ?? {}) },
          actor,
          extras.next,
          {
            dryRun: Boolean(dry_run),
            idempotencyKey: typeof idempotency_key === 'string' ? idempotency_key : undefined,
            ...(extras.periodDate ? { dateForPeriodCheck: extras.periodDate } : {}),
            ...(extras.complianceNote ? { complianceNote: extras.complianceNote } : {}),
          },
        )
      },
    })
  }
  return tools
}

/**
 * The operation's input, or VALIDATION_ERROR naming every field at fault (the
 * code v1 answers for the same body). A plain Error here reached the agent as
 * UNKNOWN_ERROR, "Något gick fel. Försök igen.", from every generated tool.
 */
function parseOrThrow(op: AnyOperation, inputSchema: JsonSchema, rawArgs: Record<string, unknown>): unknown {
  const args = coerceStringifiedScalars(inputSchema, rawArgs)
  const parsed = (op.input as unknown as z.ZodTypeAny).safeParse(args)
  if (parsed.success) return parsed.data
  throw fieldValidationError('Invalid arguments', zodFieldIssues(parsed.error, args))
}

const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/

/**
 * Top-level arguments a client sent as strings although the schema takes no
 * string there: "0" where a number is expected, "null" where null is allowed
 * but the string "null" is not. Clients that serialize scalar parameters
 * without reading their JSON type do this (agent feedback seq 1088767), and
 * a client keeps the tools/list it cached before the schema named its types.
 * Only those two unambiguous cases are converted; anything else passes
 * through unchanged for the operation's own validation to refuse. Nested
 * values travel inside JSON and keep their types.
 */
export function coerceStringifiedScalars(
  inputSchema: JsonSchema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = inputSchema.properties as Record<string, JsonSchema> | undefined
  if (!properties) return args
  let out: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue
    const property = properties[key]
    if (!property) continue
    const values = Array.isArray(property.enum) ? (property.enum as unknown[]) : null
    const types = Array.isArray(property.type) ? (property.type as unknown[]) : [property.type]
    const admits = (type: string) =>
      values
        ? values.some((v) => jsonType(v) === type)
        : types.includes(type) || (type === 'number' && types.includes('integer'))
    let coerced: unknown = value
    if (admits('number') && !admits('string') && NUMERIC_LITERAL.test(value)) {
      coerced = Number(value)
    } else if (value === 'null' && admits('null') && !(values ? values.includes('null') : admits('string'))) {
      coerced = null
    }
    if (coerced === value) continue
    out ??= { ...args }
    out[key] = coerced
  }
  return out ?? args
}
