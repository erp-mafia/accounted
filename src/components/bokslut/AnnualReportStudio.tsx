'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertCircle, CheckCircle2, FileClock, Loader2, LockKeyhole, Save } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useBranding } from '@/lib/branding/brand-context'
import type {
  AnnualReportComplianceIssue,
  AnnualReportProfile,
  AnnualReportValidationResult,
  AnnualReportVersionSummary,
} from '@/lib/bokslut/arsredovisning/compliance-types'

interface ComplianceResponse {
  profile: AnnualReportProfile
  eligibility: {
    k2_eligible: boolean
    digital_filing_eligible: boolean
    size_classification: 'smaller' | 'larger' | 'unknown'
    issues: AnnualReportComplianceIssue[]
    digital_issues: AnnualReportComplianceIssue[]
  }
  validation: AnnualReportValidationResult
  report_summary: {
    proposed_dividend: number
    distributable_equity: number
  }
}

interface AnnualReportStudioProps {
  periodId: string
  periodStart: string
  periodEnd: string
  framework: 'k2' | 'k3'
  hasUnsavedNarrative: boolean
  narrativeRevision: string | null
  onVersionsChanged?: (versions: AnnualReportVersionSummary[]) => void
  /** Blocking-issue count once the compliance check has loaded, null while loading. */
  onBlockingCountChanged?: (count: number | null) => void
}

type NullableBoolean = boolean | null

