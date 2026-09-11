import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export interface ExistingEmployeeRef {
  employee_id: string
  existing_name: string
  is_active: boolean
}

/**
 * Personnummer -> existing employee, for duplicate detection.
 *
 * employees.personnummer is AES-GCM ciphertext with a random IV, so the
 * UNIQUE (company_id, personnummer) constraint never matches two encryptions
 * of the same number and no equality query is possible. The roster is
 * decrypted in-process, the same way the register and payslip reads do.
 * A row that fails to decrypt is skipped: it cannot collide with anything.
 */
export async function loadExistingEmployeeIndex(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, ExistingEmployeeRef>> {
  const rows = await fetchAllRows(({ from, to }) =>
    supabase
      .from('employees')
      .select('id, first_name, last_name, personnummer, is_active')
      .eq('company_id', companyId)
      .range(from, to),
  )
  const index = new Map<string, ExistingEmployeeRef>()
  for (const raw of rows as Array<{
    id: string
    first_name: string
    last_name: string
    personnummer: string | null
    is_active: boolean
  }>) {
    if (!raw.personnummer) continue
    let plain: string
    try {
      plain = decryptPersonnummer(raw.personnummer).replace(/\D/g, '')
    } catch {
      continue
    }
    if (plain.length !== 12) continue
    index.set(plain, {
      employee_id: raw.id,
      existing_name: `${raw.first_name} ${raw.last_name}`.trim(),
      is_active: raw.is_active,
    })
  }
  return index
}
