'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, ArrowLeft, UserCircle } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import type { Employee } from '@/types'

const EMPLOYMENT_LABEL_KEYS: Record<string, string> = {
  employee: 'employment_employee',
  company_owner: 'employment_company_owner',
  board_member: 'employment_board_member',
}

export default function EmployeesPage() {
  const t = useTranslations('employees')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const { canWrite } = useCanWrite()

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
  }, [])

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/salary" aria-label={t('back_to_payroll')}><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl tracking-tight">{t('title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('registered_count', { count: employees.length })}</p>
          </div>
        </div>
        {canWrite && (
          <Button asChild>
            <Link href="/salary/employees/new">
              <Plus className="mr-2 h-4 w-4" />
              {t('new_employee')}
            </Link>
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : employees.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={UserCircle}
              title={t('empty_title')}
              description={t('empty_description')}
              actionLabel={canWrite ? t('add_employee') : undefined}
              actionHref={canWrite ? '/salary/employees/new' : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('th_name')}</TableHead>
                  <TableHead>{t('th_personnummer')}</TableHead>
                  <TableHead>{t('th_type')}</TableHead>
                  <TableHead className="text-right">{t('th_salary')}</TableHead>
                  <TableHead className="text-right">{t('th_employment_degree')}</TableHead>
                  <TableHead>{t('th_tax_table')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map(emp => (
                  <TableRow key={emp.id}>
                    <TableCell>
                      <Link href={`/salary/employees/${emp.id}`} className="font-medium hover:underline">
                        {emp.first_name} {emp.last_name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {emp.personnummer}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {EMPLOYMENT_LABEL_KEYS[emp.employment_type]
                        ? t(EMPLOYMENT_LABEL_KEYS[emp.employment_type])
                        : emp.employment_type}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {emp.salary_type === 'hourly'
                        ? emp.hourly_rate ? `${formatCurrency(emp.hourly_rate)}${t('hourly_suffix')}` : '—'
                        : emp.monthly_salary ? formatCurrency(emp.monthly_salary) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {emp.employment_degree}%
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {emp.tax_table_number ? t('tax_table_format', { table: emp.tax_table_number, column: emp.tax_column ?? '' }) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
