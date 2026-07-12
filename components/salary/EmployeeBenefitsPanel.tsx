'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Trash2, Loader2 } from 'lucide-react'
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('benefits_title')}</CardTitle>
        {canWrite && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t('benefits_add')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('benefits_loading')}</p>
        ) : benefits.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">
            {t('benefits_empty')}
          </p>
        ) : (
          benefits.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('benefits_type')}</TableHead>
                  <TableHead>{t('benefits_description')}</TableHead>
                  <TableHead className="text-right">{t('benefits_value_per_month')}</TableHead>
                  <TableHead>{t('benefits_period')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {benefits.map(b => (
                  <TableRow key={b.id}>
                    <TableCell>{t(`benefits_type_${b.benefit_type}`)}</TableCell>
                    <TableCell className="text-muted-foreground">{b.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(b.monthly_value)}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums text-xs">
                      {formatDate(b.valid_from)}
                      {b.valid_to ? ` ${formatDate(b.valid_to)}` : ` ${t('benefits_ongoing')}`}
                    </TableCell>
                    <TableCell className="text-right">
                      {canWrite && (
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(b.id)} aria-label={t('benefits_remove')}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        )}

        {adding && (
          <div className="space-y-4 rounded-md border bg-muted/30 p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="valid_from">{t('benefits_valid_from')}</Label>
                <Input id="valid_from" type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="valid_to">{t('benefits_valid_to')}</Label>
                <Input id="valid_to" type="date" value={validTo} onChange={e => setValidTo(e.target.value)} />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={reset} disabled={submitting}>{t('form_cancel')}</Button>
              <Button size="sm" onClick={handleAdd} disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('form_save')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
