/**
 * Which packages are fully off for a company: switched off (by the company or
 * its profile, ./profiles.ts packageSwitchedOff, the rule the resolver and
 * the start gate apply) with nothing open (./obligations.ts). A switched-off
 * package that still has open work is winding down and is NOT in the set:
 * its obligations must keep being settled, so whatever serves them keeps
 * running. For background work that skips a package's passes, such as the
 * bank ingest matchers (lib/transactions/ingest-package-gate.ts).
 *
 * Only the switch decides, never the plan or the country: those answer at
 * the door (decision 2026-10-16-readers-hide-by-package-only).
 *
 * Cheap for the common case: one parallel wave of two reads (the package
 * config rows of the packages asked about, and the stored profile), then the
 * obligation probes of the packages that are switched off, and only those. A
 * company with every package on, which is every company without a profile
 * or a switch, reads two rows and nothing more.
 *
 * Errs towards running: null when the switch read fails, so the caller runs
 * everything as before (losing a company's "on" over a profile's "off" would
 * skip work it asked for). A failed profile read is Standard, every package
 * on (readStoredProfile), and a failed obligation probe counts as open, so
 * neither can put a package in the set that should not be there.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { probePackageObligations } from './obligations'
import { getPackage, packageConfigKey, packageForConfigKey, type PackageId } from './packages'
import { packageSwitchedOff, resolveStoredProfile, type SwitchablePackageId } from './profiles'
import { readStoredProfile } from './stored-profile'

const log = createLogger('modules/packages-off')

/**
 * The packages among `packageIds` that are switched off with no open
 * obligation, or null when the switch could not be read. Bokföring and ids
 * that are not packages are never off.
 */
export async function readPackagesOff(
  supabase: SupabaseClient,
  companyId: string,
  packageIds: readonly PackageId[],
  options: { today?: string } = {},
): Promise<ReadonlySet<PackageId> | null> {
  const switchable = [...new Set(packageIds)].filter((id) => getPackage(id)?.switchable === true) as SwitchablePackageId[]
  if (switchable.length === 0) return new Set()
  try {
    const [config, stored] = await Promise.all([
      supabase
        .from('company_capability_config')
        .select('capability_key, enabled')
        .eq('company_id', companyId)
        .in('capability_key', switchable.map(packageConfigKey)),
      readStoredProfile(supabase, companyId),
    ])
    if (config.error) {
      log.warn('package switch read failed: nothing counted as off', { companyId, error: config.error.message })
      return null
    }
    const choices = new Map<PackageId, boolean>()
    for (const row of (config.data ?? []) as Array<{ capability_key: string; enabled: boolean | null }>) {
      const id = packageForConfigKey(row.capability_key)
      if (id && typeof row.enabled === 'boolean') choices.set(id, row.enabled)
    }
    const profile = resolveStoredProfile(stored).definition
    const switchedOff = switchable.filter((id) => packageSwitchedOff(getPackage(id), profile, choices.get(id)) !== null)
    if (switchedOff.length === 0) return new Set()

    const open = await Promise.all(
      switchedOff.map((id) => probePackageObligations(supabase, companyId, id, options)),
    )
    return new Set(switchedOff.filter((_, i) => open[i].length === 0))
  } catch (err) {
    log.warn('package switch read failed: nothing counted as off', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
