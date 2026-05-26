import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getActiveCompanyId } from '@/lib/company/context'
import { CompanyProfileView } from '@/components/settings/CompanyProfileView'

export const dynamic = 'force-dynamic'

// /settings/company-profile (Företagsprofil) — read-only Bolagsuppgifter
// from the cached TIC company snapshot. Server component: reads the
// snapshot column directly (core data) and hands it to a presentational
// view, no client fetch needed.
export default async function CompanyProfileSettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const { data: company } = await supabase
    .from('companies')
    .select('tic_snapshot, tic_snapshot_fetched_at')
    .eq('id', companyId)
    .maybeSingle()

  return (
    <div className="space-y-8">
      <CompanyProfileView
        snapshot={(company?.tic_snapshot as Parameters<typeof CompanyProfileView>[0]['snapshot']) ?? null}
        fetchedAt={(company?.tic_snapshot_fetched_at as string | null) ?? null}
      />
    </div>
  )
}
