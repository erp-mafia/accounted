import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import WelcomeOnboarding from '@/components/dashboard/WelcomeOnboarding'
import type { EntityType } from '@/types'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

export const dynamic = 'force-dynamic'

// Maps TIC's `legalEntityType` codes onto our two supported EntityType
// values. Anything else (HB, KB, ...) returns undefined so Step 1's radio
// stays unselected and the user picks manually.
function mapEntityType(code: string | null | undefined): EntityType | undefined {
  if (!code) return undefined
  const upper = code.toUpperCase()
  if (upper === 'AB') return 'aktiebolag'
  if (upper === 'EF') return 'enskild_firma'
  return undefined
}

// Server-side TIC lookup for the deep-link path (BankID picker routes here
// with ?org_number=…). Returns null on any error so the page still renders
// even when TIC is unreachable or the proxy isn't configured. Best-effort.
async function prefetchLookup(
  orgNumber: string,
  cookieHeader: string,
  origin: string,
): Promise<CompanyLookupResult | null> {
  try {
    const res = await fetch(
      `${origin}/api/extensions/ext/tic/lookup?org_number=${encodeURIComponent(orgNumber)}`,
      {
        headers: { cookie: cookieHeader, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      },
    )
    if (!res.ok) return null
    const json = (await res.json()) as { data?: CompanyLookupResult }
    return json.data ?? null
  } catch {
    return null
  }
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ org_number?: string }>
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Check if user already has companies (adding another vs first-time)
  const { data: existingMembership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  const hasCompanies = !!existingMembership

  // Fetch profile and team
  const [{ data: profile }, { data: teamMembership }] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', user.id).single(),
    supabase.from('team_members').select('team_id').eq('user_id', user.id).limit(1).maybeSingle(),
  ])

  let teamId = teamMembership?.team_id

  // Ensure user has a team (fallback for edge cases)
  if (!teamId) {
    const { data: newTeamId } = await supabase.rpc('ensure_user_team')
    teamId = newTeamId
  }

  if (!teamId) {
    redirect('/login')
  }

  const firstName = profile?.full_name?.split(' ')[0] || null

  // The BankID picker routes here with ?org_number=… when TIC /lookup fails
  // or the entity type isn't one-click-provisionable. Strip formatting so
  // whatever Step2 displays matches what the rest of the flow will store.
  const { org_number: rawOrgNumber } = await searchParams
  const initialOrgNumber = rawOrgNumber ? rawOrgNumber.replace(/[\s-]/g, '') : undefined

  // Deep-link pre-fetch: when the BankID picker handed us an org-number, run
  // /lookup server-side so Step 1's entity_type radio and Step 3's first-
  // year toggle can land pre-selected. Pure UX optimization — the rest of
  // the form continues to work on lookup failure.
  let initialLookup: CompanyLookupResult | null = null
  let initialEntityType: EntityType | undefined
  if (initialOrgNumber) {
    const hdrs = await headers()
    const cookieHeader = hdrs.get('cookie') ?? ''
    const host = hdrs.get('host') ?? 'localhost:3000'
    const proto = hdrs.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
    initialLookup = await prefetchLookup(initialOrgNumber, cookieHeader, `${proto}://${host}`)
    initialEntityType = mapEntityType(initialLookup?.legalEntityType)
  }

  return (
    <WelcomeOnboarding
      firstName={firstName}
      teamId={teamId}
      skipWelcome
      hasExistingCompanies={hasCompanies}
      initialOrgNumber={initialOrgNumber}
      initialEntityType={initialEntityType}
      initialLookup={initialLookup}
    />
  )
}
