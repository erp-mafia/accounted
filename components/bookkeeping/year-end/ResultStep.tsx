'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import type { YearEndResult, ContinuityDiscrepancy } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

interface ResultStepProps {
  result: YearEndResult
}

const ORE_TOLERANCE = 0.005

export function ResultStep({ result }: ResultStepProps) {
  const [acknowledged, setAcknowledged] = useState(false)

  const continuity = result.continuity
  const discrepancies = continuity?.discrepancies ?? []

  // If the wizard reached ResultStep, executeYearEndClosing already enforced
  // that no per-account diff exceeded ORE_TOLERANCE: but surface a panel
  // grouped by BAS class so the user can confirm visually before leaving.
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10">
            <CheckCircle2 className="h-7 w-7 text-success" />
          </div>
          <h2 className="font-display text-2xl">Bokslutet är klart</h2>
          <p className="text-muted-foreground">
            Perioden är stängd och en ny räkenskapsperiod har skapats.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resultat</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ResultRow
            label="Bokslutsverifikation"
            value={formatVoucher(result.closingEntry)}
            href={`/bookkeeping/${result.closingEntry.id}`}
          />
          {result.revaluationEntry && (
            <ResultRow
              label="Kursrevaluering"
              value={formatVoucher(result.revaluationEntry)}
              href={`/bookkeeping/${result.revaluationEntry.id}`}
            />
          )}
          <ResultRow
            label="Ingående balanser i ny period"
            value={formatVoucher(result.openingBalanceEntry)}
            href={`/bookkeeping/${result.openingBalanceEntry.id}`}
          />
          {result.resultAppropriationEntry && (
            <ResultRow
              label="Omföring av föregående års resultat (2099 → 2098)"
              value={formatVoucher(result.resultAppropriationEntry)}
              href={`/bookkeeping/${result.resultAppropriationEntry.id}`}
            />
          )}
          <ResultRow label="Ny räkenskapsperiod" value={result.nextPeriod.name} />
        </CardContent>
      </Card>

      {result.resultAppropriationFailed && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
            <p className="text-sm">
              <span className="font-medium">
                Omföringen av föregående års resultat (2099 → 2098) kunde inte bokföras.
              </span>{' '}
              Bokslutet och de ingående balanserna är klara, men konto 2099 “Årets
              resultat” bär fortfarande föregående års resultat in i den nya perioden.
              Det måste flyttas till 2098 innan balansräkningen stämmer. Kör om bokslutet
              eller kontakta support: felet är loggat.
            </p>
          </CardContent>
        </Card>
      )}

      {continuity && (
        <ContinuityPanel
          discrepancies={discrepancies}
          checkedAccounts={continuity.checked_accounts}
        />
      )}

      <Card>
        <CardContent className="p-6 space-y-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              className="mt-0.5"
              aria-label="Bekräfta bokslut"
            />
            <span className="text-sm leading-relaxed">
              Jag har granskat bokslutet och IB/UB-kontinuiteten ovan, och
              bekräftar att alla balanskonton stämmer mot föregående periods
              utgående balans.
            </span>
          </label>

          <div className="flex flex-col sm:flex-row gap-3 sm:justify-end">
            <Button variant="outline" asChild disabled={!acknowledged}>
              <Link
                href="/bookkeeping"
                aria-disabled={!acknowledged}
                tabIndex={acknowledged ? undefined : -1}
                className={!acknowledged ? 'pointer-events-none opacity-50' : ''}
              >
                Till bokföringen
              </Link>
            </Button>
            <Button variant="outline" asChild disabled={!acknowledged}>
              <Link
                href="/reports"
                aria-disabled={!acknowledged}
                tabIndex={acknowledged ? undefined : -1}
                className={!acknowledged ? 'pointer-events-none opacity-50' : ''}
              >
                Generera rapporter
              </Link>
            </Button>
            <Button asChild disabled={!acknowledged}>
              <Link
                href={`/bookkeeping/year-end/arsredovisning?period=${result.closingEntry.fiscal_period_id}`}
                aria-disabled={!acknowledged}
                tabIndex={acknowledged ? undefined : -1}
                className={!acknowledged ? 'pointer-events-none opacity-50' : ''}
              >
                Skapa årsredovisning
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ResultRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border last:border-b-0 pb-3 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      {href ? (
        <Link href={href} className="font-medium tabular-nums text-primary hover:underline">
          {value}
        </Link>
      ) : (
        <span className="font-medium tabular-nums">{value}</span>
      )}
    </div>
  )
}

interface ContinuityPanelProps {
  discrepancies: ContinuityDiscrepancy[]
  checkedAccounts: number
}

function ContinuityPanel({ discrepancies, checkedAccounts }: ContinuityPanelProps) {
  const grouped = useMemo(() => {
    const byClass = new Map<number, ContinuityDiscrepancy[]>()
    for (const d of discrepancies) {
      const klass = parseInt(d.account_number[0]) || 0
      if (klass !== 1 && klass !== 2) continue
      const list = byClass.get(klass) ?? []
      list.push(d)
      byClass.set(klass, list)
    }
    return byClass
  }, [discrepancies])

  const hasIssues = discrepancies.some(
    (d) => Math.abs(d.difference) > ORE_TOLERANCE
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">IB/UB-avstämning</CardTitle>
        {hasIssues ? (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="h-3 w-3" />
            Avvikelser
          </Badge>
        ) : (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Stämmer
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {checkedAccounts} balanskonto(n) jämförda mellan utgående balans i
          stängd period och ingående balans i ny period.
        </p>

        {discrepancies.length === 0 ? (
          <p className="text-sm">
            Inga avvikelser. Alla balanskonton i klass 1 och 2 matchar inom
            tolerans (±0,005 SEK).
          </p>
        ) : (
          <div className="space-y-6">
            {[1, 2].map((klass) => {
              const rows = grouped.get(klass) ?? []
              if (rows.length === 0) return null
              return (
                <div key={klass}>
                  <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Klass {klass}: {klass === 1 ? 'Tillgångar' : 'Skulder & eget kapital'}
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Konto</TableHead>
                        <TableHead className="text-right">UB (föregående)</TableHead>
                        <TableHead className="text-right">IB (ny period)</TableHead>
                        <TableHead className="text-right">Diff</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((d) => {
                        const overTol = Math.abs(d.difference) > ORE_TOLERANCE
                        return (
                          <TableRow key={d.account_number}>
                            <TableCell className="font-medium tabular-nums">
                              {d.account_number}
                              <span className="ml-2 font-normal text-muted-foreground">
                                {d.account_name}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(d.previous_ub_net)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(d.current_ib_net)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(d.difference)}
                            </TableCell>
                            <TableCell className="text-right">
                              {overTol ? (
                                <Badge variant="destructive">Avviker</Badge>
                              ) : (
                                <Badge variant="success">OK</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
