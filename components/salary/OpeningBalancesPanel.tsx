'use client'

/**
 * Ingående saldon (payroll cutover) panel on the employee editor.
 *
 * Mid-year switchers from another payroll system enter per-employee state
 * here: YTD accumulators, vacation balances (incl. sparade dagar per
 * origin year), opening semesterlöneskuld SEK, and the karens adjustment.
 * Locked (read-only) once the employee has a booked salary run; the lock
 * self-releases if that run is corrected.
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Save } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

interface OpeningBalancesData {
  cutover_date: string
  ytd_gross: number
  ytd_tax: number
  ytd_net: number
  vacation_paid_days_remaining: number
  vacation_days_taken_this_year: number
  vacation_saved_days_by_year: Record<string, number>
  opening_semester_liability: number
  opening_semester_liability_avgifter: number
  karens_periods_adjustment: number
  locked: boolean
  locked_by_run_id: string | null
}

const currentYear = new Date().getFullYear()
/** Sparade dagar origin years: Semesterlagen allows saving max 5 years. */
const SAVED_YEARS = Array.from({ length: 5 }, (_, i) => String(currentYear - 1 - i))

interface PanelValues {
  cutoverDate: string
  ytdGross: string
  ytdTax: string
  ytdNet: string
  daysRemaining: string
  daysTaken: string
  savedByYear: Record<string, string>
  liability: string
  liabilityAvgifter: string
  karens: string
}

/**
 * Stable serialization of the panel's field values, used to gate the save
 * button on actual edits. Empty saved-days entries equal absent entries, so
 * typing into a year and clearing it again returns the panel to clean.
 */
function fingerprint(v: PanelValues): string {
  const saved = Object.entries(v.savedByYear)
    .filter(([, days]) => days.trim() !== '')
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify({ ...v, savedByYear: saved })
}

