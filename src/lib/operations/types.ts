/**
 * An operation is one thing a user can do to their books (create a
 * dimension, register a supplier invoice, lock a period), defined ONCE and
 * served through every machine door:
 *
 *   - v1 REST: `v1OperationHandler(op)` in lib/operations/v1.ts, which also
 *     registers the endpoint so it appears in /api/v1/openapi.json;
 *   - MCP: `createOperationTools()` in the MCP extension turns every
 *     operation with an `mcp` binding into a tool (reads run directly,
 *     writes stage a pending operation that a human approves);
 *   - the staged-operation commit path: `commitPendingOperation` runs the
 *     same `run()` for an approved pending operation of `mcp.stage.pendingType`.
 *
 * The dashboard's session routes call the same service functions the
 * operation wraps, so the UI and the API cannot drift apart.
 *
 * Why this exists: before it, each capability was written three or four
 * times (a dashboard route, a v1 route, an MCP tool with a hand-written JSON
 * schema, a commit executor), and the copies drifted: fields validated and
 * then dropped, guards present on one door only, a 1000-row cap fixed in one
 * copy of a list and not the other. The request contract, the rules and the
 * outcome now live in one place and the doors only translate envelopes.
 *
 * Authorization: every door establishes that the caller is a non-viewer
 * member of the company, and nothing more. v1 and MCP run on a service-role
 * client where RLS does not apply, so an operation whose writes the
 * dashboard reserves for owners and admins must call requireCompanyAdmin
 * (./access.ts) in its service, on a dry run too.
 *
 * Deliberately NOT here: anything the scope catalogue, the risk tiers and
 * the approval vocabulary hold. Those are client-imported data tables, so
 * they stay tables, and operation-contract.test.ts checks that every
 * operation is present in them with the same scope and risk.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { ApiKeyScope } from '@/lib/auth/api-keys'
import type { Logger } from '@/lib/logger'
import type { PendingOperationType } from '@/types'

export type OperationHttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
export type OperationRisk = 'low' | 'medium' | 'high'

/** Who is acting and for which company. Every door builds one. */
export interface OperationContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}

/** A non-blocking note about a write that went through, in both languages. */
export interface OperationWarning {
  code: string
  message_sv: string
  message_en: string
}

/**
 * What `run()` answers. A dry run answers `preview` and writes nothing. A
 * failure carries a code from lib/errors/structured-errors.ts; `messageSv`
 * overrides the registry sentence when the failure names something specific
 * (a DB guard's message that names the dimension), and `error` hands a
 * BookkeepingError to the door verbatim.
 */
export type OperationOutcome<O> =
  | { ok: true; dryRun: true; preview: Record<string, unknown> }
  | { ok: true; dryRun?: false; data: O; created?: boolean; warnings?: OperationWarning[] }
  | {
      ok: false
      code: string
      details?: Record<string, unknown>
      messageSv?: string
      error?: unknown
    }

export interface OperationDocs {
  /** One sentence; the first line of the OpenAPI description. */
  summary: string
  /** Longer prose; also the MCP tool description when `mcp.description` is absent. */
  description: string
  /** When an agent should reach for this operation. */
  useWhen: string
  /** What looks similar but is not this. */
  doNotUseFor: string
  pitfalls: string[]
  example: { request?: Record<string, unknown>; response: Record<string, unknown> }
}

export interface OperationHttpBinding {
  method: OperationHttpMethod
  /** v1 path pattern, e.g. '/api/v1/companies/:companyId/dimensions/:id'. */
  path: string
  /**
   * Path segment → input field, e.g. `{ id: 'dimension_id' }`. The segment
   * value is merged into the input before validation, so the input schema
   * (and the MCP tool, which has no path) names the id explicitly.
   */
  pathParams?: Record<string, string>
  /** Writes require an Idempotency-Key header. Defaults to true for writes. */
  requireIdempotencyKey?: boolean
}

export interface OperationMcpBinding {
  /** Canonical tool name (gnubok_*); the accounted_* alias is derived. */
  name: string
  /** Title Case noun phrase for directory listings. */
  title: string
  /**
   * Tool description, at most 280 characters for staged writes. Defaults to
   * docs.description. Say "Stage" for writes: nothing reaches the books
   * until a human approves.
   */
  description?: string
  /**
   * 'search' (the default) keeps the tool out of tools/list: it is reachable
   * through gnubok_search_tools and the call_tool / stage_tool bridges at no
   * cost to the tools/list budget. 'default' lists it.
   */
  visibility?: 'default' | 'search'
  /** Lowercase matcher synonyms (Swedish domain terms). Never serialized. */
  keywords?: string[]
  /**
   * Present on writes: the tool stages a pending operation of this type and
   * the approval path runs `run()` with the staged input. The type must be in
   * PendingOperationType, OPERATION_RISK_TIERS, the approval vocabulary and
   * the pending_operations CHECK (operation-contract.test.ts and the pg
   * audit check all four).
   */
  stage?: {
    pendingType: PendingOperationType
    /** The one-line title the approver sees, in Swedish. */
    title: (input: Record<string, unknown>) => string
    /**
     * For a pending type that existed before its operation did: rewrites
     * params staged in the old shape into the operation's input, so a row
     * staged before the switch still commits. Runs before validation.
     */
    upgradeParams?: (params: Record<string, unknown>) => Record<string, unknown>
  }
}

export interface Operation<I = Record<string, unknown>, O = unknown> {
  /** Stable dotted id: '<resource>.<verb>', e.g. 'dimensions.create'. */
  id: string
  kind: 'read' | 'write'
  scope: ApiKeyScope
  risk: OperationRisk
  /** True when a single later call can undo it (e.g. delete a created row). */
  reversible: boolean
  docs: OperationDocs
  /** The request contract, shared by every door. Must be a z.object. */
  input: z.ZodType<I>
  /** The success payload (the `data` of the v1 envelope). */
  output: z.ZodType<O>
  /** Stable error codes the operation can answer (documentation). */
  errorCodes?: string[]
  http?: OperationHttpBinding
  mcp?: OperationMcpBinding
  run: (ctx: OperationContext, input: I, options: { dryRun: boolean }) => Promise<OperationOutcome<O>>
}

/**
 * Identity function that keeps the input/output types inferred from the
 * Zod schemas at the definition site.
 */
export function defineOperation<I, O>(op: Operation<I, O>): Operation<I, O> {
  return op
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any, any>
