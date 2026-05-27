'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  assessJamkningEligibility,
  computeJamkningAmount,
} from '@/lib/bokslut/assets/jamkning'
import type { Asset, FiscalPeriod, VatTreatment } from '@/types'

interface PeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

const VAT_TREATMENT_OPTIONS: { value: VatTreatment; label: string; rate: number | null }[] = [
  { value: 'standard_25', label: 'Standard 25 %', rate: 0.25 },
  { value: 'reduced_12', label: 'Reducerad 12 %', rate: 0.12 },
  { value: 'reduced_6', label: 'Reducerad 6 %', rate: 0.06 },
  { value: 'reverse_charge', label: 'Omvänd skattskyldighet', rate: null },
  { value: 'export', label: 'Export (utanför EU)', rate: null },
  { value: 'exempt', label: 'Momsfri', rate: null },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default function DisposeAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [asset, setAsset] = useState<Asset | null>(null)
  const [periods, setPeriods] = useState<PeriodOption[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // Form state
  const [disposalDate, setDisposalDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [proceeds, setProceeds] = useState<string>('')
  const [vatTreatment, setVatTreatment] = useState<VatTreatment>('standard_25')
  const [vatAmount, setVatAmount] = useState<string>('')
  const [vatAutoCalc, setVatAutoCalc] = useState(true)
  const [periodId, setPeriodId] = useState<string>('')
  const [proceedsAccount, setProceedsAccount] = useState<string>('1930')

  // Jämkning state
  const [jamkningEnabled, setJamkningEnabled] = useState(false)
  const [originalInputVat, setOriginalInputVat] = useState<string>('')

  // Load asset + periods
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/assets`).then((r) => r.json()),
      fetch('/api/bookkeeping/fiscal-periods').then((r) => r.json()),
    ])
      .then(([assetsRes, periodsRes]) => {
        if (cancelled) return
        const assets: Asset[] = assetsRes.data ?? []
        const found = assets.find((a) => a.id === id) ?? null
        setAsset(found)
        const periodList: PeriodOption[] = (periodsRes.data ?? []).map((p: FiscalPeriod) => ({
          id: p.id,
          name: p.name,
          period_start: p.period_start,
          period_end: p.period_end,
          is_closed: p.is_closed,
          locked_at: p.locked_at,
        }))
        setPeriods(periodList)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          toast({
            title: 'Kunde inte ladda',
            description: 'Försök igen.',
            variant: 'destructive',
          })
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [id, toast])

  // Auto-select matching fiscal period when disposalDate changes.
  useEffect(() => {
    if (!disposalDate || periods.length === 0) return
    const match = periods.find(
      (p) => disposalDate >= p.period_start && disposalDate <= p.period_end,
    )
    if (match && match.id !== periodId) setPeriodId(match.id)
  }, [disposalDate, periods, periodId])

  // Derived: VAT rate from treatment
  const selectedVatOpt = VAT_TREATMENT_OPTIONS.find((o) => o.value === vatTreatment)
  const proceedsNum = Number(proceeds) || 0
  const computedVat = useMemo(() => {
    if (!selectedVatOpt || selectedVatOpt.rate === null) return 0
    // Standard convention: proceeds is GROSS (incl VAT).
    // vat = gross × rate / (1 + rate)
    return round2((proceedsNum * selectedVatOpt.rate) / (1 + selectedVatOpt.rate))
  }, [proceedsNum, selectedVatOpt])

  // Auto-fill VAT amount when auto-calc is on.
  useEffect(() => {
    if (vatAutoCalc) {
      if (selectedVatOpt && selectedVatOpt.rate !== null) {
        setVatAmount(String(computedVat))
      } else {
        setVatAmount('0')
      }
    }
  }, [computedVat, selectedVatOpt, vatAutoCalc])

  // Jämkning eligibility — derived from asset + disposal date.
  const eligibility = useMemo(() => {
    if (!asset) return null
    return assessJamkningEligibility({
      basAssetAccount: asset.bas_asset_account,
      basExpenseAccount: asset.bas_expense_account,
      category: asset.category,
      acquisitionDate: asset.acquisition_date,
      disposalDate,
    })
  }, [asset, disposalDate])

  // Auto-enable jämkning toggle when disposal falls within the correction period.
  useEffect(() => {
    if (eligibility?.withinCorrectionPeriod && !jamkningEnabled) {
      setJamkningEnabled(true)
    }
  }, [eligibility?.withinCorrectionPeriod, jamkningEnabled])

  const originalInputVatNum = Number(originalInputVat) || 0
  const jamkningAmount = useMemo(() => {
    if (!jamkningEnabled || !eligibility) return 0
    return computeJamkningAmount({
      originalInputVat: originalInputVatNum,
      totalCorrectionMonths: eligibility.totalCorrectionMonths,
      remainingMonths: eligibility.remainingMonths,
      disposalEvent: 'triggers_jamkning',
    })
  }, [jamkningEnabled, eligibility, originalInputVatNum])

  const handleSubmit = useCallback(async () => {
    if (!asset || !periodId) return
    setSubmitting(true)
    const vatNum = Number(vatAmount) || 0
    const body: Record<string, unknown> = {
      disposed_at: disposalDate,
      disposed_proceeds: proceedsNum,
      fiscal_period_id: periodId,
      proceeds_account: proceedsAccount,
    }
    if (vatNum > 0) {
      body.proceeds_vat = vatNum
      body.vat_treatment = vatTreatment
    }
    if (jamkningEnabled && jamkningAmount > 0 && eligibility) {
      body.jamkning_amount = jamkningAmount
      body.jamkning_remaining_months = eligibility.remainingMonths
      body.jamkning_total_months = eligibility.totalCorrectionMonths
      body.jamkning_original_input_vat = originalInputVatNum
    }

    try {
      const res = await fetch(`/api/assets/${id}/dispose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Avyttring misslyckades',
          description: getErrorMessage(json?.error ?? json) || 'Försök igen.',
          variant: 'destructive',
        })
        return
      }
      toast({
        title: 'Tillgång avyttrad',
        description: 'Verifikat skapat.',
      })
      router.push('/assets')
    } catch (err) {
      toast({
        title: 'Avyttring misslyckades',
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [
    asset,
    disposalDate,
    eligibility,
    id,
    jamkningAmount,
    jamkningEnabled,
    originalInputVatNum,
    periodId,
    proceedsAccount,
    proceedsNum,
    router,
    toast,
    vatAmount,
    vatTreatment,
  ])

  if (loading) {
    return (
      <div className="space-y-8">
        <PageHeader title="Avyttra tillgång" />
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!asset) {
    return (
      <div className="space-y-8">
        <PageHeader title="Avyttra tillgång" />
        <Card>
          <CardContent className="p-6">
            <p>Tillgången kunde inte hittas.</p>
            <div className="mt-4">
              <Link href="/assets">
                <Button variant="secondary">
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Tillbaka
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (asset.disposed_at) {
    return (
      <div className="space-y-8">
        <PageHeader title="Avyttra tillgång" />
        <Card>
          <CardContent className="p-6">
            <p className="mb-4">
              Tillgången är redan avyttrad ({formatDate(asset.disposed_at)}).
            </p>
            <Link href="/assets">
              <Button variant="secondary">
                <ArrowLeft className="mr-1 h-4 w-4" />
                Tillbaka
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const netProceeds = round2(proceedsNum - (Number(vatAmount) || 0))
  const isVatLineTreatment = selectedVatOpt?.rate !== null
  const selectedPeriod = periods.find((p) => p.id === periodId)
  const periodLocked = selectedPeriod
    ? selectedPeriod.is_closed || selectedPeriod.locked_at !== null
    : false

  return (
    <div className="space-y-8">
      <PageHeader
        title="Avyttra tillgång"
        action={
          <Link href="/assets">
            <Button variant="secondary">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Tillbaka
            </Button>
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{asset.name}</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Anskaffningsvärde</span>
            <span className="tabular-nums">{formatCurrency(Number(asset.acquisition_cost))}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Anskaffat</span>
            <span className="tabular-nums">{formatDate(asset.acquisition_date)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Konton (BAS)</span>
            <span className="tabular-nums">
              {asset.bas_asset_account} / {asset.bas_accumulated_account} / {asset.bas_expense_account}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Avyttringsuppgifter</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="disposalDate">Avyttringsdatum</Label>
              <Input
                id="disposalDate"
                type="date"
                value={disposalDate}
                onChange={(e) => setDisposalDate(e.target.value)}
                className="tabular-nums"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="period">Räkenskapsperiod</Label>
              <Select value={periodId} onValueChange={setPeriodId}>
                <SelectTrigger id="period">
                  <SelectValue placeholder="Välj period" />
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => {
                    const locked = p.is_closed || p.locked_at !== null
                    return (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {locked ? ' (låst)' : ''}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {periodLocked && (
                <p className="text-xs text-destructive">
                  Vald period är låst eller stängd — välj en öppen period.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="proceeds">Erhållet belopp (inkl. moms)</Label>
              <Input
                id="proceeds"
                inputMode="decimal"
                value={proceeds}
                onChange={(e) => setProceeds(e.target.value)}
                placeholder="0,00"
                className="tabular-nums"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="proceedsAccount">Mottagarkonto</Label>
              <Input
                id="proceedsAccount"
                value={proceedsAccount}
                onChange={(e) => setProceedsAccount(e.target.value)}
                placeholder="1930"
                className="tabular-nums"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Moms vid avyttring (ML 3 kap 3 §)</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="vatTreatment">Momsbehandling</Label>
              <Select
                value={vatTreatment}
                onValueChange={(v) => setVatTreatment(v as VatTreatment)}
              >
                <SelectTrigger id="vatTreatment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VAT_TREATMENT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="vatAmount">Utgående moms</Label>
              <Input
                id="vatAmount"
                inputMode="decimal"
                value={vatAmount}
                onChange={(e) => {
                  setVatAutoCalc(false)
                  setVatAmount(e.target.value)
                }}
                placeholder="0,00"
                disabled={!isVatLineTreatment}
                className="tabular-nums"
              />
              {isVatLineTreatment && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={vatAutoCalc}
                    onCheckedChange={setVatAutoCalc}
                    aria-label="Räkna ut moms automatiskt"
                  />
                  <span>Räkna ut moms automatiskt</span>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-md bg-secondary/40 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Brutto</span>
              <span className="tabular-nums">{formatCurrency(proceedsNum)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Moms</span>
              <span className="tabular-nums">{formatCurrency(Number(vatAmount) || 0)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Netto</span>
              <span className="tabular-nums">{formatCurrency(netProceeds)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jämkning av ingående moms (ML 8a kap)</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0 space-y-4">
          {eligibility?.withinCorrectionPeriod ? (
            <Badge variant="warning">
              Inom korrigeringstid ({eligibility.remainingMonths} mån kvar av{' '}
              {eligibility.totalCorrectionMonths})
            </Badge>
          ) : (
            <Badge variant="secondary">Utanför korrigeringstid — ingen jämkning behövs</Badge>
          )}

          <div className="flex items-center gap-3">
            <Switch
              id="jamkningEnabled"
              checked={jamkningEnabled}
              onCheckedChange={setJamkningEnabled}
              disabled={!eligibility?.withinCorrectionPeriod}
            />
            <Label htmlFor="jamkningEnabled" className="cursor-pointer">
              Bokför jämkning
            </Label>
          </div>

          {jamkningEnabled && eligibility?.withinCorrectionPeriod && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="originalInputVat">Ursprungligt ingående momsavdrag</Label>
                  <Input
                    id="originalInputVat"
                    inputMode="decimal"
                    value={originalInputVat}
                    onChange={(e) => setOriginalInputVat(e.target.value)}
                    placeholder="0,00"
                    className="tabular-nums"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Korrigeringstid</Label>
                  <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm tabular-nums">
                    {eligibility.totalCorrectionMonths} mån
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Återstående månader</Label>
                  <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm tabular-nums">
                    {eligibility.remainingMonths} mån
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Beräknad jämkning</Label>
                  <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm tabular-nums font-medium">
                    {formatCurrency(jamkningAmount)}
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Jämkningen bokförs som kredit på 2641 (återförd ingående moms) och debet på
                förlustkontot för tillgångsklassen.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Link href="/assets">
          <Button variant="secondary" disabled={submitting}>
            Avbryt
          </Button>
        </Link>
        <Button
          onClick={handleSubmit}
          disabled={
            !canWrite ||
            submitting ||
            !periodId ||
            periodLocked ||
            proceedsNum < 0 ||
            (proceeds !== '' && Number.isNaN(proceedsNum))
          }
          title={!canWrite ? 'Endast användare med skrivrättigheter kan avyttra tillgångar.' : undefined}
        >
          {!canWrite && <Lock className="mr-1 h-4 w-4" />}
          {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Avyttra
        </Button>
      </div>
    </div>
  )
}
