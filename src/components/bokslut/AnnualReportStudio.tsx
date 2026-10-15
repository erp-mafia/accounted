'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { AlertCircle, CheckCircle2, FileClock, LockKeyhole, Save } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
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
import {
  stepForIssue,
  type AnnualReportNextAction,
  type AnnualReportStepKey,
} from '@/lib/bokslut/arsredovisning/workflow-steps'
import { StepSectionHeader, annualReportStepAnchor } from '@/components/bokslut/StepSectionHeader'

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

/** What the page needs from the compliance check to derive the steps. */
export interface AnnualReportComplianceSummary {
  issues: AnnualReportComplianceIssue[]
  signerRosterConfirmed: boolean
}

interface AnnualReportStudioProps {
  periodId: string
  periodStart: string
  periodEnd: string
  framework: 'k2' | 'k3'
  hasUnsavedNarrative: boolean
  narrativeRevision: string | null
  /**
   * Bumped by the page after a change the server reacts to: adding or
   * removing a signer clears the roster confirmation.
   */
  refreshKey?: number
  /**
   * The inputs of step 3 (texts, disclosures, notes) and step 4 (board and
   * VD), owned by the page. Each is followed by what is still missing in
   * that step and the step's confirm button, so a step's inputs, its open
   * points and its action sit together in page order.
   */
  contentSection: ReactNode
  boardSection: ReactNode
  /** The next action on the page: only its button gets the primary style. */
  primaryAction: AnnualReportNextAction | null
  onVersionsChanged?: (versions: AnnualReportVersionSummary[]) => void
  /** The compliance check once it has loaded, null while loading. */
  onComplianceChanged?: (summary: AnnualReportComplianceSummary | null) => void
}

