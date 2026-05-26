'use client'

import { useState, useCallback, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useExtensionData } from '@/lib/extensions/use-extension-data'
import { useToast } from '@/components/ui/use-toast'
import {
  Building2,
  CheckCircle,
  XCircle,
  MapPin,
  Mail,
  Phone,
  Settings,
  AlertTriangle,
  CalendarRange,
  ShieldCheck,
  Users,
  Receipt,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { TICCompanyProfile } from '@/extensions/general/tic/lib/tic-types'

function formatKSEK(value: number | null): string {
  if (value === null) return '—'
  return `${(value * 1000).toLocaleString('sv-SE')} kr`
}

function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${value.toFixed(1)} %`
}

function formatSek(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `${value.toLocaleString('sv-SE')} kr`
}

function formatIsoDate(iso: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

function statusColorToVariant(
  color: 'red' | 'yellow' | 'green' | 'neutral' | null
): 'destructive' | 'warning' | 'success' | 'secondary' {
  switch (color) {
    case 'red':
      return 'destructive'
    case 'yellow':
      return 'warning'
    case 'green':
      return 'success'
    default:
      return 'secondary'
  }
}

function toMs(epoch: number): number {
  // TIC returns epoch seconds; Date() expects milliseconds
  return epoch < 1e12 ? epoch * 1000 : epoch
}

function formatPeriod(start: number, end: number): string {
  const s = new Date(toMs(start))
  const e = new Date(toMs(end))
  const fmt = (d: Date) =>
    d.toLocaleDateString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${fmt(s)} – ${fmt(e)}`
}

