'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from '@/components/ui/table'
import { Download, AlertCircle, AlertTriangle, FileText, ExternalLink } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type {
  PeriodiskSammanstallningReport,
  PsPeriodType,
  PsWarning,
} from '@/lib/reports/periodisk-sammanstallning'

function formatAmount(amount: number): string {
  // Hela kronor — SKV 5740 har inga öre.
  return amount.toLocaleString('sv-SE', { maximumFractionDigits: 0 })
}

function typeBadge(row: { services: number; goods: number; triangulation: number }) {
  const types: string[] = []
  if (row.services !== 0) types.push('Tjänster')
  if (row.goods !== 0) types.push('Varor')
  if (row.triangulation !== 0) types.push('Trepart')
  return types.join(' + ') || '—'
}

function deadlineLabel(end: string): string {
  // Inlämnas digitalt senast den 25:e månaden efter perioden.
  const endDate = new Date(end)
  const deadline = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 25)
  const months = [
    'januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december',
  ]
  return `${deadline.getDate()} ${months[deadline.getMonth()]} ${deadline.getFullYear()}`
}

export function PeriodiskSammanstallningView() {
  const currentYear = new Date().getFullYear()
  const currentMonth = new Date().getMonth() + 1
  const currentQuarter = Math.ceil(currentMonth / 3)

  const [periodType, setPeriodType] = useState<PsPeriodType>('quarterly')
  const [year, setYear] = useState(currentYear)
  const [period, setPeriod] = useState(currentQuarter)
  const [data, setData] = useState<PeriodiskSammanstallningReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i)

  const periodOptions = periodType === 'monthly'
    ? [
        { value: 1, label: 'Januari' }, { value: 2, label: 'Februari' },
        { value: 3, label: 'Mars' }, { value: 4, label: 'April' },
        { value: 5, label: 'Maj' }, { value: 6, label: 'Juni' },
        { value: 7, label: 'Juli' }, { value: 8, label: 'Augusti' },
        { value: 9, label: 'September' }, { value: 10, label: 'Oktober' },
        { value: 11, label: 'November' }, { value: 12, label: 'December' },
      ]
    : [
        { value: 1, label: 'Kvartal 1 (jan-mar)' },
        { value: 2, label: 'Kvartal 2 (apr-jun)' },
        { value: 3, label: 'Kvartal 3 (jul-sep)' },
        { value: 4, label: 'Kvartal 4 (okt-dec)' },
      ]

  useEffect(() => {
    setPeriod(periodType === 'monthly' ? currentMonth : currentQuarter)
  }, [periodType, currentMonth, currentQuarter])

  const fetchReport = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/reports/periodisk-sammanstallning?periodType=${periodType}&year=${year}&period=${period}`,
      )
      const result = await res.json()
      if (result.error) {
        setError(typeof result.error === 'string' ? result.error : result.error.message_sv ?? 'Något gick fel.')
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta periodisk sammanställning.')
    } finally {
      setLoading(false)
    }
  }

  const downloadCsv = () => {
    window.open(
      `/api/reports/periodisk-sammanstallning/csv?periodType=${periodType}&year=${year}&period=${period}`,
      '_blank',
    )
  }

  const errors = data?.warnings.filter(w => w.level === 'error') ?? []
  const cautions = data?.warnings.filter(w => w.level === 'warning') ?? []
  const hasBlockingErrors = errors.length > 0

  return (
    <div className="space-y-6">
      {/* Period selection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Välj period</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label>Periodicitet</Label>
              <select
                value={periodType}
                onChange={e => setPeriodType(e.target.value as PsPeriodType)}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="monthly">Månadsvis</option>
                <option value="quarterly">Kvartalsvis</option>
              </select>
            </div>
            <div>
              <Label>År</Label>
              <select
                value={year}
                onChange={e => setYear(parseInt(e.target.value))}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <Label>Period</Label>
              <select
                value={period}
                onChange={e => setPeriod(parseInt(e.target.value))}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {periodOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <Button onClick={fetchReport} disabled={loading}>
              {loading ? 'Laddar…' : 'Hämta'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-6 flex items-start gap-3 text-destructive">
            <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
            <div>{error}</div>
          </CardContent>
        </Card>
      )}

      {loading && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-32" />
          </CardContent>
        </Card>
      )}

      {data && !loading && (
        <>
          {/* Summary */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle>
                  Periodisk sammanställning — {data.period.label}
                </CardTitle>
                {data.totals.rowCount > 0 && (
                  <Badge variant={hasBlockingErrors ? 'destructive' : 'secondary'}>
                    {data.totals.rowCount} {data.totals.rowCount === 1 ? 'rad' : 'rader'}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">Tjänster (typ 3)</div>
                  <div className="font-display text-xl tabular-nums">
                    {formatAmount(data.totals.services)} kr
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">Varor (typ 1)</div>
                  <div className="font-display text-xl tabular-nums">
                    {formatAmount(data.totals.goods)} kr
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">Trepart (typ 2)</div>
                  <div className="font-display text-xl tabular-nums">
                    {formatAmount(data.totals.triangulation)} kr
                  </div>
                </div>
              </div>

              {/* Reconciliation */}
              {data.reconciliation.matches !== null && data.totals.rowCount > 0 && (
                <div className="text-sm text-muted-foreground border-t pt-3">
                  {data.reconciliation.matches ? (
                    <span className="text-foreground">
                      ✓ Stämmer mot momsdeklarationen
                      {' '}(Ruta 39: {formatAmount(data.reconciliation.ruta39 ?? 0)} kr,
                      {' '}Ruta 35: {formatAmount(data.reconciliation.ruta35 ?? 0)} kr,
                      {' '}Ruta 38: {formatAmount(data.reconciliation.ruta38 ?? 0)} kr)
                    </span>
                  ) : (
                    <span className="text-destructive">
                      ⚠ Avviker från momsdeklarationen — kontrollera bokföringen.
                      {' '}Ruta 39: {formatAmount(data.reconciliation.ruta39 ?? 0)} kr,
                      {' '}Ruta 35: {formatAmount(data.reconciliation.ruta35 ?? 0)} kr,
                      {' '}Ruta 38: {formatAmount(data.reconciliation.ruta38 ?? 0)} kr.
                    </span>
                  )}
                </div>
              )}
              {data.reconciliation.matches === null && data.totals.rowCount > 0 && (
                <div className="text-xs text-muted-foreground border-t pt-3">
                  Avstämning mot momsdeklarationen tillgänglig endast när PS-perioden sammanfaller med momsperioden.
                </div>
              )}

              {/* Deadline banner */}
              {data.totals.rowCount > 0 && (
                <div className="text-sm border-t pt-3">
                  <strong>Inlämnas digitalt senast den {deadlineLabel(data.period.end)}</strong>
                  {' '}via e-tjänsten hos Skatteverket. Förseningsavgift: 1 250 kr.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Errors */}
          {errors.length > 0 && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-base text-destructive flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  {errors.length} fel måste åtgärdas
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {errors.map((w, i) => <WarningItem key={i} warning={w} />)}
                <div className="text-xs text-muted-foreground pt-2 border-t">
                  CSV-nedladdning är blockerad tills alla fel åtgärdats.
                </div>
              </CardContent>
            </Card>
          )}

          {/* Warnings */}
          {cautions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2 text-foreground">
                  <AlertTriangle className="h-4 w-4" />
                  Varningar ({cautions.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {cautions.map((w, i) => <WarningItem key={i} warning={w} />)}
              </CardContent>
            </Card>
          )}

          {/* Table */}
          {data.rows.length > 0 ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Rader</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadCsv}
                  disabled={hasBlockingErrors}
                  title={hasBlockingErrors ? 'Åtgärda blockerande fel innan CSV kan laddas ner' : undefined}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Ladda ner CSV (SKV 5740)
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Land</TableHead>
                      <TableHead>VAT-nummer</TableHead>
                      <TableHead className="text-right">Tjänster</TableHead>
                      <TableHead className="text-right">Varor</TableHead>
                      <TableHead className="text-right">Trepart</TableHead>
                      <TableHead>Typ</TableHead>
                      <TableHead>Kund</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="tabular-nums font-mono text-xs">{row.country}</TableCell>
                        <TableCell className="tabular-nums font-mono text-xs">{row.vatNumber}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.services !== 0 ? formatAmount(row.services) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.goods !== 0 ? formatAmount(row.goods) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.triangulation !== 0 ? formatAmount(row.triangulation) : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{typeBadge(row)}</TableCell>
                        <TableCell className="text-xs">
                          {row.customerId
                            ? <Link href={`/customers/${row.customerId}`} className="underline-offset-4 hover:underline">{row.customerName ?? '—'}</Link>
                            : <span className="text-muted-foreground">—</span>
                          }
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/30 font-medium">
                      <TableCell colSpan={2}>Totalt</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(data.totals.services)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(data.totals.goods)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(data.totals.triangulation)}</TableCell>
                      <TableCell colSpan={2} />
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <EmptyState
              icon={FileText}
              title="Inga EU-försäljningar i perioden"
              description="Inga EU-försäljningar med omvänd skattskyldighet under denna period. Periodisk sammanställning behöver inte lämnas in."
            >
              <a
                href="https://www.skatteverket.se/foretag/skatterochavdrag/moms/periodisksammanstallning.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline underline-offset-4"
              >
                Läs mer hos Skatteverket
                <ExternalLink className="h-3 w-3" />
              </a>
            </EmptyState>
          )}
        </>
      )}
    </div>
  )
}

function WarningItem({ warning }: { warning: PsWarning }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground shrink-0">•</span>
      <div className="flex-1">
        <div>{warning.message}</div>
        {(warning.customerId || warning.invoiceId) && (
          <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
            {warning.customerId && (
              <Link href={`/customers/${warning.customerId}`} className="underline-offset-4 hover:underline">
                Öppna kund
              </Link>
            )}
            {warning.invoiceId && (
              <Link href={`/invoices/${warning.invoiceId}`} className="underline-offset-4 hover:underline">
                Öppna faktura
              </Link>
            )}
            {warning.amount !== undefined && (
              <span className="tabular-nums">{formatCurrency(warning.amount)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