function IssueList({ issues }: { issues: AnnualReportComplianceIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul className="space-y-3">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="flex gap-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p>{issue.message}</p>
            {issue.remediation && <p className="mt-1 text-xs text-muted-foreground">{issue.remediation}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
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
  refreshKey = 0,
  contentSection,
  boardSection,
  primaryAction,
  onVersionsChanged,
  onComplianceChanged,
}: AnnualReportStudioProps) {
  const t = useTranslations('annualReportStudio')
  const tSteps = useTranslations('annualReportSteps')
  const { appName } = useBranding()
  const { toast } = useToast()
  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null)
  const [profile, setProfile] = useState<AnnualReportProfile | null>(null)
  const [versions, setVersions] = useState<AnnualReportVersionSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [creatingVersion, setCreatingVersion] = useState<'snapshot' | 'finalize' | null>(null)

  const complianceUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/compliance`
  const versionsUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/versions`

  // Reloads keep the current sections on screen: the page's own inputs
  // render inside this component, so a skeleton swap on every save would
  // unmount them and jump the scroll position.
  const load = useCallback(async () => {
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
    }
  }, [complianceUrl, versionsUrl, onVersionsChanged, t, toast])

  useEffect(() => {
    void load()
  }, [load, narrativeRevision, refreshKey])

  const showNewK2Questions =
    periodStart > '2025-12-31' || (periodStart > '2025-06-30' && periodEnd >= '2026-12-31')
  const blockingIssues = useMemo(
    () => compliance?.validation.issues.filter((issue) => issue.severity === 'error') ?? [],
    [compliance],
  )
  const issuesFor = (step: AnnualReportStepKey) =>
    blockingIssues.filter((issue) => stepForIssue(issue) === step)
  // The page derives the steps from this, so it must stay null (not "no
  // issues") while the check is still loading.
  useEffect(() => {
    onComplianceChanged?.(
      compliance
        ? {
            issues: compliance.validation.issues,
            signerRosterConfirmed: Boolean(compliance.profile.signer_roster_confirmed_at),
          }
        : null,
    )
  }, [compliance, onComplianceChanged])
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

  const ready = compliance !== null && profile !== null
  const variantFor = (action: AnnualReportNextAction) =>
    primaryAction === action ? ('default' as const) : ('outline' as const)
  const skeleton = (
    <div className="space-y-3 px-1 py-6" aria-busy="true" aria-label={t('loading')}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )

  return (
    <div className="space-y-8">
      {framework === 'k3' && (
        <div className="px-1">
          <AttnLine>{t('k3_draft_notice')}</AttnLine>
        </div>
      )}

      <section id={annualReportStepAnchor('scope')} className="scroll-mt-24">
        <StepSectionHeader step="scope" title={t('scope_title')} />
        {!ready ? (
          skeleton
        ) : (
          <>
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

              <IssueList issues={issuesFor('scope')} />

              <div className="flex justify-end">
                <Button variant={variantFor('save_scope')} onClick={() => void saveProfile()} loading={saving}>
                  {!saving && <Save className="mr-2 h-4 w-4" />}
                  {t('save_scope')}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <section id={annualReportStepAnchor('content')} className="scroll-mt-24">
        <StepSectionHeader step="content" title={tSteps('section_content')} />
        {contentSection}
        {ready && (
          <div className="space-y-4 px-1 pt-6">
            <IssueList issues={issuesFor('content')} />
            <div className="flex justify-end">
              <Button
                variant={variantFor('confirm_content')}
                onClick={() => void confirmNarrative()}
                disabled={saving || hasUnsavedNarrative || Boolean(profile.narrative_confirmed_at)}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {profile.narrative_confirmed_at ? t('content_confirmed') : t('confirm_content')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section id={annualReportStepAnchor('board')} className="scroll-mt-24">
        <StepSectionHeader step="board" title={tSteps('section_board')} />
        {boardSection}
        {ready && (
          <div className="space-y-4 px-1 pt-6">
            <IssueList issues={issuesFor('board')} />
            <div className="flex justify-end">
              <Button
                variant={variantFor('confirm_roster')}
                onClick={() => void confirmSignerRoster()}
                disabled={saving || Boolean(profile.signer_roster_confirmed_at)}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {profile.signer_roster_confirmed_at
                  ? t('signer_roster_confirmed')
                  : t('confirm_signer_roster')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section id={annualReportStepAnchor('lock')} className="scroll-mt-24">
        <StepSectionHeader step="lock" title={tSteps('section_lock')} />
        {!ready ? (
          skeleton
        ) : (
          <div className="space-y-4 px-1 pt-2">
            {blockingIssues.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4" /> {t('no_blockers')}
              </div>
            ) : (
              <IssueList issues={issuesFor('lock')} />
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
            {/* Two ways to freeze the document, explained side by side:
                the draft is a review copy, the lock is what gets signed. */}
            <div className="divide-y divide-border border-y border-border">
              <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="max-w-2xl">
                  <p className="text-sm font-medium">{tSteps('draft_title')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{tSteps('draft_body')}</p>
                </div>
                <Button
                  variant="outline"
                  className="w-full shrink-0 sm:w-auto"
                  onClick={() => void createVersion('snapshot')}
                  disabled={creatingVersion !== null}
                  loading={creatingVersion === 'snapshot'}
                >
                  {creatingVersion !== 'snapshot' && <FileClock className="mr-2 h-4 w-4" />}
                  {t('create_snapshot')}
                </Button>
              </div>
              <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="max-w-2xl">
                  <p className="text-sm font-medium">{tSteps('lock_title')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{tSteps('lock_body')}</p>
                  {(blockingIssues.length > 0 || hasUnsavedNarrative) && (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {hasUnsavedNarrative
                        ? t('lock_hint_unsaved')
                        : t('lock_hint_blocked', { count: blockingIssues.length })}
                    </p>
                  )}
                </div>
                <Button
                  variant={variantFor('lock_version')}
                  className="w-full shrink-0 sm:w-auto"
                  onClick={() => void createVersion('finalize')}
                  disabled={creatingVersion !== null || blockingIssues.length > 0 || hasUnsavedNarrative}
                  loading={creatingVersion === 'finalize'}
                >
                  {creatingVersion !== 'finalize' && <LockKeyhole className="mr-2 h-4 w-4" />}
                  {t('lock_version')}
                </Button>
              </div>
            </div>

            <div className="pt-2">
              <h4 className="text-sm font-medium">{t('versions_title')}</h4>
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
                        {version.status === 'registered' ? (
                          <span className="text-xs text-muted-foreground">{t(`status_${version.status}`)}</span>
                        ) : (
                          <Badge variant={version.status === 'draft' ? 'outline' : 'secondary'}>
                            {t(`status_${version.status}`)}
                          </Badge>
                        )}
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
          </div>
        )}
      </section>
    </div>
  )
}
