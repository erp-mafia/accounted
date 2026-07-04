'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowRight } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils'
import type { YearEndPreview } from '@/types'

interface PreviewStepProps {
  preview: YearEndPreview | null
  isLoading: boolean
  error: string | null
  onBack: () => void
  onContinue: () => void
}

export function PreviewStep({ preview, isLoading, error, onBack, onContinue }: PreviewStepProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (!preview) return null

  const isProfit = preview.netResult > 0
  const isLoss = preview.netResult < 0

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Årets resultat</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-sm text-muted-foreground">
                Nettoresultat överförs till {preview.closingAccount} {preview.closingAccountName}
              </p>
              {isProfit && <Badge variant="success" className="mt-2">Vinst</Badge>}
              {isLoss && <Badge variant="destructive" className="mt-2">Förlust</Badge>}
            </div>
            <p className="font-display text-3xl tabular-nums">
              {formatCurrency(preview.netResult)}
            </p>
          </div>
        </CardContent>
      </Card>

      {preview.currencyRevaluation && preview.currencyRevaluation.items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kursrevaluering (ÅRL 4:13)</CardTitle>
            <p className="text-sm text-muted-foreground">
              Öppna fordringar/skulder i utländsk valuta värderas om till balansdagens kurs innan bokslut.
              Detta sker automatiskt som en del av verkställandet.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wider">Kursvinst</p>
                <p className="font-display text-xl tabular-nums">
                  {formatCurrency(preview.currencyRevaluation.totalGain)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wider">Kursförlust</p>
                <p className="font-display text-xl tabular-nums">
                  {formatCurrency(preview.currencyRevaluation.totalLoss)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wider">Nettoeffekt</p>
                <p className="font-display text-xl tabular-nums">
                  {formatCurrency(preview.currencyRevaluation.netEffect)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bokslutsverifikation: förhandsgranskning</CardTitle>
          <p className="text-sm text-muted-foreground">
            {preview.closingLines.length} kontorader. Nollställer klass 3-8 mot {preview.closingAccount}.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Konto</TableHead>
                <TableHead>Beskrivning</TableHead>
                <TableHead className="text-right">Debet</TableHead>
                <TableHead className="text-right">Kredit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.closingLines.map((line, i) => (
                <TableRow key={i}>
                  <TableCell className="tabular-nums">{line.account_number}</TableCell>
                  <TableCell className="text-sm">{line.line_description}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.debit_amount > 0 ? formatCurrency(line.debit_amount) : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.credit_amount > 0 ? formatCurrency(line.credit_amount) : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Tillbaka
        </Button>
        <Button onClick={onContinue}>
          Verkställ bokslut <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
