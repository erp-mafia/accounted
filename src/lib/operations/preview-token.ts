/**
 * Pinned previews: a dry run answers, beside its preview, a `preview_token`
 * that fingerprints what the preview was computed from, and a commit that
 * sends the token back is refused (PREVIEW_STALE, nothing written) when the
 * same dry run, recomputed at commit time, no longer fingerprints the same.
 *
 * Why: an agent shows a person a preview ("this books 6570 debit 50, 1930
 * credit 50"), the person says yes, and the commit must book exactly that or
 * refuse. Between the two, state can move: a period gets locked, an account
 * is deactivated, a rate changes, another write lands. Without a pin the
 * commit books whatever the new state produces. Stripe's analogue is passing
 * the preview's proration_date so the charge equals the preview.
 *
 * The token is `pv1.` + base64url(SHA-256(canonical JSON of
 *   { v: 1, operation, company_id, input, preview })):
 *   - operation: the operation id, so a token never passes on another
 *     operation, even one with the same input shape;
 *   - company_id: lowercased, so a token never passes in another company;
 *   - input: the operation's VALIDATED input (Zod output, defaults applied),
 *     so the same request in another key order, or with a default spelled
 *     out, pins the same way, and any other input does not;
 *   - preview: the dry run's preview minus the operation's
 *     `volatilePreviewKeys` (see "What is left out" below).
 * The same input to the same operation in the same company fingerprints the
 * same on every door (v1, v1 stage mode, MCP), so a token is door-agnostic.
 *
 * A fingerprint, not an authorization. It carries no secret and proves
 * nothing about who computed it; anyone holding the input and the preview
 * can recompute it, which is exactly what the server does. Every door still
 * runs its own auth, scope and company gates before it looks at a token.
 * SHA-256 is one-way: the token encodes nothing beyond what the client
 * already sent (the input) and already received (the preview).
 *
 * Not a lock: the check runs immediately before the commit, inside the same
 * request, so the window in which state can move shrinks from the person's
 * thinking time to the request's own milliseconds. Inside that window the
 * commit's own checks and the DB triggers (period locks, balance) stay the
 * authority, as they are without a token.
 *
 * What is left out, and why the list is per operation. The envelope's
 * volatile parts (meta.request_id, the X-Request-Id header, the staging
 * answer's message) are never part of a preview, so they are out by
 * construction. Inside a preview there is no global exclusion by key name:
 * a survey of every write's dry run (2026-10-15) found that the names that
 * look volatile are booking data somewhere else (payment_date is moved to
 * today in one preview and is the salary payment date in another; status,
 * action and signed_at likewise), so a name list would silently unpin real
 * data. An operation names its own top-level keys instead
 * (Operation.volatilePreviewKeys), and only for a value recomputed on every
 * call that the commit recomputes too. The excluded list today:
 *
 *   - arsredovisning.record-signature: signed_at, which defaults to the
 *     moment of the call; a signed_at the caller sent is in the input and
 *     stays pinned through it.
 *   - suppliers.archive: archived_at, the moment of the call, taken at the
 *     dry run and again at the commit.
 *
 * Kept in on purpose: values that move with the calendar or with other
 * writers (a payment date moved to the next banking day, overdue days, an
 * exchange rate, a stored row's updated_at, a sync's last_synced_at). When
 * they move, the commit would do something other than what the person saw,
 * which is exactly what PREVIEW_STALE is for.
 */
import crypto from 'crypto'
import type { AnyOperation, OperationOutcome } from './types'

/** The request header a v1 commit carries the token in. */
export const PREVIEW_TOKEN_HEADER = 'Preview-Token'

const PREFIX = 'pv1.'
/** SHA-256 is 32 bytes: 43 base64url characters, no padding. */
const TOKEN_SHAPE = /^pv1\.[A-Za-z0-9_-]{43}$/

/**
 * Canonical JSON: the value as the wire carries it (JSON semantics: a
 * toJSON() is applied, undefined and functions are dropped from objects and
 * become null in arrays, a non-finite number is null), object keys sorted,
 * no insignificant whitespace, numbers exactly as JSON.stringify renders
 * them (so 50 stays 50, never 50.00). Two values that are equal on the wire
 * canonicalize equal, whatever their key order in memory.
 */
export function canonicalJson(value: unknown): string {
  // A JSON round trip first, so the fingerprint is of what the client sees,
  // never of an in-memory detail (an undefined field, a Date object).
  const text = JSON.stringify(value)
  if (text === undefined) return 'null'
  return canonical(JSON.parse(text) as unknown)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(',')}}`
}

export interface PreviewFingerprintInput {
  operationId: string
  companyId: string
  /** The operation's validated input (the Zod parse's output). */
  input: unknown
  /** The dry run's preview, as the operation answered it. */
  preview: Record<string, unknown>
  /** The operation's volatilePreviewKeys: top-level preview keys left out. */
  volatileKeys?: readonly string[]
}

/** The preview token for one dry run: see the file comment. */
export function computePreviewToken({
  operationId,
  companyId,
  input,
  preview,
  volatileKeys = [],
}: PreviewFingerprintInput): string {
  const pinned =
    volatileKeys.length === 0
      ? preview
      : Object.fromEntries(Object.entries(preview).filter(([key]) => !volatileKeys.includes(key)))
  const fingerprinted = { v: 1, operation: operationId, company_id: companyId.toLowerCase(), input, preview: pinned }
  const digest = crypto.createHash('sha256').update(canonicalJson(fingerprinted)).digest('base64url')
  return `${PREFIX}${digest}`
}

/**
 * The token of `op`'s dry run for `input` in `companyId`: every door (v1, the
 * v1 stage mode, MCP) computes it through here, so they cannot disagree.
 */
export function operationPreviewToken(
  op: Pick<AnyOperation, 'id' | 'volatilePreviewKeys'>,
  companyId: string,
  input: unknown,
  preview: Record<string, unknown>,
): string {
  return computePreviewToken({ operationId: op.id, companyId, input, preview, volatileKeys: op.volatilePreviewKeys })
}

/** True when `value` has the shape of a token this version issues. */
export function isPreviewToken(value: string): boolean {
  return TOKEN_SHAPE.test(value)
}

/** The sentence a malformed token is refused with (VALIDATION_ERROR), on every door. */
export const MALFORMED_PREVIEW_TOKEN_MESSAGE =
  'Not a preview token: send back the preview_token a dry run of this same request answered (pv1. followed by 43 characters).'

/**
 * The refusal of a commit whose pin no longer holds: PREVIEW_STALE, nothing
 * written, with the fresh preview and its token so the caller can show the
 * person what the commit would do now and commit that instead.
 */
export function previewStaleFailure(
  preview: Record<string, unknown>,
  previewToken: string,
): Extract<OperationOutcome<never>, { ok: false }> {
  return { ok: false, code: 'PREVIEW_STALE', details: { preview, preview_token: previewToken } }
}
