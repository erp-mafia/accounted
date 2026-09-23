/**
 * Non-blocking advisories attached to a SUCCESSFUL fiscal-period create.
 *
 * `POST /api/bookkeeping/fiscal-periods` returns 200 with an optional
 * `warnings: Array<{ code, message }>` (the same shape the invoice booking
 * routes use). The route omits the key entirely when it has nothing to say, so
 * the common case is "no key at all", not "empty array".
 *
 * Today the only code is `PRIOR_FISCAL_YEAR_STILL_OPEN`: the new räkenskapsår
 * was created while a prior one is still fully open, which is the normal and
 * legally required state while the bokslut runs (BFL 5 kap 2 § forces the new
 * year's affärshändelser to be booked within weeks; BFL 6 kap gives the prior
 * year six months to be finished). It is information, never a failure.
 */
export interface FiscalPeriodWarning {
  code: string
  message: string
}

/**
 * Read the `warnings` array off a fiscal-period create response.
 *
 * Defensive by design: absence of the key, a non-array value, and malformed
 * entries all collapse to `[]` so a shape change can never render an empty
 * advisory line. Note that a FAILED create carries its copy in
 * `{ error: ... }`, not in `warnings`, so error payloads yield `[]` here.
 */
export function extractFiscalPeriodWarnings(payload: unknown): FiscalPeriodWarning[] {
  if (!payload || typeof payload !== 'object') return []

  const raw = (payload as { warnings?: unknown }).warnings
  if (!Array.isArray(raw)) return []

  const warnings: FiscalPeriodWarning[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { code, message } = entry as { code?: unknown; message?: unknown }
    if (typeof code !== 'string' || code.length === 0) continue
    if (typeof message !== 'string' || message.trim().length === 0) continue
    warnings.push({ code, message })
  }
  return warnings
}

/**
 * The advisory text to render, or `''` when there is nothing to say.
 *
 * Joined into a single string on purpose: attention is ONE ochre sentence, not
 * a stack of them (UI-migration convention 6). Only one code exists today.
 */
export function fiscalPeriodAdvisoryText(payload: unknown): string {
  return extractFiscalPeriodWarnings(payload)
    .map((w) => w.message)
    .join(' ')
}
