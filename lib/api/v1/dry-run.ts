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
 *      the same `Idempotency-Key` to guarantee at-most-once semantics. The
 *      wrapper keeps the two apart: a dry-run response is never written to the
 *      idempotency cache, and the dry-run flag is folded into the request hash,
 *      so the commit executes for real instead of replaying the preview.
 *      Order matters. Once a key has committed for real, re-issuing it WITH
 *      `dry_run=true` is rejected as key reuse (409 IDEMPOTENCY_KEY_REUSE)
 *      rather than answered with the committed result dressed up as a preview.
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
