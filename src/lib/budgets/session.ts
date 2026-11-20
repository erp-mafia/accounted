/**
 * The dashboard's budget routes (app/api/budgets/**) are thin doors over the
 * same service as the v1 and MCP operations (service.ts): these helpers keep
 * the doors to the service's own contracts (schemas.ts), with the budget id
 * taken from the path.
 */
import { z } from 'zod'
import type { OperationContext } from '@/lib/operations/types'

/** The operation schema with `budget_id` filled in from the route path. */
export function withBudgetId<T>(budgetId: string, schema: z.ZodType<T>): z.ZodType<T> {
  return z.preprocess(
    (body) => (body && typeof body === 'object' && !Array.isArray(body) ? { ...body, budget_id: budgetId } : body),
    schema,
  ) as unknown as z.ZodType<T>
}

/** ?dry_run=true: answer the preview and write nothing. */
export function isDryRun(request: Request): boolean {
  return new URL(request.url).searchParams.get('dry_run') === 'true'
}

/** The service's context from a withRouteContext handler's. */
export function sessionContext(ctx: {
  supabase: OperationContext['supabase']
  companyId: string
  user: { id: string }
  log: OperationContext['log']
}): OperationContext {
  return { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log }
}
