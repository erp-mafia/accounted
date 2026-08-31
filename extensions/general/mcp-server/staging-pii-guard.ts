/**
 * PII chokepoint for staged operations (ISO 27001 A.8.11 / GDPR Art.5(1)(c)).
 *
 * pending_operations.params and .preview_data are persisted verbatim and
 * rendered in approval UIs, so no staging payload may carry a plaintext
 * personnummer. The tools that legitimately receive one
 * (gnubok_create_employee, gnubok_create_customer) encrypt at staging time and
 * store only `personnummer_encrypted` / `personnummer_last4` /
 * `personnummer_masked` (employees) or `personal_number_encrypted` /
 * `personal_number_masked` (customers).
 * This guard runs inside stagePendingOperation, so every current and FUTURE
 * staging tool inherits the rule: a tool that forgets to encrypt fails loudly
 * at staging instead of silently persisting PII.
 *
 * Detection is key-based, not value-based: for enskild firma the org number
 * IS the owner's personnummer, so value-pattern matching would false-positive
 * on legitimate counterparty data. Keys are compared exactly; the derived
 * forms above are therefore allowed by construction.
 */

const FORBIDDEN_KEYS = new Set([
  'personnummer',
  'pnr',
  'social_security_number',
  'ssn',
  // customers.personal_number: gnubok_create_customer stages it as
  // personal_number_encrypted + personal_number_masked, never under this key.
  'personal_number',
])

/**
 * Cycle/degenerate-payload stop: staged payloads are shallow JSON. Anything
 * nesting deeper is rejected (fail closed), never silently accepted: a
 * payload too deep to scan could hide a forbidden key below the limit.
 */
const MAX_DEPTH = 6

/** Sentinel: the payload nests past MAX_DEPTH, so it cannot be fully scanned. */
const DEPTH_EXCEEDED = Symbol('depth-exceeded')

function findForbiddenKey(
  value: unknown,
  depth: number,
): string | typeof DEPTH_EXCEEDED | null {
  if (value === null || typeof value !== 'object') return null
  if (depth > MAX_DEPTH) return DEPTH_EXCEEDED
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenKey(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) return key
    const hit = findForbiddenKey(nested, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * Throws when `payload` (params or preview_data) carries a plaintext
 * personnummer-bearing key at any nesting level, or nests too deep to scan
 * (fail closed). `label` names the offending payload in the error so the
 * tool author sees exactly what to fix.
 */
export function assertNoPlaintextPersonnummer(
  payload: Record<string, unknown>,
  label: 'params' | 'preview_data',
): void {
  const hit = findForbiddenKey(payload, 0)
  if (hit === DEPTH_EXCEEDED) {
    throw new Error(
      `Staging blocked: ${label} nests deeper than ${MAX_DEPTH} levels and cannot be scanned for plaintext PII. ` +
        'Flatten the payload; staged payloads are shallow JSON by design.',
    )
  }
  if (hit) {
    throw new Error(
      `Staging blocked: ${label} contains plaintext PII key "${hit}". ` +
        'pending_operations must never persist a plaintext personnummer; ' +
        'encrypt at staging time (see gnubok_create_employee: personnummer_encrypted + personnummer_last4).',
    )
  }
}
