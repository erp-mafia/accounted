'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
      <div className="space-y-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error) {
    return <p className="py-4 text-sm text-destructive">{error}</p>
  }

  if (!preview) return null

  const isProfit = preview.netResult > 0
  const isLoss = preview.netResult < 0

  return (
    <div className="space-y-6">
      <div className="px-1">
        <p className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Årets resultat
        </p>
        <div className="mt-1 flex items-baseline justify-between gap-4">
          <p
            className={`font-display text-2xl tabular-nums tracking-tight ${isLoss ? 'text-destructive' : ''}`}
          >
            {formatCurrency(preview.netResult)}
          </p>
          {isProfit && <span className="text-xs text-muted-foreground">Vinst</span>}
          {isLoss && <Badge variant="destructive" className="font-normal">Förlust</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Nettoresultat överförs till {preview.closingAccount} {preview.closingAccountName}
        </p>
      </div>

      {preview.bolagsskattMissing && (
        <p className="px-1 text-[12.5px] leading-5 text-attn">
          Året visar vinst men ingen skatt på årets resultat (konto 8910) finns bland de konton
          som stängs. Gå tillbaka till dispositionssteget och boka bolagsskatten innan du
          verkställer, om inte skattemässigt resultat är noll (t.ex. genom underskottsavdrag,
          avsättning till periodiseringsfond eller överavskrivningar).{' '}
          <button type="button" onClick={onBack} className="underline underline-offset-2 hover:opacity-80">
            Till dispositionssteget
          </button>
        </p>
      )}

      {preview.currencyRevaluation && preview.currencyRevaluation.items.length > 0 && (
        <section>
          <div className="mb-1 flex items-center gap-2 px-1">
            <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Kursrevaluering (ÅRL 4:13)
            </h3>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Fordringar/skulder i utländsk valuta som var öppna på balansdagen värderas om till
            balansdagens kurs. Raderna nedan bokförs som en del av verkställandet: kontrollera
            dem innan du går vidare.
          </p>
          <div className="px-1 pt-4">
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
          </div>
          {/* Capped height: a company with hundreds of open FX invoices must
              not push the wizard's own actions off the screen. */}
          <div className="max-h-80 overflow-y-auto px-1 pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Faktura</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead className="text-right">Belopp</TableHead>
                  <TableHead className="text-right">Kurs → balansdag</TableHead>
                  <TableHead className="text-right">Differens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.currencyRevaluation.items.map((item) => (
                  <TableRow key={`${item.type}-${item.source_id}`}>
                    <TableCell className="text-sm">{item.reference || '-'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.type === 'receivable' ? 'Kundfordran' : 'Leverantörsskuld'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(item.amount_in_currency, item.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                      {item.original_rate.toFixed(4)} → {item.closing_rate.toFixed(4)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${item.difference_sek < 0 ? 'text-destructive' : ''}`}
                    >
                      {formatCurrency(item.difference_sek)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <section>
        <div className="mb-1 flex items-center gap-2 px-1">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Bokslutsverifikation: förhandsgranskning
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <p className="px-1 pb-2 text-xs leading-5 text-muted-foreground">
          {preview.closingLines.length} kontorader. Nollställer klass 3-8 mot {preview.closingAccount}.
        </p>
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
      </section>

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Tillbaka
        </Button>
        <Button variant="outline" size="sm" onClick={onContinue}>
          Nästa: Verkställ →
        </Button>
      </div>
    </div>
  )
}
