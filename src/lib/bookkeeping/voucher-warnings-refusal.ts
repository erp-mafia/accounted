/**
 * The warnings a VOUCHER_NEEDS_CONFIRMATION refusal came with
 * (./voucher-warnings-guard.ts), read off the route's error body: what a
 * page shows in VoucherWarningsDialog before it sends the same request again
 * with `acknowledged_warnings`. Null for every other answer, and for a
 * refusal that names no warning a person could read: the caller then falls
 * back to its ordinary error path. Client-safe: types only.
 */
import { VOUCHER_WARNING_CODES, type VoucherWarning } from './voucher-plausibility'

const KNOWN_CODES: ReadonlySet<string> = new Set(VOUCHER_WARNING_CODES)

function isVoucherWarning(value: unknown): value is VoucherWarning {
  if (!value || typeof value !== 'object') return false
  const warning = value as Record<string, unknown>
  return (
    typeof warning.code === 'string' &&
    KNOWN_CODES.has(warning.code) &&
    typeof warning.message_sv === 'string' &&
    typeof warning.message_en === 'string' &&
    !!warning.details &&
    typeof warning.details === 'object'
  )
}

export function voucherWarningsOfRefusal(body: unknown): VoucherWarning[] | null {
  const error = (body as { error?: { code?: unknown; details?: { warnings?: unknown } } } | null)?.error
  if (error?.code !== 'VOUCHER_NEEDS_CONFIRMATION') return null
  const warnings = error.details?.warnings
  // Every warning must be one the dialog can show and the route accepts back:
  // a confirm that silently dropped one would be refused again without a word.
  if (!Array.isArray(warnings) || warnings.length === 0 || !warnings.every(isVoucherWarning)) return null
  return warnings
}
