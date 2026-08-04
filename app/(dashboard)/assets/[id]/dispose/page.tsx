'use client'

import { use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Lock } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { assessJamkning, assessJamkningEligibility } from '@/lib/bokslut/assets/jamkning'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { Asset, AssetDisposalType, FiscalPeriod, VatTreatment } from '@/types'

interface PeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

const VAT_TREATMENTS = ['standard_25', 'reverse_charge', 'export', 'exempt'] as const

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
  const [periods, setPeriods] = useState<PeriodOption[]>([])
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
    Promise.all([
      fetch(`/api/assets/${id}`).then((response) => response.json()),
      fetch('/api/bookkeeping/fiscal-periods').then((response) => response.json()),
    ])
      .then(([assetResponse, periodsResponse]) => {
        if (cancelled) return
        setAsset(assetResponse.data ?? null)
        setPeriods(
          (periodsResponse.data ?? []).map((period: FiscalPeriod) => ({
            id: period.id,
            name: period.name,
            period_start: period.period_start,
            period_end: period.period_end,
            is_closed: period.is_closed,
            locked_at: period.locked_at,
          })),
        )
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
        <Card><CardContent className="space-y-3 p-6"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-4 w-2/3" /></CardContent></Card>
      </div>
    )
  }

  if (!asset || asset.disposed_at) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('title')} />
        <Card>
          <CardContent className="space-y-4 p-6">
            <p>{!asset ? t('not_found') : t('already_disposed', { date: formatDate(asset.disposed_at!) })}</p>
            <Link href="/assets"><Button variant="secondary"><ArrowLeft className="mr-1 h-4 w-4" />{t('back')}</Button></Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const transferNeedsDocument = jamkningAssessment?.direction === 'transferred'
  const missingJamkningData = possibleInvestmentGood &&
    (originalInputVat === '' || originalDeductionPercent === '')

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={<Link href="/assets"><Button variant="secondary"><ArrowLeft className="mr-1 h-4 w-4" />{t('back')}</Button></Link>}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">{asset.name}</CardTitle></CardHeader>
        <CardContent className="space-y-2 p-6 pt-0 text-sm">
          <SummaryRow label={t('acquisition_cost')} value={formatCurrency(Number(asset.acquisition_cost))} />
          <SummaryRow label={t('acquired')} value={formatDate(asset.acquisition_date)} />
          <SummaryRow label={t('bas_accounts')} value={`${asset.bas_asset_account} / ${asset.bas_accumulated_account} / ${asset.bas_expense_account}`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t('details_title')}</CardTitle></CardHeader>
        <CardContent className="grid gap-4 p-6 pt-0 md:grid-cols-2">
          <Field label={t('type_label')} htmlFor="disposalType">
            <Select value={disposalType} onValueChange={(value) => setDisposalType(value as AssetDisposalType)}>
              <SelectTrigger id="disposalType"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sale">{t('type_sale')}</SelectItem>
                <SelectItem value="scrap">{t('type_scrap')}</SelectItem>
                <SelectItem value="business_transfer">{t('type_business_transfer')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('date_label')} htmlFor="disposalDate">
            <Input id="disposalDate" type="date" value={disposalDate} onChange={(event) => setDisposalDate(event.target.value)} className="tabular-nums" />
          </Field>
          <Field label={t('period_label')} htmlFor="period">
            <Select value={periodId} onValueChange={setPeriodId}>
              <SelectTrigger id="period"><SelectValue placeholder={t('period_placeholder')} /></SelectTrigger>
              <SelectContent>{periods.map((period) => <SelectItem key={period.id} value={period.id}>{period.name}{period.is_closed || period.locked_at ? ` (${t('locked')})` : ''}</SelectItem>)}</SelectContent>
            </Select>
            {periodLocked && <p className="text-xs text-destructive">{t('period_locked')}</p>}
          </Field>
          <Field label={disposalType === 'business_transfer' ? t('consideration_label') : t('proceeds_label')} htmlFor="proceeds">
            <Input id="proceeds" inputMode="decimal" value={proceeds} onChange={(event) => setProceeds(event.target.value)} disabled={disposalType === 'scrap'} className="tabular-nums" />
          </Field>
          {disposalType !== 'scrap' && <Field label={t('proceeds_account_label')} htmlFor="proceedsAccount"><Input id="proceedsAccount" value={proceedsAccount} onChange={(event) => setProceedsAccount(event.target.value)} className="tabular-nums" /></Field>}
        </CardContent>
      </Card>

      {disposalType === 'sale' && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('vat_title')}</CardTitle></CardHeader>
          <CardContent className="space-y-4 p-6 pt-0">
            <Field label={t('vat_treatment_label')} htmlFor="vatTreatment">
              <Select value={vatTreatment} onValueChange={(value) => setVatTreatment(value as VatTreatment)}>
                <SelectTrigger id="vatTreatment"><SelectValue /></SelectTrigger>
                <SelectContent>{VAT_TREATMENTS.map((value) => <SelectItem key={value} value={value}>{t(`vat_${value}`)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <div className="rounded-md bg-secondary/40 p-3 text-xs">
              <SummaryRow label={t('gross')} value={formatCurrency(proceedsNumber)} />
              <SummaryRow label={t('vat')} value={formatCurrency(vatAmount)} />
              <SummaryRow label={t('net')} value={formatCurrency(netProceeds)} strong />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{t('adjustment_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4 p-6 pt-0">
          {eligibility?.withinAdjustmentPeriod
            ? <Badge variant="warning">{t('within_adjustment_period', { years: eligibility.remainingYears, total: eligibility.totalYears })}</Badge>
            : <Badge variant="secondary">{t('outside_adjustment_period')}</Badge>}
          {eligibility?.withinAdjustmentPeriod && (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('original_vat_label')} htmlFor="originalInputVat" hint={t('original_vat_hint', { threshold: eligibility.threshold })}>
                <Input id="originalInputVat" inputMode="decimal" value={originalInputVat} onChange={(event) => setOriginalInputVat(event.target.value)} className="tabular-nums" />
              </Field>
              <Field label={t('original_percent_label')} htmlFor="originalDeductionPercent">
                <Input id="originalDeductionPercent" type="number" min={0} max={100} value={originalDeductionPercent} onChange={(event) => setOriginalDeductionPercent(event.target.value)} className="tabular-nums" />
              </Field>
            </div>
          )}
          {jamkningAssessment && (
            <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
              <SummaryRow label={t('adjustment_direction')} value={t(`direction_${jamkningAssessment.direction}`)} />
              <SummaryRow label={t('adjustment_amount')} value={formatCurrency(jamkningAssessment.amount)} strong />
              {jamkningAssessment.capped && <p className="mt-2 text-xs text-muted-foreground">{t('adjustment_capped')}</p>}
            </div>
          )}
          {disposalType === 'business_transfer' && (
            <div className="flex items-center gap-3 rounded-md border border-border p-3">
              <Switch id="businessTransfer" checked={businessTransferConfirmed} onCheckedChange={setBusinessTransferConfirmed} />
              <Label htmlFor="businessTransfer" className="cursor-pointer">{t('business_transfer_confirm')}</Label>
            </div>
          )}
          {disposalType === 'business_transfer' && transferNeedsDocument && (
            <div className="flex items-center gap-3 rounded-md border border-border p-3">
              <Switch id="adjustmentDocument" checked={adjustmentDocumentConfirmed} onCheckedChange={setAdjustmentDocumentConfirmed} />
              <Label htmlFor="adjustmentDocument" className="cursor-pointer">{t('adjustment_document_confirm')}</Label>
            </div>
          )}
          {missingJamkningData && <p className="text-xs text-destructive">{t('adjustment_data_required')}</p>}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
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

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={htmlFor}>{label}</Label>{children}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>
}

function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`flex justify-between gap-4 ${strong ? 'font-medium' : ''}`}><span className="text-muted-foreground">{label}</span><span className="text-right tabular-nums">{value}</span></div>
}
