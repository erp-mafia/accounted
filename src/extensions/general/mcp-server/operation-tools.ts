/**
 * MCP door for operations (see src/lib/operations/types.ts): every operation
 * with an `mcp` binding becomes a tool, with its inputSchema generated from
 * the operation's Zod input, so the tool and the v1 endpoint accept exactly
 * the same request.
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
import { throwOutcomeFailure } from '@/lib/operations/errors'
import type { AnyOperation } from '@/lib/operations/types'
import { createLogger } from '@/lib/logger'
import type { ActorContext, McpTool, McpToolAnnotations } from './server'

const log = createLogger('mcp-operation-tools')

interface Deps {
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
    next?: undefined,
    options?: { dryRun?: boolean; idempotencyKey?: string },
  ) => Promise<unknown>
}

type JsonSchema = Record<string, unknown>

/**
 * Zod's JSON Schema, trimmed for a tool definition: no $schema header, no
 * regex spelled out next to a `format` that already says it (uuid), no
 * MAX_SAFE_INTEGER bounds, and closed objects so an agent's stray key is
 * refused rather than ignored.
 */
export function toolInputSchema(input: z.ZodTypeAny): JsonSchema {
  const raw = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  delete raw.$schema
  return compact(raw) as JsonSchema
}

function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact)
  if (typeof node !== 'object' || node === null) return node
  const obj = { ...(node as Record<string, unknown>) }
  if (typeof obj.format === 'string' && typeof obj.pattern === 'string') delete obj.pattern
  if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum
  if (obj.minimum === Number.MIN_SAFE_INTEGER) delete obj.minimum
  if (obj.type === 'object' && obj.properties && obj.additionalProperties === undefined) {
    obj.additionalProperties = false
  }
  for (const [k, v] of Object.entries(obj)) obj[k] = compact(v)
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
        annotations: deps.readOnly,
        catalogVisibility: binding.visibility ?? 'search',
        keywords: binding.keywords,
        async execute(args, companyId, userId, supabase) {
          const input = parseOrThrow(op, args)
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
      annotations: deps.stagedWrite,
      catalogVisibility: binding.visibility ?? 'search',
      keywords: binding.keywords,
      async execute(args, companyId, userId, supabase, actor) {
        const { dry_run, idempotency_key, ...rest } = args
        const input = parseOrThrow(op, rest)
        // The preview runs every check the commit will run, so a staged
        // operation that could never commit is refused here, not at approval.
        const preview = await op.run(
          { supabase, companyId, userId, log: log.child({ operation: op.id }) },
          input,
          { dryRun: true },
        )
        if (!preview.ok) throwOutcomeFailure(preview)
        return deps.stagePendingOperation(
          supabase,
          companyId,
          userId,
          stage.pendingType,
          stage.title(input as Record<string, unknown>),
          input as Record<string, unknown>,
          preview.dryRun ? preview.preview : {},
          actor,
          undefined,
          {
            dryRun: Boolean(dry_run),
            idempotencyKey: typeof idempotency_key === 'string' ? idempotency_key : undefined,
          },
        )
      },
    })
  }
  return tools
}

function parseOrThrow(op: AnyOperation, args: Record<string, unknown>): unknown {
  const parsed = (op.input as unknown as z.ZodTypeAny).safeParse(args)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const path = issue?.path?.join('.') || 'args'
  throw new Error(`Invalid ${path}: ${issue?.message ?? 'validation failed'}`)
}
