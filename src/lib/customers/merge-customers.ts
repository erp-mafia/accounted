/**
 * Customer merge (crm#1398, crm#1299): fold duplicate customer cards into the
 * card that stays. The one write path behind the dashboard's POST
 * /api/customers/merge, the v1 POST /customers/merge and the approval of an
 * agent's staged gnubok_merge_customers.
 *
 * The work is merge_customers (20261023003000): every invoice (quotes and
 * proformas included), sales order, recurring schedule, deadline and import
 * source mapping of a duplicate moves to the survivor in one transaction, the
 * duplicate is archived (kept: the issued invoices named it), and the merge is
 * recorded in customer_merges for undo and the behandlingshistorik. Posted
 * verifikationer are not touched: they name the invoice, never the customer.
 *
 * The RPC refuses two cards with different org or VAT numbers. A personnummer
 * is encrypted with the application's key, so that comparison is made here.
 */
import { z } from 'zod'
import { orgNumberKey } from '@/lib/invariants/org-number'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { syncDraftVatHeadersForCustomer } from '@/lib/invoices/sync-draft-vat-headers'
import { revealStoredCustomerPersonalNumber } from './protect-personal-number'

export const MergeCustomersSchema = z.object({
  survivor_customer_id: z
    .string()
    .uuid()
    .describe('The customer card that stays (gnubok_list_customers). Nothing on it changes.'),
  merged_customer_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(50)
    .describe('The duplicate cards. Their invoices, orders, recurring invoices and deadlines move to the survivor, then they are archived.'),
})

export type MergeCustomersInput = z.output<typeof MergeCustomersSchema>

const count = z.number().int()

const MergedCustomerSchema = z.object({
  customer_id: z.string(),
  name: z.string(),
  customer_number: z.string().nullable(),
  /** The customer_merges row; null on a dry run. */
  merge_id: z.string().nullable(),
  was_archived: z.boolean(),
  invoices: count,
  sales_orders: count,
  recurring_invoice_schedules: count,
  deadlines: count,
  source_records: count,
})

export const CustomerMergeResultSchema = z.object({
  survivor: z.object({ customer_id: z.string(), name: z.string(), customer_number: z.string().nullable() }),
  merged: z.array(MergedCustomerSchema),
  totals: z.object({ invoices: count, sales_orders: count, recurring_invoice_schedules: count, deadlines: count }),
})

export type CustomerMergeResult = z.output<typeof CustomerMergeResultSchema>

export const CustomerMergeUndoResultSchema = z.object({
  merge_id: z.string(),
  survivor_customer_id: z.string(),
  restored_customer_id: z.string(),
  restored: z.object({
    invoices: count,
    sales_orders: count,
    recurring_invoice_schedules: count,
    deadlines: count,
    source_records: count,
  }),
})

export type CustomerMergeUndoResult = z.output<typeof CustomerMergeUndoResultSchema>

type RpcAnswer = ({ ok: true } & Record<string, unknown>) | { ok: false; code: string; details?: Record<string, unknown> }

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

/** undo_customer_merge's window. */
const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** The personnummer's 10 digits, or null when there is none or it cannot be read. */
function personalNumberKey(stored: string | null): string | null {
  if (!stored) return null
  try {
    return orgNumberKey(revealStoredCustomerPersonalNumber(stored))
  } catch {
    // An undecryptable value says nothing either way; the card can still be
    // merged, and its personnummer typed in again on the survivor.
    return null
  }
}

/**
 * The first merged card whose personnummer differs from the survivor's: two
 * people. Read on the caller's client, scoped to the company like the RPC.
 */
async function personalNumberConflict(
  ctx: OperationContext,
  survivorId: string,
  mergedIds: string[],
): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('customers')
    .select('id, personal_number')
    .eq('company_id', ctx.companyId)
    .in('id', [survivorId, ...mergedIds])
  if (error) throw new Error(`customer merge: reading personal numbers failed: ${error.message}`)
  const rows = (data ?? []) as { id: string; personal_number: string | null }[]
  const survivorKey = personalNumberKey(rows.find((row) => row.id === survivorId)?.personal_number ?? null)
  if (!survivorKey) return null
  for (const id of mergedIds) {
    const key = personalNumberKey(rows.find((row) => row.id === id)?.personal_number ?? null)
    if (key && key !== survivorKey) return id
  }
  return null
}