function timeAgo(isoDate: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('time_just_now')
  if (minutes < 60) return t('time_minutes_ago', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time_hours_ago', { n: hours })
  const days = Math.floor(hours / 24)
  return t('time_days_ago', { n: days })
}

// Mirrors the live layout (two cards: company info + financials) so the
// transition from the route-level loading.tsx to data-loaded content has no
// visible reflow. Keep in sync with app/(dashboard)/e/[sector]/[slug]/loading.tsx.
function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-2">
              <Skeleton className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <Skeleton className="h-3.5 flex-1 max-w-[260px]" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3.5 w-48" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3.5 w-36" />
            </div>
            <div className="pt-2 border-t space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-44" />
            </div>
            <div className="pt-2 border-t space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-3 w-32 mt-2" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-44" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function TicWorkspace({ userId }: WorkspaceComponentProps) {
  const { getByKey, save, isLoading: isDataLoading } = useExtensionData('general', 'tic')
  const { toast } = useToast()
  const t = useTranslations('tic_workspace')
  const [profile, setProfile] = useState<TICCompanyProfile | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  const [noOrgNumber, setNoOrgNumber] = useState(false)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [initialLoad, setInitialLoad] = useState(true)

  // Load cached profile from extension data
  useEffect(() => {
    if (isDataLoading) return
    const cached = getByKey('company_profile')
    if (cached?.value) {
      setProfile(cached.value as unknown as TICCompanyProfile)
    }
    setInitialLoad(false)
  }, [isDataLoading, getByKey])

  const fetchProfile = useCallback(async () => {
    setIsFetching(true)
    setNoOrgNumber(false)
    setFetchFailed(false)

    try {
      // Get org_number from company settings
      const settingsRes = await fetch('/api/settings')
      if (!settingsRes.ok) {
        toast({ title: t('toast_settings_failed'), variant: 'destructive' })
        return
      }
      const { data: settings } = await settingsRes.json()
      const orgNumber = settings?.org_number

      if (!orgNumber) {
        setNoOrgNumber(true)
        return
      }

      const res = await fetch(
        `/api/extensions/ext/tic/profile?org_number=${encodeURIComponent(orgNumber)}`
      )

      if (!res.ok) {
        const { error } = await res.json()
        toast({ title: error ?? t('toast_profile_failed'), variant: 'destructive' })
        setFetchFailed(true)
        return
      }

      const { data } = await res.json()
      setProfile(data)
      await save('company_profile', data)
    } catch {
      toast({ title: t('toast_unexpected_error'), variant: 'destructive' })
      setFetchFailed(true)
    } finally {
      setIsFetching(false)
    }
  }, [save, toast, t])

  // Auto-fetch on first visit when no cached data
  useEffect(() => {
    if (!initialLoad && !profile && !noOrgNumber && !isFetching && !fetchFailed) {
      fetchProfile()
    }
  }, [initialLoad, profile, noOrgNumber, isFetching, fetchFailed, fetchProfile])

  if (initialLoad || isDataLoading) {
    return <ProfileSkeleton />
  }

  if (noOrgNumber) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Settings className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <h3 className="text-lg font-medium text-foreground">
          {t('no_org_number_title')}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          {t('no_org_number_description')}
        </p>
        <Button variant="outline" className="mt-4" asChild>
          <Link href="/settings">{t('go_to_settings')}</Link>
        </Button>
      </div>
    )
  }

  if (isFetching && !profile) {
    return <ProfileSkeleton />
  }

  if (fetchFailed && !profile) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <XCircle className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <h3 className="text-lg font-medium text-foreground">
          {t('fetch_failed_title')}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          {t('fetch_failed_description')}
        </p>
        <div className="flex gap-3 mt-4">
          <Button variant="outline" asChild>
            <Link href="/settings">{t('settings')}</Link>
          </Button>
          <Button variant="outline" onClick={fetchProfile} disabled={isFetching}>
            {t('retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (!profile) return null

  const isActive = profile.activityStatus !== 'ceased'
  const registrations = [
    profile.registration.fTax && t('reg_f_tax'),
    profile.registration.vat && t('reg_vat'),
    profile.registration.payroll && t('reg_employer'),
  ].filter((label): label is string => Boolean(label))

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        {/* Company info card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              {profile.companyName}
            </CardTitle>
            <CardDescription>
              {profile.orgNumber} &middot; {profile.legalEntityType}
              {!isActive && (
                <span className="ml-2 text-destructive">&middot; {t('deregistered')}</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {profile.address && (
              <div className="flex items-start gap-2 text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  {[profile.address.street, `${profile.address.postalCode} ${profile.address.city}`]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </div>
            )}
            {profile.email && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span>{profile.email}</span>
              </div>
            )}
            {profile.phone && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="h-3.5 w-3.5 shrink-0" />
                <span>{profile.phone}</span>
              </div>
            )}
            {registrations.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('registered_for')}</p>
                <p className="text-xs text-muted-foreground">{registrations.join(' · ')}</p>
              </div>
            )}
            {profile.sniCodes.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('sni_codes')}</p>
                <div className="space-y-0.5">
                  {profile.sniCodes
                    .filter((sni, i, arr) => arr.findIndex(s => s.code === sni.code) === i)
                    .map((sni) => (
                    <p key={sni.code} className="text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">{sni.code}</span>{' '}
                      {sni.name}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {profile.bankAccounts.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('bank_accounts')}</p>
                <div className="space-y-0.5">
                  {profile.bankAccounts.map((ba, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      <span className="capitalize">{ba.type}</span>:{' '}
                      <span className="font-mono tabular-nums">{ba.accountNumber}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}
            {profile.purpose && (
              <div className="pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-1">{t('purpose')}</p>
                <p className="text-xs text-muted-foreground">{profile.purpose}</p>
              </div>
            )}
            {(profile.employeeRange || profile.turnoverRange) && (
              <div className="pt-2 border-t">
                {profile.employeeRange && (
                  <p className="text-xs text-muted-foreground">
                    {t('employees_range', { range: profile.employeeRange })}
                  </p>
                )}
                {profile.turnoverRange && (
                  <p className="text-xs text-muted-foreground">
                    {t('turnover_range', { range: profile.turnoverRange })}
                  </p>
                )}
              </div>
            )}
            <p className="pt-2 text-xs text-muted-foreground/70">
              {t('updated_ago', { ago: timeAgo(profile.fetchedAt, t) })}
            </p>
          </CardContent>
        </Card>

        {/* Financials card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('latest_closing')}</CardTitle>
            {profile.financials && (
              <CardDescription>
                {formatPeriod(profile.financials.periodStart, profile.financials.periodEnd)}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {profile.financials ? (
              <div className="grid grid-cols-2 gap-4">
                <FinancialCell label={t('net_sales')} value={formatKSEK(profile.financials.netSalesK)} />
                <FinancialCell
                  label={t('operating_profit')}
                  value={formatKSEK(profile.financials.operatingProfitK)}
                  negative={(profile.financials.operatingProfitK ?? 0) < 0}
                />
                <FinancialCell label={t('total_assets')} value={formatKSEK(profile.financials.totalAssetsK)} />
                <FinancialCell
                  label={t('employees')}
                  value={profile.financials.numberOfEmployees !== null
                    ? String(profile.financials.numberOfEmployees)
                    : '—'}
                />
                <FinancialCell
                  label={t('operating_margin')}
                  value={formatPercent(profile.financials.operatingMargin)}
                  negative={(profile.financials.operatingMargin ?? 0) < 0}
                />
                <FinancialCell
                  label={t('equity_ratio')}
                  value={formatPercent(profile.financials.equityAssetsRatio)}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('no_financials')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Status entries — most recent first; usually 1-3 rows */}
      {profile.statuses.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              {t('status_section')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {profile.statuses.slice(0, 6).map((status, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={statusColorToVariant(status.color)}>
                      {status.description ?? status.code ?? '—'}
                    </Badge>
                    {status.isCeased && (
                      <span className="text-xs text-muted-foreground">
                        {t('deregistered')}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatIsoDate(status.statusDate)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Fiscal year + signatory side-by-side */}
      {(profile.fiscalYear || profile.signatory.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          {profile.fiscalYear && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarRange className="h-4 w-4" />
                  {t('fiscal_year_section')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="font-mono tabular-nums">
                  {t('fiscal_year_current', {
                    start: profile.fiscalYear.startMonthDay ?? '—',
                    end: profile.fiscalYear.endMonthDay ?? '—',
                  })}
                </p>
                {profile.fiscalYearHistory.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    {t('fiscal_year_changed', { n: profile.fiscalYearHistory.length - 1 })}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {profile.signatory.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('signatory_section')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {profile.signatory.map((s, i) => (
                  <p key={i} className="text-muted-foreground whitespace-pre-line">
                    {s.description}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Board summary + representatives */}
      {(profile.board || profile.representatives.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              {t('board_section')}
            </CardTitle>
            {profile.board && (
              <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {profile.board.numberOfBoardMembers !== null && (
                  <span>
                    {t('board_summary_members', { n: profile.board.numberOfBoardMembers })}
                  </span>
                )}
                {profile.board.numberOfDeputyBoardMembers !== null && profile.board.numberOfDeputyBoardMembers > 0 && (
                  <span>
                    {t('board_summary_deputies', { n: profile.board.numberOfDeputyBoardMembers })}
                  </span>
                )}
                {profile.board.hasVacancy && (
                  <Badge variant="warning" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {t('board_vacancy')}
                  </Badge>
                )}
                {profile.board.missingCEODate && (
                  <span className="text-warning">
                    {t('board_missing_ceo', { date: formatIsoDate(profile.board.missingCEODate) })}
                  </span>
                )}
                {profile.board.missingAuditor && (
                  <span className="text-warning">
                    {t('board_missing_auditor', { date: formatIsoDate(profile.board.missingAuditor) })}
                  </span>
                )}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {profile.representatives.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col_name')}</TableHead>
                    <TableHead>{t('col_position')}</TableHead>
                    <TableHead>{t('col_since')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profile.representatives.slice(0, 12).map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{p.name ?? '—'}</TableCell>
                      <TableCell className="text-sm">
                        {p.positionDescription ?? p.positionType ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatIsoDate(p.positionStart)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">{t('board_no_representatives')}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Payroll history — payroll2 array, newest first */}
      {profile.payrolls.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Receipt className="h-4 w-4" />
              {t('payroll_section')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col_payroll_period')}</TableHead>
                  <TableHead className="text-right">{t('col_payroll_employees')}</TableHead>
                  <TableHead className="text-right">{t('col_payroll_tax')}</TableHead>
                  <TableHead className="text-right">{t('col_payroll_personnel_costs')}</TableHead>
                  <TableHead className="text-right">{t('col_payroll_deviation')}</TableHead>
                  <TableHead className="text-right">{t('col_payroll_late_fees')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.payrolls.slice(0, 10).map((p, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono tabular-nums text-xs">
                      {p.periodStart && p.periodEnd
                        ? `${formatIsoDate(p.periodStart)} – ${formatIsoDate(p.periodEnd)}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {p.numberOfEmployees !== null ? p.numberOfEmployees.toFixed(0) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatSek(p.sumPayrollTax)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatSek(p.calculatedPersonnelCosts)}
                    </TableCell>
                    <TableCell
                      className={`text-right text-sm tabular-nums ${
                        p.deviation !== null && Math.abs(p.deviation) > 0.1
                          ? 'text-warning'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {p.deviation !== null ? `${(p.deviation * 100).toFixed(1)} %` : '—'}
                    </TableCell>
                    <TableCell
                      className={`text-right text-sm tabular-nums ${
                        (p.numberOfLateFeesForPeriod ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground'
                      }`}
                    >
                      {p.numberOfLateFeesForPeriod ?? 0}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Financial reports table */}
      {profile.financialReports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('annual_reports')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col_period')}</TableHead>
                  <TableHead>{t('col_title')}</TableHead>
                  <TableHead>{t('col_filed')}</TableHead>
                  <TableHead>{t('col_audited')}</TableHead>
                  <TableHead>{t('col_audit_opinion')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.financialReports
                  .filter((r) => !r.isInterimReport)
                  .sort((a, b) => {
                    const aEnd = a.periodEnd ? new Date(a.periodEnd).getTime() : 0
                    const bEnd = b.periodEnd ? new Date(b.periodEnd).getTime() : 0
                    return bEnd - aEnd
                  })
                  .slice(0, 10)
                  .map((report, i) => (
                    <TableRow key={report.financialReportSummaryId ?? i}>
                      <TableCell className="font-mono tabular-nums text-xs">
                        {report.periodStart && report.periodEnd
                          ? `${report.periodStart.slice(0, 10)} – ${report.periodEnd.slice(0, 10)}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-xs">{report.title ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {report.arrivalDate
                          ? new Date(report.arrivalDate).toLocaleDateString('sv-SE')
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {report.isAudited === true ? (
                          <CheckCircle className="h-3.5 w-3.5 text-success" />
                        ) : report.isAudited === false ? (
                          <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{report.auditOpinion ?? '—'}</TableCell>
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

function FinancialCell({
  label,
  value,
  negative = false,
}: {
  label: string
  value: string
  negative?: boolean
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-medium tabular-nums ${
          negative ? 'text-destructive' : 'text-foreground'
        }`}
      >
        {value}
      </p>
    </div>
  )
}
