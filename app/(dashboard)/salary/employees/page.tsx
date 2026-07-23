'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { Plus, UserCircle } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency } from '@/lib/utils'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import type { Employee } from '@/types'

const NewEmployeeDialog = dynamic(
  () => import('@/components/salary/NewEmployeeDialog'),
  { loading: DialogLoadingSkeleton },
)

const EMPLOYMENT_LABEL_KEYS: Record<string, string> = {
  employee: 'employment_employee',
  company_owner: 'employment_company_owner',
  board_member: 'employment_board_member',
}

/**
 * Anställda register (concept scene 28): header + dry-table. Tax table,
 * jämkning, förmåner and semester are configured on the employee detail
 * page; the register is the roster.
 */
export default function EmployeesPage() {
  const t = useTranslations('employees')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()

  // The "Ny anställd" modal is driven by the URL (?new=1) so every entry
  // point (the header button, the empty state, and the legacy
  // /salary/employees/new redirect) opens the same dialog, and the browser
  // back button closes it. Same pattern as /invoices.
  const showNewEmployee = searchParams.has('new')
  const closeNewEmployee = () => router.replace('/salary/employees', { scroll: false })
  const openNewEmployee = () => router.push('/salary/employees?new=1', { scroll: false })

  // Bumped after a create in the dialog so the effect refetches the list.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    async function load() {
      const res = await fetch('/api/salary/employees')
      if (res.ok) {
        const { data } = await res.json()
        setEmployees(data || [])
      }
      setLoading(false)
    }
    load()
  }, [refreshKey])

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 28) */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        {canWrite && (
          <Button onClick={openNewEmployee}>
            <Plus className="mr-2 h-4 w-4" />
            {t('new_employee')}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : employees.length === 0 ? (
        <EmptyState
          icon={UserCircle}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('add_employee') : undefined}
          onAction={canWrite ? openNewEmployee : undefined}
        />
      ) : (
        <div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-full')}>{t('th_name')}</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('th_personnummer')}</th>
                  <th className={TH_CLASS}>{t('th_type')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('th_salary')}</th>
                  <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('th_employment_degree')}</th>
                  <th className={cn(TH_CLASS, 'hidden text-right md:table-cell')}>{t('th_tax_table')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {employees.map(emp => (
                  <tr
                    key={emp.id}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                    onClick={() => router.push(`/salary/employees/${emp.id}`)}
                  >
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <Link
                        href={`/salary/employees/${emp.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {emp.first_name} {emp.last_name}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground md:table-cell')}>
                      {emp.personnummer}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                      {EMPLOYMENT_LABEL_KEYS[emp.employment_type]
                        ? t(EMPLOYMENT_LABEL_KEYS[emp.employment_type])
                        : emp.employment_type}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums sensitive-field')}>
                      {emp.salary_type === 'hourly'
                        ? emp.hourly_rate ? `${formatCurrency(emp.hourly_rate)}${t('hourly_suffix')}` : '-'
                        : emp.monthly_salary ? formatCurrency(emp.monthly_salary) : '-'}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums sm:table-cell')}>
                      {emp.employment_degree}%
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground md:table-cell')}>
                      {emp.tax_table_number ? t('tax_table_format', { table: emp.tax_table_number, column: emp.tax_column ?? '' }) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Footer note (concept pgnote) */}
          <p className="px-1 pt-3 text-xs text-muted-foreground tabular-nums">
            {t('registered_count', { count: employees.length })}
          </p>
        </div>
      )}

      {showNewEmployee && (
        <NewEmployeeDialog
          open
          onOpenChange={(open) => {
            if (!open) closeNewEmployee()
          }}
          onCreated={() => {
            closeNewEmployee()
            setRefreshKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}
