import type { SupabaseClient } from '@supabase/supabase-js'
import { orgNumberKey } from '@/lib/invariants/org-number'

/** How a SIE file's #ORGNR relates to the company it is imported into. */
export interface SIEOrgNumberCheck {
  /** The file's #ORGNR as written, or null when the file has none. */
  fileOrgNumber: string | null
  /** The company's org number as stored, or null when it has none. */
  companyOrgNumber: string | null
  /** True only when both are present and denote different numbers. */
  mismatch: boolean
}

/**
 * The one comparison every SIE door uses: the dashboard preview, the
 * onboarding step, the MCP preflight and the submit gate in submitSIEJob.
 *
 * Keyed with orgNumberKey, so 556677-8899, 5566778899 and the century form
 * 16556677-8899 (or 19... for an enskild firma's personnummer) are one
 * number. A value that is not org-number shaped is compared as written, the
 * rule orgNumberKey documents. A side without a number is not evidence of
 * anything: #ORGNR is optional in SIE 4 and a company may lack one, so
 * that file passes.
 */
export function compareSIEOrgNumber(fileOrg: string | null | undefined,
  companyOrg: string | null | undefined): SIEOrgNumberCheck {
  const fileOrgNumber = fileOrg?.trim() || null
  const companyOrgNumber = companyOrg?.trim() || null
  const mismatch = fileOrgNumber !== null && companyOrgNumber !== null &&
    (orgNumberKey(fileOrgNumber) ?? fileOrgNumber) !== (orgNumberKey(companyOrgNumber) ?? companyOrgNumber)
  return { fileOrgNumber, companyOrgNumber, mismatch }
}

/** compareSIEOrgNumber against companies.org_number, the canonical copy. */
export async function checkSIEOrgNumber(supabase: SupabaseClient, companyId: string,
  fileOrg: string | null | undefined): Promise<SIEOrgNumberCheck> {
  // Nothing to compare: skip the read.
  if (!fileOrg?.trim()) return compareSIEOrgNumber(null, null)
  const { data, error } = await supabase.from('companies').select('org_number').eq('id', companyId).maybeSingle()
  if (error) throw error
  return compareSIEOrgNumber(fileOrg, (data as { org_number?: string | null } | null)?.org_number)
}
