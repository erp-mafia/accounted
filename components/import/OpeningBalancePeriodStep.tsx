'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import type { FiscalPeriod } from '@/types'

interface EditableRow {
  id: string
  account_number: string
  account_name: string
  debit_amount: number
  credit_amount: number
}

interface OpeningBalancePeriodStepProps {
  rows: EditableRow[]
  /** `replace` is true when the selected period already has opening balances
   *  (the existing IB verifikat will be stornoed and replaced). */
  onExecute: (fiscalPeriodId: string, replace: boolean) => void
  onBack: () => void
  isLoading: boolean
  error: string | null
}

export default function OpeningBalancePeriodStep({
  rows,
  onExecute,
  onBack,
  isLoading,
  error,
}: OpeningBalancePeriodStepProps) {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('')
  const [loadingPeriods, setLoadingPeriods] = useState(true)

  // Compute totals
  let totalDebit = 0
  let totalCredit = 0
  for (const row of rows) {
    totalDebit = Math.round((totalDebit + row.debit_amount) * 100) / 100
    totalCredit = Math.round((totalCredit + row.credit_amount) * 100) / 100
  }

  useEffect(() => {
    async function fetchPeriods() {
      setLoadingPeriods(true)
      try {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        if (res.ok) {
          const data = await res.json()
          const allPeriods: FiscalPeriod[] = data.data || []
          setPeriods(allPeriods)

          // Auto-select first open period without OB
          const openPeriod = allPeriods.find(
            (p) => !p.is_closed && !p.locked_at && !p.opening_balances_set,
          )
          if (openPeriod) {
            setSelectedPeriodId(openPeriod.id)
          }
        }
      } catch {
        // Silent, user can still select period
      } finally {
        setLoadingPeriods(false)
      }
    }
    fetchPeriods()
  }, [])

  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId)
  const periodHasOB = !!selectedPeriod?.opening_balances_set
  const periodIsClosed = selectedPeriod?.is_closed
  const periodIsLocked = !!selectedPeriod?.locked_at

  // A period that already has IB can still be corrected, as long as it is open
  // and unlocked: the existing IB verifikat is stornoed and replaced.
  const canExecute =
    !!selectedPeriodId &&
    !periodIsClosed &&
    !periodIsLocked &&
    !isLoading

  const handleExecute = useCallback(() => {
    if (canExecute) {
      onExecute(selectedPeriodId, periodHasOB)
    }
  }, [canExecute, selectedPeriodId, periodHasOB, onExecute])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Välj räkenskapsperiod</CardTitle>
        <CardDescription>
          Välj vilken räkenskapsperiod de ingående balanserna ska bokföras på.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Period selector */}
        <div className="space-y-2">
          <Label>Räkenskapsperiod</Label>
          {loadingPeriods ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Hämtar perioder...
            </div>
          ) : periods.length === 0 ? (
            <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
              <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <p className="text-sm text-warning">
                Inga räkenskapsperioder hittades. Skapa en räkenskapsperiod under Bokföring först.
              </p>
            </div>
          ) : (
            <Select value={selectedPeriodId} onValueChange={setSelectedPeriodId}>
              <SelectTrigger>
                <SelectValue placeholder="Välj period" />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={p.is_closed || !!p.locked_at}>
                    {p.name} ({p.period_start} till {p.period_end})
                    {p.opening_balances_set && ', har redan IB'}
                    {p.is_closed && ', stängd'}
                    {p.locked_at && !p.is_closed && ', låst'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Replace notice: selecting a period that already has IB corrects it */}
        {periodHasOB && !periodIsClosed && !periodIsLocked && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
            <p className="text-sm text-warning">
              Denna period har redan ingående balanser. Om du fortsätter makuleras (stornas) den
              befintliga IB-verifikationen och en ny bokförs med beloppen nedan.
            </p>
          </div>
        )}

        {/* Summary */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <h4 className="text-sm font-medium">Sammanfattning</h4>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <span className="text-muted-foreground">Antal konton:</span>
            <span className="tabular-nums text-right">{rows.length}</span>
            <span className="text-muted-foreground">Total debet:</span>
            <span className="tabular-nums text-right">
              {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK
            </span>
            <span className="text-muted-foreground">Total kredit:</span>
            <span className="tabular-nums text-right">
              {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK
            </span>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t text-sm">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <span className="text-success font-medium">Balanserar</span>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={onBack} disabled={isLoading}>
            Tillbaka
          </Button>
          <Button onClick={handleExecute} disabled={!canExecute}>
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {periodHasOB ? 'Ersätter...' : 'Bokför...'}
              </>
            ) : periodHasOB ? (
              'Ersätt ingående balanser'
            ) : (
              'Bokför ingående balanser'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
