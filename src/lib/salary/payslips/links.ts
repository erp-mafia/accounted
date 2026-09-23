/**
 * Secure payslip links — token lifecycle for emailed payslip URLs.
 *
 * Payslips are delivered as links, never attachments (salary data +
 * personnummer must not live in inboxes). The token IS the authentication
 * for the public /payslip/[token] surface, so it is treated as a credential:
 * 32 random bytes, sha256-hashed at rest (raw token exists only in the
 * outgoing email), one live link per (salary_run, employee), rotated on
 * every resend and revoked when the run is corrected.
 */
import { createHash, randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Links stay valid 90 days from (re)send; resending re-arms the expiry. */
export const PAYSLIP_LINK_TTL_DAYS = 90

// 32 bytes base64url = 43 chars, alphabet [A-Za-z0-9_-].
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export interface PayslipLinkRow {
  id: string
  company_id: string
  salary_run_id: string
  employee_id: string
  token_hash: string
  expires_at: string
  revoked_at: string | null
  access_count: number
}

export type ResolvePayslipTokenResult =
  | { ok: true; link: PayslipLinkRow }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'expired' | 'revoked' }

export function generatePayslipToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashPayslipToken(token) }
}

export function hashPayslipToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isValidPayslipTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token)
}

/**
 * Create or rotate the link for one employee in a run. Rotation overwrites
 * token_hash, so any previously emailed link stops resolving — exactly one
 * live token per (salary_run_id, employee_id) at any time.
 *
 * Returns the RAW token (for the email); it is never persisted.
 */
export async function rotateLinkForEmployee(
  supabase: SupabaseClient,
  params: {
    companyId: string
    salaryRunId: string
    employeeId: string
    userId: string
  },
): Promise<{ token: string }> {
  const { token, hash } = generatePayslipToken()
  const expiresAt = new Date(
    Date.now() + PAYSLIP_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { error } = await supabase
    .from('salary_payslip_links')
    .upsert(
      {
        company_id: params.companyId,
        salary_run_id: params.salaryRunId,
        employee_id: params.employeeId,
        user_id: params.userId,
        token_hash: hash,
        expires_at: expiresAt,
        revoked_at: null,
      },
      { onConflict: 'salary_run_id,employee_id' },
    )

  if (error) {
    throw new Error(`Kunde inte skapa lönebeskedslänk: ${error.message}`)
  }

  return { token }
}

/**
 * Revoke every live link for a run. Used when the run is corrected —
 * the storno replaces the payslips, so old links must stop resolving.
 */
export async function revokeLinksForRun(
  supabase: SupabaseClient,
  salaryRunId: string,
): Promise<void> {
  await supabase
    .from('salary_payslip_links')
    .update({ revoked_at: new Date().toISOString() })
    .eq('salary_run_id', salaryRunId)
    .is('revoked_at', null)
}

/**
 * Resolve a raw token from the public surface. Service-role client — code is
 * the only guard here: strict hash equality, then revocation/expiry checks.
 * Touches access tracking on success. Never log the raw token.
 */
export async function resolvePayslipToken(
  serviceClient: SupabaseClient,
  token: string,
): Promise<ResolvePayslipTokenResult> {
  if (!isValidPayslipTokenFormat(token)) {
    return { ok: false, reason: 'invalid_format' }
  }

  const { data: link } = await serviceClient
    .from('salary_payslip_links')
    .select('id, company_id, salary_run_id, employee_id, token_hash, expires_at, revoked_at, access_count')
    .eq('token_hash', hashPayslipToken(token))
    .maybeSingle()

  if (!link) return { ok: false, reason: 'not_found' }
  if (link.revoked_at) return { ok: false, reason: 'revoked' }
  if (new Date(link.expires_at) < new Date()) return { ok: false, reason: 'expired' }

  await serviceClient
    .from('salary_payslip_links')
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: (link.access_count ?? 0) + 1,
    })
    .eq('id', link.id)

  return { ok: true, link: link as PayslipLinkRow }
}
