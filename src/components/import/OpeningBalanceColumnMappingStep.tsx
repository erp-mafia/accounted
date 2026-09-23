'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { DetectedColumns, BalanceColumnLayout } from '@/lib/import/opening-balance/types'

interface OpeningBalanceColumnMappingStepProps {
  headers: string[]
  previewRows: string[][]
  detectedColumns: DetectedColumns
  onConfirm: (columns: DetectedColumns) => void
  onBack: () => void
}

export default function OpeningBalanceColumnMappingStep({
  headers,
  previewRows,
  detectedColumns,
  onConfirm,
  onBack,
}: OpeningBalanceColumnMappingStepProps) {
  const [accountNumberCol, setAccountNumberCol] = useState(
    detectedColumns.account_number_col,
  )
  const [accountNameCol, setAccountNameCol] = useState<number | null>(
    detectedColumns.account_name_col,
  )
  const [layout, setLayout] = useState<BalanceColumnLayout>(
    detectedColumns.layout,
  )
  const [balanceCol, setBalanceCol] = useState<number | null>(
    detectedColumns.balance_col,
  )
  const [debitCol, setDebitCol] = useState<number | null>(
    detectedColumns.debit_col,
  )
  const [creditCol, setCreditCol] = useState<number | null>(
    detectedColumns.credit_col,
  )

  const columnOptions = headers.map((h, i) => ({
    value: String(i),
    label: `${i + 1}: ${h || '(tom)'}`,
  }))

  const canContinue =
    accountNumberCol >= 0 &&
    (layout === 'net' ? balanceCol !== null : debitCol !== null && creditCol !== null)

  const handleConfirm = () => {
    onConfirm({
      account_number_col: accountNumberCol,
      account_name_col: accountNameCol,
      layout,
      balance_col: layout === 'net' ? balanceCol : null,
      debit_col: layout === 'debit_credit' ? debitCol : null,
      credit_col: layout === 'debit_credit' ? creditCol : null,
      confidence: 1, // User-confirmed
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kolumnmappning</CardTitle>
        <CardDescription>
          Vi kunde inte automatiskt identifiera alla kolumner. Ange vilka kolumner
          som innehåller kontonummer och belopp.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Layout toggle */}
        <div className="space-y-2">
          <Label>Beloppslayout</Label>
          <Select value={layout} onValueChange={(v) => setLayout(v as BalanceColumnLayout)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="net">Nettobelopp (en kolumn)</SelectItem>
              <SelectItem value="debit_credit">Debet &amp; kredit (två kolumner)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Required mappings */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Kontonummer *</Label>
            <Select
              value={String(accountNumberCol)}
              onValueChange={(v) => setAccountNumberCol(Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Välj kolumn" />
              </SelectTrigger>
              <SelectContent>
                {columnOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Kontonamn</Label>
            <Select
              value={accountNameCol !== null ? String(accountNameCol) : 'none'}
              onValueChange={(v) => setAccountNameCol(v === 'none' ? null : Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Välj kolumn" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">(ingen)</SelectItem>
                {columnOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {layout === 'net' && (
            <div className="space-y-2">
              <Label>Saldo/Belopp *</Label>
              <Select
                value={balanceCol !== null ? String(balanceCol) : ''}
                onValueChange={(v) => setBalanceCol(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Välj kolumn" />
                </SelectTrigger>
                <SelectContent>
                  {columnOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {layout === 'debit_credit' && (
            <>
              <div className="space-y-2">
                <Label>Debet *</Label>
                <Select
                  value={debitCol !== null ? String(debitCol) : ''}
                  onValueChange={(v) => setDebitCol(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj kolumn" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Kredit *</Label>
                <Select
                  value={creditCol !== null ? String(creditCol) : ''}
                  onValueChange={(v) => setCreditCol(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj kolumn" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>

        {/* Preview */}
        {previewRows.length > 0 && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">Förhandsgranskning (5 första raderna)</Label>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b">
                    {headers.map((h, i) => (
                      /* data-ph-mask: CSV headers are user data */
                      <th key={i} data-ph-mask="" className="px-3 py-2 text-left whitespace-nowrap">
                        {h || `Kolumn ${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 5).map((row, ri) => (
                    <tr key={ri} className="border-b last:border-0">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1.5 whitespace-nowrap tabular-nums">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between">
          <Button variant="ghost" onClick={onBack}>
            Tillbaka
          </Button>
          <Button onClick={handleConfirm} disabled={!canContinue}>
            Fortsätt
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
