import type { SupabaseClient } from '@supabase/supabase-js'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
import { getAnnualReportVersion } from './version-service'

/** Load immutable version data and overlay only its separately stored signatures. */
export async function getVersionIxbrlInput(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  versionId: string,
): Promise<IxbrlArsredovisningInput | null> {
  const version = await getAnnualReportVersion(supabase, companyId, fiscalPeriodId, versionId)
  if (!version?.ixbrl_data) return null
  const input = structuredClone(version.ixbrl_data)
  const { data, error } = await supabase
    .from('arsredovisning_signature_requests')
    .select('signer_name, role, signed_at')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('annual_report_version_id', versionId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to load version signatures: ${error.message}`)
  if ((data ?? []).length === 0) return input

  input.underskrifter.signers = (data ?? []).map((signature) => {
    const parts = signature.signer_name.trim().split(/\s+/)
    return {
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
      lastName: parts.length > 1 ? parts.at(-1) ?? parts[0] : parts[0],
      role: signature.role,
      signedDate: signature.signed_at?.slice(0, 10) ?? null,
    }
  })
  input.underskrifter.harVd = input.underskrifter.signers.some((signer) =>
    /verkställande direktör|^vd$/i.test(signer.role ?? ''),
  )
  input.underskrifter.dateringsdatum =
    input.underskrifter.signers
      .map((signer) => signer.signedDate)
      .filter((date): date is string => date !== null)
      .sort()
      .at(-1) ?? null
  return input
}
