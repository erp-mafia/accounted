import Link from 'next/link'
import { Settings } from 'lucide-react'
import { createClient, createServiceClient } from '@/lib/supabase/server'

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Only show the settings escape hatch for users who have completed
  // onboarding at least once — i.e. they have a company_members row, even if
  // it points to an archived company. Absolute first-time users don't need
  // it and it clutters the welcome screen.
  //
  // Must use the service client: RLS on company_members goes through
  // user_company_ids(), which filters out archived companies, so an
  // authenticated query would return nothing for a user who archived their
  // last company and make the escape hatch disappear exactly when it's
  // needed most. Scoped to user_id = user.id, so no cross-user exposure.
  let hasCompletedOnboarding = false
  if (user) {
    const service = createServiceClient()
    const { data } = await service
      .from('company_members')
      .select('company_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()
    hasCompletedOnboarding = !!data
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-full max-w-lg px-5">
        {children}
      </div>

      {/* Escape hatch: a user who archived their last company can still
          reach account settings (and the delete-account flow) from here.
          Hidden for absolute first-time users (no memberships ever). */}
      {user && hasCompletedOnboarding && (
        <Link
          href="/settings/account"
          aria-label="Kontoinställningar"
          title="Kontoinställningar"
          className="fixed bottom-6 right-6 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </Link>
      )}

    </div>
  )
}
