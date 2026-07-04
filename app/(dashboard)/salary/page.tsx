'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Users, HandCoins, CalendarDays, ArrowRight } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import NewSalaryRunDialog from '@/components/salary/NewSalaryRunDialog'
import type { SalaryRun } from '@/types'

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'status_draft',
  review: 'status_review',
  approved: 'status_approved',
  paid: 'status_paid',
  booked: 'status_booked',
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  draft: 'secondary',
  review: 'warning',
  approved: 'default',
  paid: 'success',
  booked: 'success',
}

export default function SalaryPage() {
  const [runs, setRuns] = useState<SalaryRun[]>([])
  const [employeeCount, setEmployeeCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('salary')

  // The "Ny lönekörning" modal is driven by the URL (?new=1) so every entry
  // point (the header button, the empty state, and the legacy
  // /salary/runs/new redirect) opens the same dialog, and the browser back
  // button closes it. Same pattern as /invoices.
  const showNewRun = searchParams.has('new')
  const closeNewRun = () => router.replace('/salary', { scroll: false })
  const openNewRun = () => router.push('/salary?new=1', { scroll: false })

  useEffect(() => {
    async function load() {
      const [runsRes, empRes] = await Promise.all([
        fetch('/api/salary/runs'),
        fetch('/api/salary/employees'),
      ])

      if (runsRes.ok) {
        const { data } = await runsRes.json()
        setRuns(data || [])
      }
      if (empRes.ok) {
        const { data } = await empRes.json()
        setEmployeeCount((data || []).length)
      }
      setLoading(false)
    }
    load()
  }, [])

  const currentYear = new Date().getFullYear()
  const yearRuns = runs.filter(r => r.period_year === currentYear)
  const totalGrossYTD = yearRuns.filter(r => r.status === 'booked').reduce((sum, r) => sum + r.total_gross, 0)
  const totalAvgifterYTD = yearRuns.filter(r => r.status === 'booked').reduce((sum, r) => sum + r.total_avgifter, 0)
  const latestRun = runs[0]

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/salary/employees">
                <Users className="mr-2 h-4 w-4" />
                {t('employees')}
              </Link>
            </Button>
            {canWrite && (
              <Button onClick={openNewRun}>
                <Plus className="mr-2 h-4 w-4" />
                {t('new_run')}
              </Button>
            )}
          </div>
        }
      />

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('employees')}</p>
                <p className="text-2xl font-semibold tabular-nums">{employeeCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <HandCoins className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('gross_year', { year: currentYear })}</p>
                <p className="text-2xl font-semibold tabular-nums">{formatCurrency(totalGrossYTD)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <CalendarDays className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">{t('contributions_year', { year: currentYear })}</p>
                <p className="text-2xl font-semibold tabular-nums">{formatCurrency(totalAvgifterYTD)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent runs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('runs_title')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title={t('empty_runs_title')}
              description={t('empty_runs_description')}
              actionLabel={canWrite ? t('create_run') : undefined}
              onAction={canWrite ? openNewRun : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('th_period')}</TableHead>
                  <TableHead>{t('th_payday')}</TableHead>
                  <TableHead className="text-right">{t('th_gross')}</TableHead>
                  <TableHead className="text-right">{t('th_net')}</TableHead>
                  <TableHead className="text-right">{t('th_contributions')}</TableHead>
                  <TableHead>{t('th_status')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.slice(0, 12).map(run => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium tabular-nums">
                      {run.period_year}-{String(run.period_month).padStart(2, '0')}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDate(run.payment_date)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(run.total_gross)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(run.total_net)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(run.total_avgifter)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'}>
                        {STATUS_LABEL_KEYS[run.status] ? t(STATUS_LABEL_KEYS[run.status]) : run.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/salary/runs/${run.id}`} className="text-muted-foreground hover:text-foreground">
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <NewSalaryRunDialog
        open={showNewRun}
        onOpenChange={(open) => {
          if (!open) closeNewRun()
        }}
      />
    </div>
  )
}
