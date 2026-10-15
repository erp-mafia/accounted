/**
 * A pending operation as the v1 REST API shows it: one shape for the list,
 * the detail, the approve and reject answers and a staged write's 202, so a
 * flow built outside Accounted reads every answer the same way.
 *
 * `params` (the raw staged input: invoice lines, supplier details, voucher
 * descriptions) is left out, as the MCP list leaves it out (GDPR Art.
 * 5(1)(c)): `preview` is the approver's summary, and the entity endpoints
 * read the full record.
 *
 * `task_state` is the status in the agent task vocabulary (./task-state.ts);
 * `status` stays beside it unchanged.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { pendingOperationTaskState, PENDING_OPERATION_TASK_STATES } from './task-state'

export const PENDING_OPERATION_STATUSES = ['pending', 'committing', 'committed', 'rejected', 'failed_partial'] as const

/** The columns the view reads; never `params`. */
export const PENDING_OPERATION_VIEW_COLUMNS =
  'id, company_id, batch_id, operation_type, title, preview_data, status, risk_level, actor_type, actor_id, actor_label, rejection_category, rejection_reason, result_data, created_at, resolved_at'

/**
 * The pending_operations read every v1 door starts from, with the column
 * list spelled as a literal so the schema guard (tests/schema) can check each
 * column: a select built from a constant counts as unresolvable. Must stay
 * equal to PENDING_OPERATION_VIEW_COLUMNS (pinned by view.test.ts).
 */
export function selectPendingOperationView(supabase: SupabaseClient) {
  return supabase
    .from('pending_operations')
    .select(
      'id, company_id, batch_id, operation_type, title, preview_data, status, risk_level, actor_type, actor_id, actor_label, rejection_category, rejection_reason, result_data, created_at, resolved_at',
    )
}

export interface PendingOperationViewRow {
  id: string
  company_id: string
  batch_id?: string | null
  operation_type: string
  title: string
  preview_data: Record<string, unknown> | null
  status: string
  risk_level: string
  actor_type: string
  actor_id: string | null
  actor_label: string | null
  rejection_category: string | null
  rejection_reason: string | null
  result_data: Record<string, unknown> | null
  created_at: string
  resolved_at: string | null
}

export const PendingOperationView = z.object({
  pending_operation_id: z.string().uuid(),
  company_id: z.string().uuid(),
  operation_type: z.string().describe('What approving it does, e.g. create_invoice, categorize_transaction.'),
  title: z.string().describe('The one line the approver sees, in Swedish.'),
  status: z
    .enum(PENDING_OPERATION_STATUSES)
    .describe(
      'pending: waiting for a decision. committing: an approval is running it. committed: done. rejected: not done (a person said no, it expired, it was handled another way, or the commit refused it). failed_partial: the commit failed after posting something; result.posted_ids names it.',
    ),
  task_state: z
    .enum(PENDING_OPERATION_TASK_STATES)
    .describe(
      'The status in the MCP Tasks / A2A vocabulary: working (pending, committing), completed (committed), failed (the approved commit did not go through: failed_partial, or rejected by the commit), cancelled (rejected by a person, expired or superseded). completed, failed and cancelled never change again.',
    ),
  risk_level: z.enum(['low', 'medium', 'high']).describe('high needs confirmed=true on approve.'),
  preview: z.record(z.string(), z.unknown()).describe('What approving it will do, as the approver sees it.'),
  result: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('The outcome once resolved: the committed ids, or why it was not done. null while pending.'),
  rejection_category: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  actor_type: z.string().describe('Who staged it: api_key, mcp_oauth, user, agent_chat or cron.'),
  actor_id: z.string().nullable(),
  actor_label: z.string().nullable(),
  batch_id: z.string().uuid().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  links: z.object({
    self: z.string(),
    approve: z.string(),
    reject: z.string(),
  }),
})

export type PendingOperationViewOut = z.infer<typeof PendingOperationView>

export function pendingOperationPath(companyId: string, id: string): string {
  return `/api/v1/companies/${companyId}/pending-operations/${id}`
}

export function toPendingOperationView(row: PendingOperationViewRow): PendingOperationViewOut {
  const self = pendingOperationPath(row.company_id, row.id)
  return {
    pending_operation_id: row.id,
    company_id: row.company_id,
    operation_type: row.operation_type,
    title: row.title,
    status: row.status as PendingOperationViewOut['status'],
    task_state: pendingOperationTaskState(row),
    risk_level: row.risk_level as PendingOperationViewOut['risk_level'],
    preview: row.preview_data ?? {},
    result: row.result_data ?? null,
    rejection_category: row.rejection_category ?? null,
    rejection_reason: row.rejection_reason ?? null,
    actor_type: row.actor_type,
    actor_id: row.actor_id ?? null,
    actor_label: row.actor_label ?? null,
    batch_id: row.batch_id ?? null,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    links: { self, approve: `${self}/approve`, reject: `${self}/reject` },
  }
}

const EXAMPLE_ID = '9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f'
const EXAMPLE_COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EXAMPLE_SELF = pendingOperationPath(EXAMPLE_COMPANY, EXAMPLE_ID)

/** The worked example the v1 endpoints document (OpenAPI, the accounted-api skill). */
export const PENDING_OPERATION_VIEW_EXAMPLE: PendingOperationViewOut = {
  pending_operation_id: EXAMPLE_ID,
  company_id: EXAMPLE_COMPANY,
  operation_type: 'create_supplier',
  title: 'Skapa leverantör Clas Ohlson AB',
  status: 'pending',
  task_state: 'working',
  risk_level: 'medium',
  preview: { name: 'Clas Ohlson AB', supplier_type: 'swedish_business' },
  result: null,
  rejection_category: null,
  rejection_reason: null,
  actor_type: 'api_key',
  actor_id: 'b1f04c2e-7d3a-4e5b-9c6d-0e1f2a3b4c5d',
  actor_label: 'Attestflöde',
  batch_id: null,
  created_at: '2026-10-15T09:12:00.000Z',
  resolved_at: null,
  links: { self: EXAMPLE_SELF, approve: `${EXAMPLE_SELF}/approve`, reject: `${EXAMPLE_SELF}/reject` },
}
