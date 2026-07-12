/**
 * Dry-run response helpers for v1 write endpoints.
 *
 * Architectural contract (per the v1 plan):
 *
 *   1. Every POST / PATCH / DELETE accepts `?dry_run=true` or `X-Dry-Run: true`.
 *   2. A dry-run response returns 200 OK with `{ data: { dry_run: true, preview, ... } }`
 *      and the `X-Dry-Run: true` response header: NEVER the resource's
 *      normal success status (201, 204, etc.). A caller that sees `200`
 *      with `X-Dry-Run` knows the write was NOT committed.
 *   3. Commit by re-issuing the same request without `dry_run=true`, passing
 *      the same `Idempotency-Key` to guarantee at-most-once semantics.
 *
 * Two preview shapes are supported:
 *
 *   - **Validation-only** (non-financial resources like customers): the
 *     preview is the would-be record. No staging, no `pending_operations`
 *     row, no journal lines. Useful for validating inputs and discovering
 *     conflicts (duplicate org_number, validation errors) before committing.
 *
 *   - **Staged** (financial resources: invoices, journal entries, period
 *     ops, salary; later phases): the preview is the record PLUS a
 *     `staged_operation_id` from `pending_operations`, the `journal_lines`
 *     that would be posted, and the `voucher_number_assigned_on_commit`.
 *     Committing happens either by re-POSTing or via
 *     `POST /v1/operations/{staged_operation_id}:commit`.
 *
 * This file ships the helpers for both modes. Phase 2 PR-B-1 only uses the
 * validation-only path (customers); the staged path is wired but not
 * exercised until invoice writes land in PR-B-2.
 */

import { NextResponse } from 'next/server'
import type { Logger } from '@/lib/logger'
import { ok } from './response'

export interface DryRunPreviewBase<T> {
  /** Always `true` so agents can dispatch on this without parsing headers. */
  dry_run: true
  /** The would-be resource. Same shape as the success response. */
  preview: T
}

export interface DryRunPreviewStaged<T> extends DryRunPreviewBase<T> {
  /** `pending_operations.id`. Use with POST /v1/operations/{id}:commit. */
  staged_operation_id: string
  /**
   * Journal lines this write WOULD produce on commit. Absent for
   * non-financial writes. Each item: `{ account, debit, credit, description? }`.
   */
  journal_lines?: Array<{
    account: string
    debit: number
    credit: number
    description?: string
  }>
  /**
   * The voucher number that WOULD be assigned on commit. Present only
   * when the write produces a posted journal entry. Voucher numbers are
   * sequential, so this is a *projection*: the actual number could differ
   * by one or two if another committer beat the agent to the next number.
   */
  voucher_number_assigned_on_commit?: string
  /** Effect on account balances. Absent for non-financial writes. */
  account_deltas?: Array<{ account: string; delta: number }>
}

export type DryRunPreview<T> = DryRunPreviewBase<T> | DryRunPreviewStaged<T>

interface DryRunResponseOptions {
  requestId: string
  log: Logger
}

/**
 * Return a 200 OK dry-run response for a validation-only preview.
 *
 * Use for non-financial writes (customers, suppliers metadata, employee
 * profiles, settings) where there's nothing to stage: the agent just wants
 * to know what would be written and whether validation passes.
 */
export function dryRunPreview<T>(preview: T, opts: DryRunResponseOptions): NextResponse {
  const body: DryRunPreviewBase<T> = { dry_run: true, preview }
  opts.log.info('dry-run preview returned', { stage: 'validation-only' })
  return ok(body, { requestId: opts.requestId, dryRun: true })
}

/**
 * Return a 200 OK dry-run response for a staged preview (financial writes).
 *
 * Phase 2 PR-B-1 does not yet exercise this path; the helper is in place so
 * Phase 2 PR-B-2 (invoice writes) and later phases (journal entries,
 * year-end, etc.) reuse it without redefining the shape.
 */
export function dryRunStaged<T>(
  data: {
    preview: T
    stagedOperationId: string
    journalLines?: DryRunPreviewStaged<T>['journal_lines']
    voucherNumberAssignedOnCommit?: string
    accountDeltas?: DryRunPreviewStaged<T>['account_deltas']
  },
  opts: DryRunResponseOptions,
): NextResponse {
  const body: DryRunPreviewStaged<T> = {
    dry_run: true,
    preview: data.preview,
    staged_operation_id: data.stagedOperationId,
    ...(data.journalLines ? { journal_lines: data.journalLines } : {}),
    ...(data.voucherNumberAssignedOnCommit
      ? { voucher_number_assigned_on_commit: data.voucherNumberAssignedOnCommit }
      : {}),
    ...(data.accountDeltas ? { account_deltas: data.accountDeltas } : {}),
  }
  opts.log.info('dry-run preview returned', {
    stage: 'staged',
    stagedOperationId: data.stagedOperationId,
  })
  return ok(body, { requestId: opts.requestId, dryRun: true })
}
