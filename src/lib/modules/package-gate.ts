/**
 * The package start gate: what every door asks before it starts new work in
 * a package (./package-doors.ts names the start doors). A package that is
 * switched off, by the company or by its profile, refuses its start doors
 * with PACKAGE_OFF whether it is winding down or gone; everything else in it
 * keeps working. A package that is on, which is every package of every
 * company without a profile or a switch, passes at the cost of two small
 * reads, and only on a start door.
 *
 * Light on purpose: withRouteContext and the extension dispatcher import it
 * for every route, so it reads the switch itself (the package's config row
 * and the stored profile) with the resolver's own rule (packageSwitchedOff),
 * and never loads the capabilities resolver or the obligation probes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { getPackage, packageConfigKey } from './packages'
import { packageSwitchedOff, resolveStoredProfile, type SwitchablePackageId } from './profiles'
import { readStoredProfile } from './stored-profile'

const log = createLogger('modules/package-gate')

export const PACKAGE_OFF_CODE = 'PACKAGE_OFF'

export interface PackageOffRefusal {
  code: typeof PACKAGE_OFF_CODE
  packageId: SwitchablePackageId
  /** Swedish, with the package's name and where to switch it on. */
  messageSv: string
  messageEn: string
  /** The registry status (409). */
  status: number
  /** What the envelopes carry as details. */
  details: {
    package_id: SwitchablePackageId
    package_name: string
    reason: 'turned_off_by_company' | 'off_in_profile'
    resolution: string
  }
}

/** "Paketet Lön är avstängt ... Slå på Lön under Anpassa." */
export function packageOffMessageSv(nameSv: string): string {
  return `Paketet ${nameSv} är avstängt för företaget, så inget nytt kan startas där. Det som redan är öppet fungerar som vanligt. Slå på ${nameSv} under Anpassa.`
}

export function packageOffMessageEn(name: string, nameSv: string): string {
  return `The ${name} package (${nameSv}) is switched off for this company, so no new work can start in it; everything already open in it keeps working. Switch ${nameSv} on in Anpassa (Inställningar), or stage gnubok_enable_package for an owner or admin to approve.`
}

export function packageOffRefusal(
  packageId: SwitchablePackageId,
  reason: 'turned_off_by_company' | 'off_in_profile',
): PackageOffRefusal {
  const pkg = getPackage(packageId)
  return {
    code: PACKAGE_OFF_CODE,
    packageId,
    messageSv: packageOffMessageSv(pkg.nameSv),
    messageEn: packageOffMessageEn(pkg.name, pkg.nameSv),
    status: 409,
    details: {
      package_id: packageId,
      package_name: pkg.nameSv,
      reason,
      resolution: `Slå på ${pkg.nameSv} under Anpassa.`,
    },
  }
}

/**
 * The refusal for a start door of `packageId`, or null when the package is
 * on. A failed read lets the request through: a start that should have been
 * refused is a smaller harm than refusing work on a guess, and the company's
 * own switch is read again on the next request.
 */
export async function packageStartRefusal(
  supabase: SupabaseClient,
  companyId: string,
  packageId: SwitchablePackageId,
): Promise<PackageOffRefusal | null> {
  const pkg = getPackage(packageId)
  try {
    const [config, stored] = await Promise.all([
      supabase
        .from('company_capability_config')
        .select('enabled')
        .eq('company_id', companyId)
        .eq('capability_key', packageConfigKey(packageId))
        .maybeSingle(),
      readStoredProfile(supabase, companyId),
    ])
    if (config.error) {
      log.warn('package switch read failed: start allowed', { companyId, packageId, error: config.error.message })
      return null
    }
    const choice = (config.data as { enabled?: boolean } | null)?.enabled
    const reason = packageSwitchedOff(pkg, resolveStoredProfile(stored).definition, choice)
    return reason ? packageOffRefusal(packageId, reason) : null
  } catch (err) {
    log.warn('package switch read failed: start allowed', {
      companyId,
      packageId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * The MCP error body for a refusal, the shape toToolError builds for any
 * other failure: code, both messages, retryable false, and the remediation
 * that names the package.
 */
export function packageOffToolError(refusal: PackageOffRefusal) {
  return {
    error: {
      code: refusal.code,
      message_sv: refusal.messageSv,
      message_en: refusal.messageEn,
      retryable: false,
      remediation: {
        description: refusal.messageEn,
        tool: 'gnubok_enable_package',
        args: { package_id: refusal.packageId },
      },
      details: refusal.details,
    },
  }
}