export function OpeningBalancesPanel({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const t = useTranslations('salary_employee')
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [locked, setLocked] = useState(false)
  const [hasRow, setHasRow] = useState(false)

  const [cutoverDate, setCutoverDate] = useState(`${currentYear}-01-01`)
  const [ytdGross, setYtdGross] = useState('')
  const [ytdTax, setYtdTax] = useState('')
  const [ytdNet, setYtdNet] = useState('')
  const [daysRemaining, setDaysRemaining] = useState('')
  const [daysTaken, setDaysTaken] = useState('')
  const [savedByYear, setSavedByYear] = useState<Record<string, string>>({})
  const [liability, setLiability] = useState('')
  const [liabilityAvgifter, setLiabilityAvgifter] = useState('')
  const [karens, setKarens] = useState('')
  // Fingerprint of the last loaded/saved values: the save button stays
  // disabled until the fields actually differ from it.
  const [baseline, setBaseline] = useState(() =>
    fingerprint({
      cutoverDate: `${currentYear}-01-01`,
      ytdGross: '',
      ytdTax: '',
      ytdNet: '',
      daysRemaining: '',
      daysTaken: '',
      savedByYear: {},
      liability: '',
      liabilityAvgifter: '',
      karens: '',
    }),
  )

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const res = await fetch(`/api/salary/employees/${employeeId}/opening-balances`)
        if (!res.ok) return
        const { data } = (await res.json()) as { data: OpeningBalancesData | null }
        if (data) {
          const values: PanelValues = {
            cutoverDate: data.cutover_date,
            ytdGross: String(data.ytd_gross),
            ytdTax: String(data.ytd_tax),
            ytdNet: String(data.ytd_net),
            daysRemaining: String(data.vacation_paid_days_remaining),
            daysTaken: String(data.vacation_days_taken_this_year ?? 0),
            savedByYear: Object.fromEntries(
              Object.entries(data.vacation_saved_days_by_year ?? {}).map(([y, d]) => [y, String(d)]),
            ),
            liability: String(data.opening_semester_liability),
            liabilityAvgifter: String(data.opening_semester_liability_avgifter),
            karens: String(data.karens_periods_adjustment),
          }
          setHasRow(true)
          setLocked(data.locked)
          setCutoverDate(values.cutoverDate)
          setYtdGross(values.ytdGross)
          setYtdTax(values.ytdTax)
          setYtdNet(values.ytdNet)
          setDaysRemaining(values.daysRemaining)
          setDaysTaken(values.daysTaken)
          setSavedByYear(values.savedByYear)
          setLiability(values.liability)
          setLiabilityAvgifter(values.liabilityAvgifter)
          setKarens(values.karens)
          setBaseline(fingerprint(values))
        }
      } catch {
        // Network failure: the panel falls back to its empty form rather
        // than holding the skeleton forever; a retry happens on remount.
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [employeeId])

  const currentValues: PanelValues = {
    cutoverDate,
    ytdGross,
    ytdTax,
    ytdNet,
    daysRemaining,
    daysTaken,
    savedByYear,
    liability,
    liabilityAvgifter,
    karens,
  }
  const dirty = fingerprint(currentValues) !== baseline

  async function handleSave() {
    setSaving(true)
    const saved: Record<string, number> = {}
    for (const [year, value] of Object.entries(savedByYear)) {
      const days = parseFloat(value)
      if (Number.isFinite(days) && days > 0) saved[year] = days
    }

    const res = await fetch(`/api/salary/employees/${employeeId}/opening-balances`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cutover_date: cutoverDate,
        ytd_gross: parseFloat(ytdGross) || 0,
        ytd_tax: parseFloat(ytdTax) || 0,
        ytd_net: parseFloat(ytdNet) || 0,
        vacation_paid_days_remaining: parseFloat(daysRemaining) || 0,
        vacation_days_taken_this_year: parseFloat(daysTaken) || 0,
        vacation_saved_days_by_year: saved,
        opening_semester_liability: parseFloat(liability) || 0,
        opening_semester_liability_avgifter: parseFloat(liabilityAvgifter) || 0,
        karens_periods_adjustment: parseInt(karens, 10) || 0,
      }),
    })

    if (res.ok) {
      setHasRow(true)
      setBaseline(fingerprint(currentValues))
      toast({ title: t('opening_balances_saved') })
    } else {
      const result = await res.json()
      toast({
        title: t('opening_balances_save_failed'),
        description: getErrorMessage(result, { statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('opening_balances_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    )
  }

  const readOnly = locked || !canWrite

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('opening_balances_title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('opening_balances_description')}</p>
      </CardHeader>
      {/* Own form: this panel is its own save scope. It must never be nested
          inside another form (invalid HTML, and its submit would leak). */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleSave()
        }}
      >
        <CardContent className="space-y-6">
        {locked && (
          <p className="text-sm text-muted-foreground border border-border rounded-lg p-3">
            {t('opening_balances_locked_notice')}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ob-cutover">{t('opening_balances_cutover_date')}</Label>
            <Input
              id="ob-cutover"
              type="date"
              value={cutoverDate}
              onChange={(e) => setCutoverDate(e.target.value)}
              disabled={readOnly}
            />
            <p className="text-xs text-muted-foreground">{t('opening_balances_cutover_hint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-karens">{t('opening_balances_karens')}</Label>
            <Input
              id="ob-karens"
              type="number"
              min={0}
              max={10}
              step={1}
              value={karens}
              onChange={(e) => setKarens(e.target.value)}
              disabled={readOnly}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">{t('opening_balances_karens_hint')}</p>
          </div>
        </div>

        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-3">
            {t('opening_balances_ytd_heading')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ob-ytd-gross">{t('opening_balances_ytd_gross')}</Label>
              <Input id="ob-ytd-gross" type="number" min={0} value={ytdGross}
                onChange={(e) => setYtdGross(e.target.value)} disabled={readOnly} className="tabular-nums" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-ytd-tax">{t('opening_balances_ytd_tax')}</Label>
              <Input id="ob-ytd-tax" type="number" min={0} value={ytdTax}
                onChange={(e) => setYtdTax(e.target.value)} disabled={readOnly} className="tabular-nums" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-ytd-net">{t('opening_balances_ytd_net')}</Label>
              <Input id="ob-ytd-net" type="number" min={0} value={ytdNet}
                onChange={(e) => setYtdNet(e.target.value)} disabled={readOnly} className="tabular-nums" />
            </div>
          </div>
        </div>

        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-3">
            {t('opening_balances_vacation_heading')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ob-days-remaining">{t('opening_balances_days_remaining')}</Label>
              <Input id="ob-days-remaining" type="number" min={0} max={40} step={0.5} value={daysRemaining}
                onChange={(e) => setDaysRemaining(e.target.value)} disabled={readOnly} className="tabular-nums" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-days-taken">{t('opening_balances_days_taken')}</Label>
              <Input id="ob-days-taken" type="number" min={0} max={40} step={0.5} value={daysTaken}
                onChange={(e) => setDaysTaken(e.target.value)} disabled={readOnly} className="tabular-nums" />
              <p className="text-xs text-muted-foreground">{t('opening_balances_days_taken_hint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-liability">{t('opening_balances_liability')}</Label>
              <Input id="ob-liability" type="number" min={0} value={liability}
                onChange={(e) => setLiability(e.target.value)} disabled={readOnly} className="tabular-nums" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-liability-avgifter">{t('opening_balances_liability_avgifter')}</Label>
              <Input id="ob-liability-avgifter" type="number" min={0} value={liabilityAvgifter}
                onChange={(e) => setLiabilityAvgifter(e.target.value)} disabled={readOnly} className="tabular-nums" />
            </div>
          </div>
        </div>

        <div>
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-3">
            {t('opening_balances_saved_heading')}
          </h2>
          <p className="text-xs text-muted-foreground mb-3">{t('opening_balances_saved_hint')}</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {SAVED_YEARS.map((year) => (
              <div key={year} className="space-y-2">
                <Label htmlFor={`ob-saved-${year}`} className="tabular-nums">{year}</Label>
                <Input
                  id={`ob-saved-${year}`}
                  type="number"
                  min={0}
                  max={40}
                  step={0.5}
                  value={savedByYear[year] ?? ''}
                  onChange={(e) => setSavedByYear((prev) => ({ ...prev, [year]: e.target.value }))}
                  disabled={readOnly}
                  className="tabular-nums"
                />
              </div>
            ))}
          </div>
        </div>

        {!readOnly && (
          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !dirty}>
              <Save className="h-4 w-4 mr-2" />
              {saving
                ? t('opening_balances_saving')
                : hasRow
                  ? t('opening_balances_update')
                  : t('opening_balances_save')}
            </Button>
          </div>
        )}
        </CardContent>
      </form>
    </Card>
  )
}