/** A jsonb function's answer: PostgREST hands the value as is, a list-shaped stand-in its first row. */
function rpcAnswer(data: unknown): RpcAnswer {
  const value = Array.isArray(data) ? data[0] : data
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('customer merge: unexpected answer from the database')
  }
  return value as RpcAnswer
}

function refusal(answer: { code: string; details?: Record<string, unknown> }): Refusal {
  return { ok: false, code: answer.code, ...(answer.details ? { details: answer.details } : {}) }
}

export async function mergeCustomers(
  ctx: OperationContext,
  input: MergeCustomersInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<CustomerMergeResult>> {
  const mergedIds = [...new Set(input.merged_customer_ids)]
  if (mergedIds.includes(input.survivor_customer_id)) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'merged_customer_ids', reason: 'survivor_in_merged' } }
  }

  const conflict = await personalNumberConflict(ctx, input.survivor_customer_id, mergedIds)
  if (conflict) {
    return { ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { customer_id: conflict, field: 'personal_number' } }
  }

  // The dry run is customer_merge_preview, which only reads (an agent's
  // staging may write nothing but its pending operation); merge_customers
  // asks the same preview again on the locked cards before it moves rows.
  const fn = dryRun ? 'customer_merge_preview' : 'merge_customers'
  const { data, error } = await ctx.supabase.rpc(fn, {
    p_company_id: ctx.companyId,
    p_survivor_id: input.survivor_customer_id,
    p_merged_ids: mergedIds,
    p_user_id: ctx.userId,
  })
  if (error) throw new Error(`${fn} failed: ${error.message}`)
  const answer = rpcAnswer(data)
  if (!answer.ok) return refusal(answer)

  const result = CustomerMergeResultSchema.parse(answer)
  if (dryRun) return { ok: true, dryRun: true, preview: result }
  // The duplicates' open drafts now belong to the survivor, whose type,
  // country or VAT status may differ: their VAT header follows it.
  if (result.totals.invoices > 0) {
    await syncDraftVatHeadersForCustomer(ctx.supabase, ctx.companyId, result.survivor.customer_id)
  }
  ctx.log.info('customers merged', {
    survivorId: result.survivor.customer_id,
    merged: result.merged.length,
    invoices: result.totals.invoices,
  })
  return { ok: true, data: result }
}

export async function undoCustomerMerge(
  ctx: OperationContext,
  mergeId: string,
  { dryRun }: { dryRun: boolean } = { dryRun: false },
): Promise<OperationOutcome<CustomerMergeUndoResult>> {
  if (dryRun) {
    // What the undo would act on; the refusals that need the locks (a later
    // merge of the survivor) are the commit's.
    const { data, error } = await ctx.supabase
      .from('customer_merges')
      .select('id, survivor_id, merged_id, undone_at, created_at')
      .eq('company_id', ctx.companyId)
      .eq('id', mergeId)
      .maybeSingle()
    if (error) throw new Error(`customer merge undo: reading the merge failed: ${error.message}`)
    const row = data as { id: string; survivor_id: string; merged_id: string; undone_at: string | null; created_at: string } | null
    if (!row) return { ok: false, code: 'CUSTOMER_MERGE_NOT_FOUND', details: { merge_id: mergeId } }
    if (row.undone_at) return { ok: false, code: 'CUSTOMER_MERGE_ALREADY_UNDONE', details: { merge_id: mergeId } }
    if (Date.parse(row.created_at) < Date.now() - UNDO_WINDOW_MS) {
      return { ok: false, code: 'CUSTOMER_MERGE_UNDO_EXPIRED', details: { merge_id: mergeId } }
    }
    return {
      ok: true,
      dryRun: true,
      preview: { merge_id: row.id, survivor_customer_id: row.survivor_id, restored_customer_id: row.merged_id },
    }
  }
  const { data, error } = await ctx.supabase.rpc('undo_customer_merge', {
    p_company_id: ctx.companyId,
    p_merge_id: mergeId,
    p_user_id: ctx.userId,
  })
  if (error) throw new Error(`undo_customer_merge failed: ${error.message}`)
  const answer = rpcAnswer(data)
  if (!answer.ok) return refusal(answer)
  const result = CustomerMergeUndoResultSchema.parse(answer)
  // The drafts moved back to the restored card follow its VAT status again.
  if (result.restored.invoices > 0) {
    await syncDraftVatHeadersForCustomer(ctx.supabase, ctx.companyId, result.restored_customer_id)
  }
  return { ok: true, data: result }
}
