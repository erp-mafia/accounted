/**
 * Assembles SuS sick cases from salary_absence_days for a collection month.
 *
 * We read 'sick' absence days within the month plus a 7-day lookback (to detect
 * cases that began in the previous month) and group them into sjukfall via
 * groupSickCases. Personnummer is decrypted from the employee record.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { groupSickCases, type SusCase, type SusSickDay } from './sus'

export async function collectSusCases(
  supabase: SupabaseClient,
  companyId: string,
  year: number,
  month: number,
): Promise<{ cases: SusCase[]; error?: string }> {
  const mm = String(month).padStart(2, '0')
  const monthStart = `${year}-${mm}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const monthEnd = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`
  const lookback = new Date(Date.UTC(year, month - 1, 1) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const { data: absences, error } = await supabase
    .from('salary_absence_days')
    .select('employee_id, absence_date')
    .eq('company_id', companyId)
    .eq('absence_type', 'sick')
    .gte('absence_date', lookback)
    .lte('absence_date', monthEnd)
  if (error) return { cases: [], error: error.message }

  const rows = absences ?? []
  if (rows.length === 0) return { cases: [] }

  // Resolve personnummer for the employees that appear.
  const employeeIds = [...new Set(rows.map(r => r.employee_id as string))]
  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, personnummer')
    .eq('company_id', companyId)
    .in('id', employeeIds)
  if (empErr) return { cases: [], error: empErr.message }

  const pnrByEmp = new Map<string, string>()
  for (const e of employees ?? []) {
    try {
      pnrByEmp.set(e.id as string, decryptPersonnummer(e.personnummer as string))
    } catch {
      // Skip employees whose personnummer can't be decrypted.
    }
  }

  const sickDays: SusSickDay[] = []
  for (const r of rows) {
    const pnr = pnrByEmp.get(r.employee_id as string)
    if (pnr) sickDays.push({ personnummer: pnr, date: r.absence_date as string })
  }

  return { cases: groupSickCases(sickDays, monthStart, monthEnd) }
}
