'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'

type BenefitType = 'bike' | 'car' | 'meals' | 'housing' | 'wellness' | 'other'

interface EmployeeBenefit {
  id: string
  benefit_type: BenefitType
  description: string
  monthly_value: number
  valid_from: string
  valid_to: string | null
  metadata: Record<string, unknown>
  is_active: boolean
}

// Swedish defaults written to the DB when the description is left empty:
// stored data stays Swedish regardless of the viewer's UI locale.
const BENEFIT_LABELS: Record<BenefitType, string> = {
  bike: 'Cykelförmån',
  car: 'Bilförmån',
  meals: 'Kostförmån',
  housing: 'Bostadsförmån',
  wellness: 'Friskvård (skattepliktig del)',
  other: 'Övrig förmån',
}

// In-row text action: underlined so it reads as an action next to plain
// values, the hairline underline darkening on hover (same idiom as the
// invoice detail rows).
const ROW_ACTION_CLASS =
  'text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-foreground disabled:opacity-50'

export function EmployeeBenefitsPanel({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const t = useTranslations('salary_employee')
  const { toast } = useToast()
  const [benefits, setBenefits] = useState<EmployeeBenefit[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [type, setType] = useState<BenefitType>('bike')
  const [description, setDescription] = useState('')
  const [monthlyValue, setMonthlyValue] = useState('')
  const [annualMarketValue, setAnnualMarketValue] = useState('')
  const [validFrom, setValidFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [validTo, setValidTo] = useState('')

  async function load() {
    setLoading(true)
    const res = await fetch(`/api/salary/employees/${employeeId}/benefits`)
    if (res.ok) {
      const { data } = await res.json()
      setBenefits(data || [])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId])

  function reset() {
    setType('bike')
    setDescription('')
    setMonthlyValue('')
    setAnnualMarketValue('')
    setValidFrom(new Date().toISOString().slice(0, 10))
    setValidTo('')
    setAdding(false)
  }

  async function handleAdd() {
    setSubmitting(true)
    const body: Record<string, unknown> = {
      benefit_type: type,
      description: description || BENEFIT_LABELS[type],
      valid_from: validFrom,
    }
    if (validTo) body.valid_to = validTo
    if (type === 'bike') {
      body.annual_market_value = parseFloat(annualMarketValue) || 0
    } else {
      body.monthly_value = parseFloat(monthlyValue) || 0
    }

    const res = await fetch(`/api/salary/employees/${employeeId}/benefits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      toast({ title: t('benefits_added') })
      reset()
      await load()
    } else {
      const result = await res.json()
      toast({
        title: t('benefits_save_failed'),
        description: getErrorMessage(result, { statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setSubmitting(false)
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/salary/employees/${employeeId}/benefits/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: t('benefits_removed') })
      await load()
    } else {
      toast({ title: t('benefits_remove_failed'), variant: 'destructive' })
    }
  }

  const previewMonthlyBike = (() => {
    const annual = parseFloat(annualMarketValue) || 0
    return Math.max(0, annual - 3000) / 12
  })()

  return (
    <DetailSection
      kicker={t('benefits_title')}
      help={<HelpPopover>{t('benefits_help')}</HelpPopover>}
      aside={
        canWrite ? (
          <Button type="button" size="sm" variant="outline" className="-my-1" onClick={() => setAdding(true)}>
            {t('benefits_add')}
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : benefits.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('benefits_empty')}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {benefits.map((b) => {
            const typeLabel = t(`benefits_type_${b.benefit_type}`)
            // The description defaults to the Swedish type label when left
            // empty on creation; repeating it next to the type says nothing.
            const showDescription =
              !!b.description &&
              b.description !== typeLabel &&
              b.description !== BENEFIT_LABELS[b.benefit_type]
            return (
              <li key={b.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 truncate">
                  {typeLabel}
                  {showDescription && (
                    <span className="text-muted-foreground">{' · '}{b.description}</span>
                  )}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatDate(b.valid_from)} → {b.valid_to ? formatDate(b.valid_to) : t('benefits_ongoing')}
                </span>
                <span className="ml-auto tabular-nums">
                  {formatCurrency(b.monthly_value)}
                  <span className="text-muted-foreground">{t('benefits_per_month')}</span>
                </span>
                {canWrite && (
                  <button type="button" onClick={() => handleDelete(b.id)} className={ROW_ACTION_CLASS}>
                    {t('benefits_remove')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Add dialog (convention 13: centered modal for create). Closing by
          Escape or backdrop is the same as Avbryt; both are held while a
          save is in flight. */}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!open && !submitting) reset()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('benefits_add')}</DialogTitle>
            <DialogDescription>{t('benefits_help')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="benefit_type">{t('benefits_type')}</Label>
                <Select value={type} onValueChange={(v) => setType(v as BenefitType)}>
                  <SelectTrigger id="benefit_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BENEFIT_LABELS) as BenefitType[]).map(k => (
                      <SelectItem key={k} value={k}>{t(`benefits_type_${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="benefit_description">{t('benefits_description')}</Label>
                <Input
                  id="benefit_description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t(`benefits_type_${type}`)}
                />
              </div>
            </div>

            {type === 'bike' ? (
              <div className="space-y-2">
                <Label htmlFor="annual_market_value">{t('benefits_annual_market_value')}</Label>
                <Input
                  id="annual_market_value"
                  type="number"
                  step="1"
                  min="0"
                  value={annualMarketValue}
                  onChange={e => setAnnualMarketValue(e.target.value)}
                  placeholder={t('benefits_annual_market_value_placeholder')}
                  className="max-w-xs"
                />
                <p className="text-xs text-muted-foreground">
                  {t('benefits_bike_hint')}
                  {parseFloat(annualMarketValue) > 0 && (
                    <span className="ml-1">
                      {t('benefits_monthly_value_preview')} <strong className="tabular-nums">{formatCurrency(previewMonthlyBike)}</strong>
                    </span>
                  )}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="monthly_value">{t('benefits_monthly_value')}</Label>
                <Input
                  id="monthly_value"
                  type="number"
                  step="1"
                  min="0"
                  value={monthlyValue}
                  onChange={e => setMonthlyValue(e.target.value)}
                  className="max-w-xs"
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="valid_from">{t('benefits_valid_from')}</Label>
                <Input id="valid_from" type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="valid_to">{t('benefits_valid_to')}</Label>
                <Input id="valid_to" type="date" value={validTo} onChange={e => setValidTo(e.target.value)} />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={reset} disabled={submitting}>{t('form_cancel')}</Button>
            <Button type="button" onClick={handleAdd} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('form_save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailSection>
  )
}
