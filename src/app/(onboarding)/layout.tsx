import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import OnboardingBackdrop from '@/components/onboarding/OnboardingBackdrop'
import { SessionTimeoutController } from '@/components/auth/SessionTimeoutController'
import { Button } from '@/components/ui/button'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'
import { ACCOUNT_DELETION_HREF } from '@/lib/company/no-company-routes'
import { LegalAcceptanceGate } from '@/components/legal/LegalAcceptanceGate'
import { readAcceptanceState } from '@/lib/legal/acceptance'

type MembershipCompany = { archived_at: string | null }

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Only show the escape hatch to a user whose companies are all deleted
  // (archived): deleting the account requires owning none, so that is the
  // user who lands here after deleting their last company in order to leave
  // (crm#1042). Absolute first-time users (no memberships ever) and users
  // with a live company don't need it, and it clutters the welcome screen.
  //
  // Must use the service client: RLS on company_members goes through
  // user_company_ids(), which filters out archived companies, so an
  // authenticated query would return nothing for a user who archived their
  // last company and make the escape hatch disappear exactly when it's
  // needed most. Scoped to user_id = user.id, so no cross-user exposure.
  let onlyArchivedCompanies = false
  if (user) {
    const service = createServiceClient()
    const { data } = await service
      .from('company_members')
      .select('company:company_id ( archived_at )')
      .eq('user_id', user.id)
    const companies = ((data ?? []) as unknown as Array<{
      company: MembershipCompany | MembershipCompany[] | null
    }>).map((row) => (Array.isArray(row.company) ? row.company[0] ?? null : row.company))
    onlyArchivedCompanies =
      companies.length > 0 && companies.every((company) => !!company?.archived_at)
  }

  const t = onlyArchivedCompanies ? await getTranslations('onboarding') : null

  // A new signup meets the acceptance prompt here, before the first company
  // exists (the dashboard layout shows it to everyone else).
  const acceptance = user && !user.is_anonymous ? await readAcceptanceState(supabase, user.id) : null

  // The onboarding journey reads most of the catalog; the root layout hands
  // client components only the public and auth namespaces.
  return (
    <AllMessagesProvider>
    <div className="min-h-dvh bg-background flex items-center justify-center">
      {user && <SessionTimeoutController />}
      <OnboardingBackdrop />

      <div className="relative z-10 w-full max-w-lg px-5">
        {children}
      </div>

      {/* Escape hatch: a quiet link straight to the delete-account action,
          which the middleware keeps reachable without a company. It used to
          be an unlabelled gear to Profil, which no longer holds the action.
          Fixed above the journey's full-screen layer, clear of its centred
          back button. */}
      {t && (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="fixed bottom-6 right-6 z-50 text-muted-foreground"
        >
          <Link href={ACCOUNT_DELETION_HREF}>{t('account_deletion_link')}</Link>
        </Button>
      )}

      {acceptance && <LegalAcceptanceGate state={acceptance} pathname="/onboarding" company={null} role={null} />}
    </div>
    </AllMessagesProvider>
  )
}