function BooleanQuestion({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: NullableBoolean
  onChange: (value: NullableBoolean) => void
}) {
  const t = useTranslations('annualReportStudio')
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value === null ? '' : value ? 'yes' : 'no'}
        onValueChange={(next) => onChange(next === 'yes')}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={t('choose')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="no">{t('no')}</SelectItem>
          <SelectItem value="yes">{t('yes')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function AnnualReportStudio({
  periodId,
  periodStart,
  periodEnd,
  framework,
  hasUnsavedNarrative,
  narrativeRevision,
  onVersionsChanged,
  onBlockingCountChanged,
}: AnnualReportStudioProps) {
  const t = useTranslations('annualReportStudio')
  const { appName } = useBranding()
  const { toast } = useToast()
  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null)
  const [profile, setProfile] = useState<AnnualReportProfile | null>(null)
  const [versions, setVersions] = useState<AnnualReportVersionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingVersion, setCreatingVersion] = useState<'snapshot' | 'finalize' | null>(null)

  const complianceUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/compliance`
  const versionsUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/versions`

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [complianceResponse, versionsResponse] = await Promise.all([
        fetch(complianceUrl),
        fetch(versionsUrl),
      ])
      const [complianceBody, versionsBody] = await Promise.all([
        complianceResponse.json(),
        versionsResponse.json(),
      ])
      if (!complianceResponse.ok) throw new Error(getUserErrorMessage(complianceBody.error))
      if (!versionsResponse.ok) throw new Error(getUserErrorMessage(versionsBody.error))
      setCompliance(complianceBody.data as ComplianceResponse)
      setProfile((complianceBody.data as ComplianceResponse).profile)
      const nextVersions = (versionsBody.data ?? []) as AnnualReportVersionSummary[]
      setVersions(nextVersions)
      onVersionsChanged?.(nextVersions)
    } catch (err) {
      toast({
        title: t('load_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [complianceUrl, versionsUrl, onVersionsChanged, t, toast])

  useEffect(() => {
    void load()
  }, [load, narrativeRevision])

  const showNewK2Questions =
    periodStart > '2025-12-31' || (periodStart > '2025-06-30' && periodEnd >= '2026-12-31')
  const blockingIssues = useMemo(
    () => compliance?.validation.issues.filter((issue) => issue.severity === 'error') ?? [],
    [compliance],
  )
  // The signature section further down explains why "Låst version" is empty
  // in terms of this count, so it must not read 0 while we are still loading.
  useEffect(() => {
    onBlockingCountChanged?.(compliance ? blockingIssues.length : null)
  }, [compliance, blockingIssues.length, onBlockingCountChanged])
  const digitalOnlyIssues = useMemo(() => {
    const generalCodes = new Set(compliance?.validation.issues.map((issue) => issue.code) ?? [])
    return (
      compliance?.eligibility.digital_issues.filter((issue) => !generalCodes.has(issue.code)) ?? []
    )
  }, [compliance])

  const updateProfile = <K extends keyof AnnualReportProfile>(
    key: K,
    value: AnnualReportProfile[K],
  ) => {
    setProfile((current) => (current ? { ...current, [key]: value } : current))
  }

  const saveProfile = async () => {
    if (!profile) return
    setSaving(true)
    try {
      const response = await fetch(complianceUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_public_limited_company: profile.is_public_limited_company,
          is_in_liquidation: profile.is_in_liquidation,
          securities_traded_on_regulated_market:
            profile.securities_traded_on_regulated_market,
          is_parent_company: profile.is_parent_company,
          parent_group_size: profile.is_parent_company ? profile.parent_group_size : null,
          prepares_consolidated_accounts: profile.is_parent_company
            ? profile.prepares_consolidated_accounts
            : null,
          has_foreign_branch: profile.has_foreign_branch,
          has_crypto_assets: profile.has_crypto_assets,
          has_share_based_payments: profile.has_share_based_payments,
          has_convertible_debt: profile.has_convertible_debt,
          building_revenue_share_pct: profile.building_revenue_share_pct,
          has_material_deferred_tax: profile.has_material_deferred_tax,
          reporting_currency: profile.reporting_currency,
          auditor_report_required: profile.auditor_report_required,
          auditor_report_included: profile.auditor_report_included,
          dividend_prudence_confirmed: profile.dividend_prudence_confirmed,
          k2_assessment_confirmed: true,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(getUserErrorMessage(body.error))
      const next = body.data as ComplianceResponse
      setCompliance(next)
      setProfile(next.profile)
      toast({ title: t('scope_saved') })
    } catch (err) {
      toast({
        title: t('save_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const confirmNarrative = async () => {
    if (hasUnsavedNarrative) {
      toast({ title: t('save_content_first'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const response = await fetch(complianceUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ narrative_confirmed: true }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(getUserErrorMessage(body.error))
      const next = body.data as ComplianceResponse
      setCompliance(next)
      setProfile(next.profile)
      toast({ title: t('content_confirmed') })
    } catch (err) {
      toast({
        title: t('save_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const confirmSignerRoster = async () => {
    setSaving(true)
    try {
      const response = await fetch(complianceUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signer_roster_confirmed: true }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(getUserErrorMessage(body.error))
      const next = body.data as ComplianceResponse
      setCompliance(next)
      setProfile(next.profile)
      toast({ title: t('signer_roster_confirmed') })
    } catch (err) {
      toast({
        title: t('save_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const createVersion = async (action: 'snapshot' | 'finalize') => {
    if (hasUnsavedNarrative) {
      toast({ title: t('save_content_first'), variant: 'destructive' })
      return
    }
    setCreatingVersion(action)
    try {
      const response = await fetch(versionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await response.json()
      if (!response.ok) {
        if (body.error?.details?.issues) {
          setCompliance((current) =>
            current
              ? { ...current, validation: body.error.details as AnnualReportValidationResult }
              : current,
          )
        }
        throw new Error(getUserErrorMessage(body.error))
      }
      toast({ title: action === 'finalize' ? t('version_locked') : t('snapshot_created') })
      await load()
    } catch (err) {
      toast({
        title: action === 'finalize' ? t('lock_error') : t('snapshot_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setCreatingVersion(null)
    }
  }

  if (loading || !profile || !compliance) {
    return (
      <div className="flex min-h-24 items-center justify-center px-1 py-6 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3 px-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-sans text-sm font-medium">{t('title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
          </div>
          {blockingIssues.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('no_blockers')}</span>
          ) : (
            <Badge variant="warning">{t('blocker_count', { count: blockingIssues.length })}</Badge>
          )}
        </div>
        {framework === 'k3' && <AttnLine>{t('k3_draft_notice')}</AttnLine>}
        <div className="grid gap-2 sm:grid-cols-4">
          {[
            [
              t('step_scope'),
              compliance.eligibility.issues.every((issue) => issue.severity !== 'error'),
            ],
            [t('step_content'), Boolean(profile.narrative_confirmed_at)],
            [t('step_signatures'), versions.some((version) => version.status === 'signed')],
            [t('step_filing'), versions.some((version) => ['filed', 'registered'].includes(version.status))],
          ].map(([label, complete], index) => (
            <div key={String(label)} className="flex items-center gap-2 border-b border-border/60 px-1 py-2 text-sm">
              {complete ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              ) : (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-xs">
                  {index + 1}
                </span>
              )}
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('scope_title')}</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <p className="px-1 text-sm text-muted-foreground">{t('scope_description', { appName })}</p>
        <div className="space-y-6 px-1 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <BooleanQuestion
              id="ar-public"
              label={t('public_company')}
              value={profile.is_public_limited_company}
              onChange={(value) => updateProfile('is_public_limited_company', value)}
            />
            <BooleanQuestion
              id="ar-liquidation"
              label={t('in_liquidation')}
              value={profile.is_in_liquidation}
              onChange={(value) => updateProfile('is_in_liquidation', value)}
            />
            <BooleanQuestion
              id="ar-listed"
              label={t('listed_securities')}
              value={profile.securities_traded_on_regulated_market}
              onChange={(value) => updateProfile('securities_traded_on_regulated_market', value)}
            />
            <BooleanQuestion
              id="ar-parent"
              label={t('parent_company')}
              value={profile.is_parent_company}
              onChange={(value) => updateProfile('is_parent_company', value)}
            />
            <BooleanQuestion
              id="ar-audit"
              label={t('audit_required')}
              value={profile.auditor_report_required}
              onChange={(value) => updateProfile('auditor_report_required', value)}
            />
            <div className="space-y-2">
              <Label htmlFor="ar-reporting-currency">{t('reporting_currency')}</Label>
              <Select
                value={profile.reporting_currency}
                onValueChange={(next) =>
                  updateProfile(
                    'reporting_currency',
                    next as AnnualReportProfile['reporting_currency'],
                  )
                }
              >
                <SelectTrigger id="ar-reporting-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SEK">SEK</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {profile.auditor_report_required && (
              <BooleanQuestion
                id="ar-auditor-report-included"
                label={t('auditor_report_included')}
                value={profile.auditor_report_included}
                onChange={(value) => updateProfile('auditor_report_included', Boolean(value))}
              />
            )}
          </div>

          {profile.is_parent_company && (
            <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ar-group-size">{t('group_size')}</Label>
                <Select
                  value={profile.parent_group_size ?? ''}
                  onValueChange={(next) =>
                    updateProfile(
                      'parent_group_size',
                      next as AnnualReportProfile['parent_group_size'],
                    )
                  }
                >
                  <SelectTrigger id="ar-group-size">
                    <SelectValue placeholder={t('choose')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">{t('group_small')}</SelectItem>
                    <SelectItem value="large">{t('group_large')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <BooleanQuestion
                id="ar-consolidated"
                label={t('consolidated_accounts')}
                value={profile.prepares_consolidated_accounts}
                onChange={(value) => updateProfile('prepares_consolidated_accounts', value)}
              />
            </div>
          )}

          {framework === 'k2' && showNewK2Questions && (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-sm font-medium">{t('k2_2026_title')}</p>
              <div className="grid gap-4 md:grid-cols-2">
                <BooleanQuestion id="ar-foreign-branch" label={t('foreign_branch')} value={profile.has_foreign_branch} onChange={(value) => updateProfile('has_foreign_branch', value)} />
                <BooleanQuestion id="ar-crypto" label={t('crypto_assets')} value={profile.has_crypto_assets} onChange={(value) => updateProfile('has_crypto_assets', value)} />
                <BooleanQuestion id="ar-share-payments" label={t('share_payments')} value={profile.has_share_based_payments} onChange={(value) => updateProfile('has_share_based_payments', value)} />
                <BooleanQuestion id="ar-convertible" label={t('convertible_debt')} value={profile.has_convertible_debt} onChange={(value) => updateProfile('has_convertible_debt', value)} />
                <BooleanQuestion id="ar-deferred-tax" label={t('material_deferred_tax')} value={profile.has_material_deferred_tax} onChange={(value) => updateProfile('has_material_deferred_tax', value)} />
                <div className="space-y-2">
                  <Label htmlFor="ar-building-revenue">{t('building_revenue')}</Label>
                  <Input
                    id="ar-building-revenue"
                    type="number"
                    min={0}
                    max={100}
                   
                    value={profile.building_revenue_share_pct ?? ''}
                    onChange={(event) =>
                      updateProfile(
                        'building_revenue_share_pct',
                        event.target.value === '' ? null : Number(event.target.value),
                      )
                    }
                  />
                </div>
              </div>
            </div>
          )}

          {compliance.report_summary.proposed_dividend > 0 && (
            <div className="space-y-3 border-t border-border pt-4">
              <BooleanQuestion
                id="ar-dividend-prudence"
                label={t('dividend_prudence')}
                value={profile.dividend_prudence_confirmed}
                onChange={(value) => updateProfile('dividend_prudence_confirmed', value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('dividend_prudence_description', {
                  dividend: compliance.report_summary.proposed_dividend,
                  equity: compliance.report_summary.distributable_equity,
                })}
              </p>
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={() => void saveProfile()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {t('save_scope')}
            </Button>
          </div>
        </div>
      </section>

      <section id="ar-fullstandighetskontroll" className="scroll-mt-24">
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('checks_title')}</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="space-y-4 px-1 pt-2">
          {blockingIssues.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> {t('no_blockers')}
            </div>
          ) : (
            <ul className="space-y-3">
              {blockingIssues.map((issue) => (
                <li key={issue.code} className="flex gap-3 text-sm">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div>
                    <p>{issue.message}</p>
                    {issue.remediation && <p className="mt-1 text-xs text-muted-foreground">{issue.remediation}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {digitalOnlyIssues.length > 0 && (
            <div className="space-y-2">
              <p className="text-[12.5px] font-medium leading-5 text-attn">{t('digital_checks_title')}</p>
              <ul className="space-y-2">
                {digitalOnlyIssues.map((issue) => (
                  <li key={issue.code} className="text-sm text-muted-foreground">
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-3 border-t border-border/60 pt-4">
            <Button
              variant="outline"
             
              onClick={() => void confirmSignerRoster()}
              disabled={saving || Boolean(profile.signer_roster_confirmed_at)}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {profile.signer_roster_confirmed_at
                ? t('signer_roster_confirmed')
                : t('confirm_signer_roster')}
            </Button>
            <Button
              variant="outline"
             
              onClick={() => void confirmNarrative()}
              disabled={saving || hasUnsavedNarrative || Boolean(profile.narrative_confirmed_at)}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {profile.narrative_confirmed_at ? t('content_confirmed') : t('confirm_content')}
            </Button>
            <Button variant="outline" onClick={() => void createVersion('snapshot')} disabled={creatingVersion !== null}>
              {creatingVersion === 'snapshot' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileClock className="mr-2 h-4 w-4" />}
              {t('create_snapshot')}
            </Button>
            <Button onClick={() => void createVersion('finalize')} disabled={creatingVersion !== null || blockingIssues.length > 0 || hasUnsavedNarrative}>
              {creatingVersion === 'finalize' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}
              {t('lock_version')}
            </Button>
          </div>
          {(blockingIssues.length > 0 || hasUnsavedNarrative) && (
            <p className="text-right text-xs leading-5 text-muted-foreground">
              {hasUnsavedNarrative
                ? t('lock_hint_unsaved')
                : t('lock_hint_blocked', { count: blockingIssues.length })}
            </p>
          )}
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('versions_title')}</h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="px-1 pt-2">
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('versions_empty')}</p>
          ) : (
            <div className="divide-y divide-border">
              {versions.map((version) => (
                <div key={version.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium">{t('version_label', { number: version.version_number })}</p>
                    <p className="text-xs text-muted-foreground">{version.content_hash.slice(0, 12)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={version.status === 'registered' ? 'success' : version.status === 'draft' ? 'outline' : 'secondary'}>
                      {t(`status_${version.status}`)}
                    </Badge>
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/pdf?version=${version.id}`} target="_blank" rel="noopener noreferrer">
                        {t('open_pdf')}
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
