/**
 * GRANT_SUGGESTIONS: Jakob's master switch for grants (lib/grants). Off
 * unless `true` or `1`.
 *
 * Off means the whole feature is off, not only the suggestion:
 *   - the grant-suggestion detector does not run (no create_grant staged);
 *   - the create_grant executor refuses (GRANTS_SWITCHED_OFF), whoever staged
 *     the operation and however it reached the queue;
 *   - the staging door never asks claim_company_grant, so grants that exist
 *     stop applying and every staged write waits for a person, as before.
 * Revoking and pausing stay possible: both only take authority away.
 */
export function grantsEnabled(): boolean {
  const raw = process.env.GRANT_SUGGESTIONS?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}
