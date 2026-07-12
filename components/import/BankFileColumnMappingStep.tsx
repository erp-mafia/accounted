'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ArrowLeft, ArrowRight, Columns3 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { getCSVPreview, normalizeMinusSign, suggestColumnMapping } from '@/lib/import/bank-file/formats/generic-csv'
import type { GenericCSVColumnMapping } from '@/lib/import/bank-file/types'

const HEADER_KEYWORDS = [
  'datum',
  'bokföringsdag',
  'bokforingsdag',
  'transaktionsdatum',
  'reskontradatum',
  'beskrivning',
  'belopp',
  'transaktion',
  'text',
  'mottagare',
  'saldo',
  'valuta',
  'amount',
  'description',
  'date',
]

interface BankFileColumnMappingStepProps {
  rawFileContent: string
  onConfirm: (mapping: GenericCSVColumnMapping) => void
  onBack: () => void
}

export default function BankFileColumnMappingStep({
  rawFileContent,
  onConfirm,
  onBack,
}: BankFileColumnMappingStepProps) {
  const [dateCol, setDateCol] = useState<number>(-1)
  const [descCol, setDescCol] = useState<number>(-1)
  const [amountCol, setAmountCol] = useState<number>(-1)
  const [referenceCol, setReferenceCol] = useState<number>(-1)
  const [counterpartyCol, setCounterpartyCol] = useState<number>(-1)
  const [balanceCol, setBalanceCol] = useState<number>(-1)
  // Auto-detect the most likely delimiter by counting field splits on the first line.
  // Runs once per file. Users can still override via the dropdown.
  const detectedDelimiter = useMemo(() => {
    const firstLine = rawFileContent.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
    const candidates: Array<{ d: string; count: number }> = [
      { d: ',', count: getCSVPreview(firstLine, ',', 1)[0]?.length ?? 0 },
      { d: ';', count: getCSVPreview(firstLine, ';', 1)[0]?.length ?? 0 },
      { d: '\t', count: getCSVPreview(firstLine, '\t', 1)[0]?.length ?? 0 },
    ]
    const best = candidates.reduce((a, b) => (b.count > a.count ? b : a))
    return best.count > 1 ? best.d : ','
  }, [rawFileContent])

  const [delimiter, setDelimiter] = useState<string>(detectedDelimiter)
  const [decimalSep, setDecimalSep] = useState<',' | '.'>(',')
  const [dateFormat, setDateFormat] = useState<string>('YYYY-MM-DD')

  // Re-parse headers and preview whenever delimiter or file content changes.
  // Pull a generous slice (30 rows) so we can scan past metadata preambles like
  // Northmill's 5-line Kontonummer/Saldo/Kontohavare/Org.Nr/Period header.
  const parsedRows = useMemo(
    () => getCSVPreview(rawFileContent, delimiter, 30),
    [rawFileContent, delimiter]
  )

  // Auto-detect the header row index by scanning for a row whose cells
  // contain known column-name keywords (bokföringsdag, beskrivning, belopp, …).
  // A row needs ≥ 2 keyword hits to qualify, which excludes metadata rows where
  // only the label cell happens to match (e.g. "Saldo,251495,41,SEK").
  // Falls back to row 0 if nothing qualifies: preserves prior behavior for
  // simple files where the header truly is the first row.
  const DATE_PATTERNS = [/^\d{4}-\d{2}-\d{2}$/, /^\d{2}[./]\d{2}[./]\d{4}$/, /^\d{8}$/]
  const detectedHeaderRow = useMemo(() => {
    let best: { idx: number; score: number; cells: number } | null = null
    for (let i = 0; i < Math.min(parsedRows.length, 20); i++) {
      const row = parsedRows[i]
      if (!row || row.length < 2) continue
      const hits = row.filter((cell) => {
        const c = cell.trim().toLowerCase()
        return c.length > 0 && HEADER_KEYWORDS.some((kw) => c === kw || c.includes(kw))
      }).length
      if (hits < 2) continue
      if (!best || hits > best.score || (hits === best.score && row.length > best.cells)) {
        best = { idx: i, score: hits, cells: row.length }
      }
    }
    return best?.idx ?? 0
  }, [parsedRows])

  // Detect whether the file actually has a header row at all: if the auto-detect
  // landed on row 0 but row 0 already looks like data (any cell is a date), assume
  // no header. Otherwise trust the detection.
  const detectedHasHeader = useMemo(() => {
    const headerRow = parsedRows[detectedHeaderRow]
    if (!headerRow) return true
    const looksLikeData = headerRow.some((cell) =>
      DATE_PATTERNS.some((re) => re.test(cell.trim()))
    )
    return !looksLikeData
  }, [parsedRows, detectedHeaderRow])

  const [hasHeaderOverride, setHasHeaderOverride] = useState<boolean | null>(null)
  const hasHeader = hasHeaderOverride ?? detectedHasHeader

  // skip_rows = number of rows to skip before transaction data starts.
  // When hasHeader: skip past the header row (detectedHeaderRow + 1).
  // When no header: skip nothing: data starts at row 0.
  const skipRows = hasHeader ? detectedHeaderRow + 1 : 0

  const columnHeaders = useMemo(() => {
    if (hasHeader && parsedRows[detectedHeaderRow]) return parsedRows[detectedHeaderRow]
    const count = parsedRows[0]?.length ?? 0
    return Array.from({ length: count }, (_, i) => `Kolumn ${i + 1}`)
  }, [parsedRows, hasHeader, detectedHeaderRow])

  const dataRows = hasHeader ? parsedRows.slice(detectedHeaderRow + 1) : parsedRows

  // Auto-guess date/description/amount/balance columns. Matches header labels
  // first (so the trailing Saldo column is never picked as the amount), then
  // falls back to value heuristics. Initial defaults only: user can override.
  useEffect(() => {
    if (dateCol !== -1 || descCol !== -1 || amountCol !== -1) return
    if (dataRows.length === 0) return

    const suggestion = suggestColumnMapping(hasHeader ? columnHeaders : null, dataRows)
    if (suggestion.date >= 0) setDateCol(suggestion.date)
    if (suggestion.description >= 0) setDescCol(suggestion.description)
    if (suggestion.amount >= 0) setAmountCol(suggestion.amount)
    if (suggestion.balance >= 0) setBalanceCol(suggestion.balance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataRows, hasHeader, columnHeaders])

  const isValid = dateCol >= 0 && descCol >= 0 && amountCol >= 0

  const handleConfirm = () => {
    const mapping: GenericCSVColumnMapping = {
      date: dateCol,
      description: descCol,
      amount: amountCol,
      ...(referenceCol >= 0 && { reference: referenceCol }),
      ...(counterpartyCol >= 0 && { counterparty: counterpartyCol }),
      ...(balanceCol >= 0 && { balance: balanceCol }),
      delimiter,
      decimal_separator: decimalSep,
      skip_rows: skipRows,
      date_format: dateFormat,
    }
    onConfirm(mapping)
  }

  const columnOptions = columnHeaders.map((h, i) => ({ label: `${i + 1}: ${h}`, value: i }))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Columns3 className="h-5 w-5" />
            Kolumnmappning
          </CardTitle>
          <CardDescription>
            Vi kunde inte identifiera bankformatet automatiskt. Mappa kolumnerna manuellt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Header row toggle */}
          <div className="flex items-center justify-between rounded-md border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="has-header">Har filen rubrikrad?</Label>
              <p className="text-xs text-muted-foreground">
                {hasHeader && detectedHeaderRow > 0
                  ? `Hoppar över ${detectedHeaderRow} metadatarader. Rubrikraden upptäcktes på rad ${detectedHeaderRow + 1}.`
                  : 'Slå av om filen saknar rubrikrad och första raden redan innehåller transaktionsdata.'}
              </p>
            </div>
            <Switch id="has-header" checked={hasHeader} onCheckedChange={setHasHeaderOverride} />
          </div>

          {/* Delimiter, decimal, and date format settings */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Avgränsare</Label>
              <Select value={delimiter} onValueChange={(v) => { if (v) setDelimiter(v) }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=",">Komma (,)</SelectItem>
                  <SelectItem value=";">Semikolon (;)</SelectItem>
                  <SelectItem value="\t">Tab</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Decimalavgränsare</Label>
              <Select value={decimalSep} onValueChange={(v) => { if (v) setDecimalSep(v as ',' | '.') }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=",">Komma (1 234,56)</SelectItem>
                  <SelectItem value=".">Punkt (1234.56)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Datumformat</Label>
              <Select value={dateFormat} onValueChange={(v) => { if (v) setDateFormat(v) }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                  <SelectItem value="DD.MM.YYYY">DD.MM.YYYY</SelectItem>
                  <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                  <SelectItem value="YYYYMMDD">YYYYMMDD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Required column mappings */}
          <div>
            <h3 className="text-sm font-medium mb-3">Obligatoriska kolumner</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Datum *</Label>
                <Select
                  value={dateCol >= 0 ? dateCol.toString() : ''}
                  onValueChange={(v) => setDateCol(parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj kolumn" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Beskrivning *</Label>
                <Select
                  value={descCol >= 0 ? descCol.toString() : ''}
                  onValueChange={(v) => setDescCol(parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj kolumn" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Belopp *</Label>
                <Select
                  value={amountCol >= 0 ? amountCol.toString() : ''}
                  onValueChange={(v) => setAmountCol(parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Välj kolumn" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Optional column mappings */}
          <div>
            <h3 className="text-sm font-medium mb-3">Valfria kolumner</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Referens/OCR</Label>
                <Select
                  value={referenceCol >= 0 ? referenceCol.toString() : 'none'}
                  onValueChange={(v) => setReferenceCol(v === 'none' ? -1 : parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Ingen" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Ingen</SelectItem>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Motpart</Label>
                <Select
                  value={counterpartyCol >= 0 ? counterpartyCol.toString() : 'none'}
                  onValueChange={(v) => setCounterpartyCol(v === 'none' ? -1 : parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Ingen" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Ingen</SelectItem>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Saldo</Label>
                <Select
                  value={balanceCol >= 0 ? balanceCol.toString() : 'none'}
                  onValueChange={(v) => setBalanceCol(v === 'none' ? -1 : parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Ingen" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Ingen</SelectItem>
                    {columnOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value.toString()}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Live preview */}
      {isValid && dataRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Förhandsgranskning</CardTitle>
            <CardDescription>
              Så tolkas dina data med den valda mappningen
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-64 overflow-x-auto overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Datum</TableHead>
                    <TableHead>Beskrivning</TableHead>
                    <TableHead className="text-right">Belopp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                    {dataRows.slice(0, 5).map((row, i) => {
                    const amountStr = row[amountCol] || '0'
                    const normalizedAmountStr = normalizeMinusSign(amountStr)
                    const amount = decimalSep === ','
                      ? parseFloat(normalizedAmountStr.replace(/\s/g, '').replace(',', '.'))
                      : parseFloat(normalizedAmountStr.replace(/\s/g, ''))

                    return (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-sm">{row[dateCol] || '-'}</TableCell>
                        <TableCell className="text-sm">{row[descCol] || '-'}</TableCell>
                        <TableCell
                          className={`text-right font-mono text-sm ${
                            !isNaN(amount) && amount >= 0 ? 'text-success' : 'text-destructive'
                          }`}
                        >
                          {!isNaN(amount) ? formatCurrency(amount) : amountStr}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button className="min-h-11" onClick={handleConfirm} disabled={!isValid}>
          Fortsätt
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
