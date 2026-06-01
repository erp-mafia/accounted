/**
 * Shared data assembly for the SLP / SN individual-level wage file.
 *
 * SLP's mätperiod is September; we snapshot each active employee from their
 * master record (överenskommen lön, semesterdagar, coded attributes) and layer
 * on the September salary run's worked hours + overtime supplement when a run
 * exists. Used by both the SCB (SLP) and Svenskt Näringsliv (SN) routes since
 * they share one postbeskrivning.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import type { SlpEmployeeInput } from './slp'

const OVERTIME_SUPPLEMENT = ['overtime', 'overtime_50', 'overtime_100']

export async function collectSlpEmployees(
  supabase: SupabaseClient,
  companyId: string,
  year: number,
): Promise<{ rows: SlpEmployeeInput[]; error?: string }> {
  // Active employees — the structural population.
  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, personnummer, worker_category, salary_type, monthly_salary, hourly_rate, ssyk_code, cfar_number, arbetstidsart, anstallningsform, vacation_days_per_year')
    .eq('company_id', companyId)
    .eq('is_active', true)
  if (empErr) return { rows: [], error: empErr.message }

  // September run for the worked-hours + overtime snapshot (mätperiod).
  const { data: runs } = await supabase
    .from('salary_runs')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_year', year)
    .eq('period_month', 9)

  const runIds = (runs ?? []).map(r => r.id as string)
  const hoursByEmp = new Map<string, number>()
  const overtimeByEmp = new Map<string, number>()

  if (runIds.length > 0) {
    const { data: sres } = await supabase
      .from('salary_run_employees')
      .select('id, employee_id, hours_worked')
      .eq('company_id', companyId)
      .in('salary_run_id', runIds)

    const sreList = sres ?? []
    for (const s of sreList) {
      if (s.hours_worked != null) hoursByEmp.set(s.employee_id as string, Number(s.hours_worked))
    }

    const sreToEmp = new Map(sreList.map(s => [s.id as string, s.employee_id as string]))
    const sreIds = sreList.map(s => s.id as string)
    if (sreIds.length > 0) {
      const { data: items } = await supabase
        .from('salary_line_items')
        .select('salary_run_employee_id, amount, item_type')
        .eq('company_id', companyId)
        .in('salary_run_employee_id', sreIds)
        .in('item_type', OVERTIME_SUPPLEMENT)
      for (const it of items ?? []) {
        const empId = sreToEmp.get(it.salary_run_employee_id as string)
        if (empId) overtimeByEmp.set(empId, (overtimeByEmp.get(empId) ?? 0) + Number(it.amount))
      }
    }
  }

  const rows: SlpEmployeeInput[] = (employees ?? []).map(e => {
    let personnummer = ''
    try {
      personnummer = decryptPersonnummer(e.personnummer as string)
    } catch {
      personnummer = ''
    }
    return {
      personnummer,
      workerCategory: (e.worker_category as string | null) ?? null,
      salaryType: e.salary_type as string,
      ssykCode: (e.ssyk_code as string | null) ?? null,
      cfarNumber: (e.cfar_number as string | null) ?? null,
      arbetstidsart: (e.arbetstidsart as string | null) ?? null,
      anstallningsform: (e.anstallningsform as string | null) ?? null,
      agreedWage: e.salary_type === 'hourly'
        ? Number(e.hourly_rate) || 0
        : Number(e.monthly_salary) || 0,
      workedHours: hoursByEmp.get(e.id as string) ?? 0,
      overtimeSupplement: overtimeByEmp.get(e.id as string) ?? 0,
      vacationDays: Number(e.vacation_days_per_year) || 0,
    }
  })

  return { rows }
}
