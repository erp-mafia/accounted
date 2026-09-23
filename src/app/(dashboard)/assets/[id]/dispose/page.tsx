'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Lock } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { assessJamkning, assessJamkningEligibility } from '@/lib/bokslut/assets/jamkning'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { Asset, AssetDisposalType, VatTreatment } from '@/types'

interface PeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

const VAT_TREATMENTS = ['standard_25', 'reverse_charge', 'export', 'exempt'] as const

// Flat Fönster inputs are sized by the row; amounts, dates and account
// numbers get a fixed short width so the row does not stretch them.
const FIELD_CLASS = 'max-w-44 flex-none tabular-nums'

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// Accept Swedish-formatted amounts ("125 000,50") as well as dot decimals.
function parseAmount(raw: string): number | null {
  const normalized = raw.replace(/\s/g, '').replace(',', '.')
  if (normalized === '') return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

export default function DisposeAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('assets.disposal')
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [asset, setAsset] = useState<Asset | null>(null)
  // Periods from the session cache (lib/reference-data), narrowed to the
  // fields the picker needs.
  const { periods: fiscalPeriods } = useFiscalPeriods()
  const periods = useMemo<PeriodOption[]>(
    () =>
      fiscalPeriods.map((period) => ({
        id: period.id,
        name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        is_closed: period.is_closed,
        locked_at: period.locked_at,
      })),
    [fiscalPeriods],
  )
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [disposalType, setDisposalType] = useState<AssetDisposalType>('sale')
  const [disposalDate, setDisposalDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  )
  const [proceeds, setProceeds] = useState('')
  const [vatTreatment, setVatTreatment] = useState<VatTreatment>('standard_25')
  const [periodId, setPeriodId] = useState('')
  const [proceedsAccount, setProceedsAccount] = useState('1930')
  const [originalInputVat, setOriginalInputVat] = useState('')
  const [originalDeductionPercent, setOriginalDeductionPercent] = useState('100')
  const [businessTransferConfirmed, setBusinessTransferConfirmed] = useState(false)
  const [adjustmentDocumentConfirmed, setAdjustmentDocumentConfirmed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/assets/${id}`)
      .then((response) => response.json())
      .then((assetResponse) => {
        if (cancelled) return
        setAsset(assetResponse.data ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          toast({
            title: t('load_failed_title'),
            description: t('try_again'),
            variant: 'destructive',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, t, toast])

  useEffect(() => {
    const match = periods.find(
      (period) => disposalDate >= period.period_start && disposalDate <= period.period_end,
    )
    if (match) setPeriodId(match.id)
  }, [disposalDate, periods])

  useEffect(() => {
    if (disposalType === 'scrap') setProceeds('0')
    if (disposalType !== 'business_transfer') {
      setBusinessTransferConfirmed(false)
      setAdjustmentDocumentConfirmed(false)
    }
  }, [disposalType])

  const parsedProceeds = parseAmount(proceeds)
  const proceedsNumber = parsedProceeds ?? 0
  const proceedsInvalid =
    disposalType !== 'scrap' && proceeds.trim() !== '' && parsedProceeds === null
  const vatAmount =
    disposalType === 'sale' && vatTreatment === 'standard_25'
      ? round2(proceedsNumber * (0.25 / 1.25))
      : 0
  const netProceeds = round2(proceedsNumber - vatAmount)
  const selectedPeriod = periods.find((period) => period.id === periodId)
  const periodLocked = Boolean(
    selectedPeriod && (selectedPeriod.is_closed || selectedPeriod.locked_at !== null),
  )

  const eligibility = useMemo(() => {
    if (!asset) return null
    return assessJamkningEligibility({
      acquisitionDate: asset.acquisition_date,
      disposalDate,
      basAssetAccount: asset.bas_asset_account,
      category: asset.category,
    })
  }, [asset, disposalDate])
  const possibleInvestmentGood = Boolean(
    asset &&
      eligibility?.withinAdjustmentPeriod &&
      Number(asset.acquisition_cost) >= (eligibility.totalYears === 10 ? 400_000 : 200_000),
  )
  const jamkningAssessment = useMemo(() => {
    if (!asset || originalInputVat === '' || originalDeductionPercent === '') return null
    return assessJamkning({
      acquisitionDate: asset.acquisition_date,
      disposalDate,
      category: asset.category,
      basAssetAccount: asset.bas_asset_account,
      originalInputVat: Number(originalInputVat) || 0,
      originalDeductionPercent: Number(originalDeductionPercent) || 0,
      disposalType,
      vatTreatment: disposalType === 'sale' ? vatTreatment : undefined,
      netProceeds,
    })
  }, [
    asset,
    disposalDate,
    disposalType,
    netProceeds,
    originalDeductionPercent,
    originalInputVat,
    vatTreatment,
  ])

  const handleSubmit = useCallback(async () => {
    if (!asset || !periodId) return
    setSubmitting(true)
    const body: Record<string, unknown> = {
      disposal_type: disposalType,
      disposed_at: disposalDate,
      disposed_proceeds: disposalType === 'scrap' ? 0 : proceedsNumber,
      fiscal_period_id: periodId,
      proceeds_account: proceedsAccount,
    }
    if (disposalType === 'sale') body.vat_treatment = vatTreatment
    if (originalInputVat !== '' && originalDeductionPercent !== '') {
      body.jamkning_original_input_vat = Number(originalInputVat)
      body.jamkning_original_deduction_percent = Number(originalDeductionPercent)
    }
    if (disposalType === 'business_transfer') {
      body.business_transfer_confirmed = businessTransferConfirmed
      body.adjustment_document_confirmed = adjustmentDocumentConfirmed
    }

    try {
      const response = await fetch(`/api/assets/${id}/dispose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (!response.ok) {
        toast({
          title: t('submit_failed_title'),
          description: getErrorMessage(json?.error ?? json) || t('try_again'),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('success_title'), description: t('success_description') })
      router.push('/assets')
    } catch (error) {
      toast({
        title: t('submit_failed_title'),
        description: getErrorMessage(error),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [
    adjustmentDocumentConfirmed,
    asset,
    businessTransferConfirmed,
    disposalDate,
    disposalType,
    id,
    originalDeductionPercent,
    originalInputVat,
    periodId,
    proceedsAccount,
    proceedsNumber,
    router,
    t,
    toast,
    vatTreatment,
  ])

  if (loading) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('title')} />
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    )
  }

  if (!asset || asset.disposed_at) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('title')} />
        <p className="text-sm text-muted-foreground">
          {!asset ? t('not_found') : t('already_disposed', { date: formatDate(asset.disposed_at!) })}
        </p>
        <Link href="/assets"><Button variant="secondary"><ArrowLeft className="mr-1 h-4 w-4" />{t('back')}</Button></Link>
      </div>
    )
  }

  const transferNeedsDocument = jamkningAssessment?.direction === 'transferred'
  const missingJamkningData = possibleInvestmentGood &&
    (originalInputVat === '' || originalDeductionPercent === '')

  // Which rows the adjustment section shows, so the last one can drop its
  // hairline and the section never ends on a dangling rule.
  const showJamkningInputs = Boolean(eligibility?.withinAdjustmentPeriod)
  const showAssessment = jamkningAssessment !== null
  const showTransferConfirm = disposalType === 'business_transfer'
  const showDocumentConfirm = showTransferConfirm && transferNeedsDocument
  const assessmentIsLast = showAssessment && !showTransferConfirm
  const inputsAreLast = showJamkningInputs && !showAssessment && !showTransferConfirm

  return (
    <div className="space-y-8 stagger-enter">
      {/* Back link on its own quiet row, same as the register documents */}
      <Link
        href="/assets"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('back')}
      </Link>

      {/* data-ph-mask: the asset name is user data */}
      <PageHeader title={t('title')} description={<span data-ph-mask="">{asset.name}</span>} />

      {/* The asset being disposed: read-only context as plain rows */}
      <DetailSection kicker={t('asset_section')}>
        <DefRow label={t('acquisition_cost')}>
          <span className="tabular-nums">{formatCurrency(Number(asset.acquisition_cost))}</span>
        </DefRow>
        <DefRow label={t('acquired')}>
          <span className="tabular-nums">{formatDate(asset.acquisition_date)}</span>
        </DefRow>
        <DefRow label={t('bas_accounts')}>
          <span className="tabular-nums">
            {`${asset.bas_asset_account} / ${asset.bas_accumulated_account} / ${asset.bas_expense_account}`}
          </span>
        </DefRow>
      </DetailSection>

      {/* The disposal itself: flat hairline rows, label left, control right */}
      <DetailSection kicker={t('details_title')}>
        <SettingsRow label={t('type_label')} htmlFor="disposalType">
          <SettingsSelect
            id="disposalType"
            value={disposalType}
            onChange={(event) => setDisposalType(event.target.value as AssetDisposalType)}
          >
            <option value="sale">{t('type_sale')}</option>
            <option value="scrap">{t('type_scrap')}</option>
            <option value="business_transfer">{t('type_business_transfer')}</option>
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow label={t('date_label')} htmlFor="disposalDate" align="baseline">
          <SettingsInput
            id="disposalDate"
            type="date"
            value={disposalDate}
            onChange={(event) => setDisposalDate(event.target.value)}
            className={FIELD_CLASS}
          />
        </SettingsRow>
        <SettingsRow label={t('period_label')} htmlFor="period">
          <SettingsSelect id="period" value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
            <option value="" disabled>{t('period_placeholder')}</option>
            {periods.map((period) => (
              <option key={period.id} value={period.id}>
                {period.name}{period.is_closed || period.locked_at ? ` (${t('locked')})` : ''}
              </option>
            ))}
          </SettingsSelect>
          {periodLocked && <p className="basis-full text-xs text-destructive">{t('period_locked')}</p>}
        </SettingsRow>
        <SettingsRow
          label={disposalType === 'business_transfer' ? t('consideration_label') : t('proceeds_label')}
          htmlFor="proceeds"
          align="baseline"
          borderless={disposalType === 'scrap'}
        >
          <SettingsInput
            id="proceeds"
            inputMode="decimal"
            value={proceeds}
            onChange={(event) => setProceeds(event.target.value)}
            disabled={disposalType === 'scrap'}
            className={FIELD_CLASS}
          />
        </SettingsRow>
        {disposalType !== 'scrap' && (
          <SettingsRow label={t('proceeds_account_label')} htmlFor="proceedsAccount" align="baseline" borderless>
            <SettingsInput
              id="proceedsAccount"
              value={proceedsAccount}
              onChange={(event) => setProceedsAccount(event.target.value)}
              className={FIELD_CLASS}
            />
          </SettingsRow>
        )}
      </DetailSection>

      {disposalType === 'sale' && (
        <DetailSection kicker={t('vat_title')}>
          <SettingsRow label={t('vat_treatment_label')} htmlFor="vatTreatment">
            <SettingsSelect
              id="vatTreatment"
              value={vatTreatment}
              onChange={(event) => setVatTreatment(event.target.value as VatTreatment)}
            >
              {VAT_TREATMENTS.map((value) => (
                <option key={value} value={value}>{t(`vat_${value}`)}</option>
              ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label={t('gross')}>
            <span className="tabular-nums">{formatCurrency(proceedsNumber)}</span>
          </SettingsRow>
          <SettingsRow label={t('vat')}>
            <span className="tabular-nums">{formatCurrency(vatAmount)}</span>
          </SettingsRow>
          <SettingsRow label={t('net')} borderless>
            <span className="font-medium tabular-nums">{formatCurrency(netProceeds)}</span>
          </SettingsRow>
        </DetailSection>
      )}

      {/* Input VAT adjustment: the period status sits on the kicker line
          (a chip only when the asset is still inside the period), the
          underlag as rows, the assessment as read-only rows below. */}
      <DetailSection
        kicker={t('adjustment_title')}
        aside={
          eligibility?.withinAdjustmentPeriod ? (
            <Badge variant="warning">
              {t('within_adjustment_period', { years: eligibility.remainingYears, total: eligibility.totalYears })}
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t('outside_adjustment_period')}</span>
          )
        }
      >
        {showJamkningInputs && eligibility && (
          <>
            <SettingsRow
              label={t('original_vat_label')}
              htmlFor="originalInputVat"
              help={t('original_vat_hint', { threshold: eligibility.threshold })}
              align="baseline"
            >
              <SettingsInput
                id="originalInputVat"
                inputMode="decimal"
                value={originalInputVat}
                onChange={(event) => setOriginalInputVat(event.target.value)}
                className={FIELD_CLASS}
              />
            </SettingsRow>
            <SettingsRow
              label={t('original_percent_label')}
              htmlFor="originalDeductionPercent"
              align="baseline"
              borderless={inputsAreLast}
            >
              <SettingsInput
                id="originalDeductionPercent"
                type="number"
                min={0}
                max={100}
                value={originalDeductionPercent}
                onChange={(event) => setOriginalDeductionPercent(event.target.value)}
                className={FIELD_CLASS}
              />
            </SettingsRow>
          </>
        )}
        {jamkningAssessment && (
          <>
            <SettingsRow label={t('adjustment_direction')}>
              {t(`direction_${jamkningAssessment.direction}`)}
            </SettingsRow>
            <SettingsRow label={t('adjustment_amount')} borderless={assessmentIsLast}>
              <span className="font-medium tabular-nums">{formatCurrency(jamkningAssessment.amount)}</span>
              {jamkningAssessment.capped && (
                <SettingsRowNote className="basis-full">{t('adjustment_capped')}</SettingsRowNote>
              )}
            </SettingsRow>
          </>
        )}
        {showTransferConfirm && (
          <SettingsRow label={t('type_business_transfer')} borderless={!showDocumentConfirm}>
            <Switch
              id="businessTransfer"
              checked={businessTransferConfirmed}
              onCheckedChange={setBusinessTransferConfirmed}
            />
            <Label htmlFor="businessTransfer" className="min-w-0 flex-1 cursor-pointer font-normal leading-5">
              {t('business_transfer_confirm')}
            </Label>
          </SettingsRow>
        )}
        {showDocumentConfirm && (
          <SettingsRow label={t('adjustment_document_label')} borderless>
            <Switch
              id="adjustmentDocument"
              checked={adjustmentDocumentConfirmed}
              onCheckedChange={setAdjustmentDocumentConfirmed}
            />
            <Label htmlFor="adjustmentDocument" className="min-w-0 flex-1 cursor-pointer font-normal leading-5">
              {t('adjustment_document_confirm')}
            </Label>
          </SettingsRow>
        )}
        {missingJamkningData && (
          <p className="mt-3 text-xs text-destructive">{t('adjustment_data_required')}</p>
        )}
      </DetailSection>

      {/* Actions: one footer row, so the flow ends on the button it arms */}
      <div className="flex flex-wrap justify-end gap-2">
        <Link href="/assets"><Button variant="secondary" disabled={submitting}>{t('cancel')}</Button></Link>
        <Button
          onClick={handleSubmit}
          disabled={!canWrite || submitting || !periodId || periodLocked || proceedsInvalid || missingJamkningData || (disposalType === 'business_transfer' && !businessTransferConfirmed) || (transferNeedsDocument && !adjustmentDocumentConfirmed)}
          title={!canWrite ? t('write_required') : undefined}
        >
          {!canWrite && <Lock className="mr-1 h-4 w-4" />}
          {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t('submit')}
        </Button>
      </div>
    </div>
  )
}
