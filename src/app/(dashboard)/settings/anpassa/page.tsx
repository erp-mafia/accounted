import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { switchOnRefusal } from '@/lib/operations/packages'
import { AnpassaSettingsContent, type AnpassaPackage } from '@/components/settings/sections/AnpassaSettingsContent'
import { getDashboardAuthContext, getDashboardCompanyId, getDashboardOpenObligations } from '../../request-context'

/**
 * Företag → Anpassa: every package with its status and a switch (Profiles
 * and Suggestions, winding down and Anpassa). Read on the server from the
 * same resolved capabilities the menu reads; the open obligations of a
 * switched-off package come from the request's shared probe, so the menu and
 * this page never disagree about what winds down.
 */
export default async function AnpassaSettingsPage() {
  const [{ supabase }, companyId] = await Promise.all([getDashboardAuthContext(), getDashboardCompanyId()])
  const capabilities = companyId
    ? await loadCompanyCapabilities(supabase, companyId, {
        loadObligations: (ids) => getDashboardOpenObligations(ids.join(',')),
      }).catch(() => null)
    : null
  if (!capabilities) return <AnpassaSettingsContent profileNameSv="" profileName="" packages={null} />

  const packages: AnpassaPackage[] = capabilities.packages.map((pkg) => ({
    id: pkg.id,
    switchable: pkg.switchable,
    availability: pkg.availability,
    switchedOff: pkg.reasons.includes('turned_off_by_company') || pkg.reasons.includes('off_in_profile'),
    openObligations: [...pkg.open_obligations],
    switchOnBlocked: pkg.switchable ? (switchOnRefusal(capabilities, pkg.id)?.code ?? null) : null,
  }))

  return (
    <AnpassaSettingsContent
      profileNameSv={capabilities.profile.name_sv}
      profileName={capabilities.profile.name}
      packages={packages}
    />
  )
}
