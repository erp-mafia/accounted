import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

/**
 * Sandbox guard: returns true if the given company is a sandbox company
 * (`company_settings.is_sandbox = true`). Used to short-circuit API routes
 * that would otherwise call paid external services (Anthropic Bedrock, the
 * Resend email API, Riksbanken FX, VIES, Skatteverket, Enable Banking, TIC).
 *
 * The sandbox is intentionally read-only against external systems: it must
 * never send a real email, charge a token, or speak to a tax authority on
 * behalf of an anonymous demo user. RLS and the `is_sandbox` flag on
 * company_settings are the single source of truth: we check it here on
 * every gated entry point so the demo can't accidentally outgrow its sandbox.
 */
export async function isSandboxCompany(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('company_settings')
    .select('is_sandbox')
    .eq('company_id', companyId)
    .maybeSingle()
  return data?.is_sandbox === true
}

/**
 * Standard 403 response for sandbox-blocked endpoints. The bilingual envelope
 * matches the rest of the app's error shape: the UI picks the right field
 * via the active locale.
 */
export function sandboxBlockedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Inte tillgängligt i sandlådan. Skapa ett konto för att använda AI-assistenten och externa tjänster.',
      error_en: 'Not available in the sandbox. Create an account to use the AI assistant and external services.',
      sandbox_blocked: true,
    },
    { status: 403 },
  )
}

/**
 * Convenience wrapper: check + return the 403 in one call. Returns the
 * NextResponse to return from the route, or `null` when the company is not
 * a sandbox and the route should proceed.
 *
 *   const blocked = await guardSandbox(supabase, companyId)
 *   if (blocked) return blocked
 */
export async function guardSandbox(
  supabase: SupabaseClient,
  companyId: string,
): Promise<NextResponse | null> {
  if (await isSandboxCompany(supabase, companyId)) {
    return sandboxBlockedResponse()
  }
  return null
}
