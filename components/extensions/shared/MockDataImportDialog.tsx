'use client'

import { useState, useCallback, useRef } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Upload, FileJson, FileSpreadsheet, Download, AlertCircle, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────

export interface CsvFieldDef {
  key: string
  label: string
  required?: boolean
}

interface MockDataImportDialogProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  csvFields: CsvFieldDef[]
  defaultMappings?: Record<string, string>
  parseCsvRows: (rows: Record<string, string>[]) => T
  validateReport: (data: unknown) => { valid: boolean; error?: string }
  templateCsvContent: string
  templateFileName: string
  onImport: (report: T, meta: { source: 'csv' | 'json'; fileName: string; rowCount: number }) => Promise<void>
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter(line => line.trim())
  if (lines.length === 0) return { headers: [], rows: [] }

  const separator = lines[0].includes(';') ? ';' : ','
  const headers = lines[0].split(separator).map(h => h.trim().replace(/^"(.*)"$/, '$1'))
  const rows = lines.slice(1).map(line =>
    line.split(separator).map(cell => cell.trim().replace(/^"(.*)"$/, '$1'))
  )
  return { headers, rows }
}

// ── Component ─────────────────────────────────────────────────

type Step = 'upload' | 'map-csv' | 'preview-json' | 'importing'

export default function MockDataImportDialog<T>({
  open,
  onOpenChange,
  csvFields,
  defaultMappings,
  parseCsvRows,
  validateReport,
  templateCsvContent,
  templateFileName,
  onImport,
}: MockDataImportDialogProps<T>) {
  const [step, setStep] = useState<Step>('upload')
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // CSV state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<string[][]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [fileName, setFileName] = useState('')

  // JSON state
  const [jsonReport, setJsonReport] = useState<T | null>(null)
  const [jsonSummary, setJsonSummary] = useState('')

  const reset = useCallback(() => {
    setStep('upload')
    setError(null)
    setCsvHeaders([])
    setCsvRows([])
    setMappings({})
    setFileName('')
    setJsonReport(null)
    setJsonSummary('')
    setIsDragging(false)
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) reset()
    onOpenChange(open)
  }, [onOpenChange, reset])

  const processFile = useCallback((file: File) => {
    setError(null)
    setFileName(file.name)

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string

      if (file.name.endsWith('.json')) {
        // JSON path
        try {
          const parsed = JSON.parse(text)
          const validation = validateReport(parsed)
          if (!validation.valid) {
            setError(validation.error || 'Ogiltig JSON-struktur')
            return
          }
          setJsonReport(parsed as T)

          // Build summary
          const keys = Object.keys(parsed)
          const lines = Array.isArray(parsed.lines) ? parsed.lines.length
            : Array.isArray(parsed.receivables) ? parsed.receivables.length
            : Array.isArray(parsed.boxes) ? parsed.boxes.length
            : null
          setJsonSummary(
            `${keys.length} fält` + (lines !== null ? `, ${lines} rader` : '')
          )
          setStep('preview-json')
        } catch {
          setError('Kunde inte tolka JSON-filen. Kontrollera formatet.')
        }
      } else {
        // CSV path
        const parsed = parseCsv(text)
        if (parsed.headers.length === 0 || parsed.rows.length === 0) {
          setError('Ingen data hittades i CSV-filen.')
          return
        }

        setCsvHeaders(parsed.headers)
        setCsvRows(parsed.rows)

        // Auto-map columns
        const autoMappings: Record<string, string> = {}
        for (const field of csvFields) {
          const defaultCol = defaultMappings?.[field.key]
          if (defaultCol && parsed.headers.includes(defaultCol)) {
            autoMappings[field.key] = defaultCol
          } else {
            const match = parsed.headers.find(
              h => h.toLowerCase() === field.key.toLowerCase() ||
                   h.toLowerCase() === field.label.toLowerCase()
            )
            if (match) autoMappings[field.key] = match
          }
        }
        setMappings(autoMappings)
        setStep('map-csv')
      }
    }
    reader.readAsText(file)
  }, [csvFields, defaultMappings, validateReport])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }, [processFile])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }, [processFile])

  const handleCsvImport = useCallback(async () => {
    setStep('importing')
    setError(null)

    try {
      const mappedRows = csvRows.map(row => {
        const obj: Record<string, string> = {}
        for (const [fieldKey, csvCol] of Object.entries(mappings)) {
          const colIdx = csvHeaders.indexOf(csvCol)
          if (colIdx >= 0 && row[colIdx]) {
            obj[fieldKey] = row[colIdx]
          }
        }
        return obj
      }).filter(row => Object.keys(row).length > 0)

      const report = parseCsvRows(mappedRows)
      await onImport(report, { source: 'csv', fileName, rowCount: mappedRows.length })
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import misslyckades')
      setStep('map-csv')
    }
  }, [csvRows, csvHeaders, mappings, parseCsvRows, onImport, fileName, handleOpenChange])

  const handleJsonImport = useCallback(async () => {
    if (!jsonReport) return
    setStep('importing')
    setError(null)

    try {
      await onImport(jsonReport, { source: 'json', fileName, rowCount: 0 })
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import misslyckades')
      setStep('preview-json')
    }
  }, [jsonReport, onImport, fileName, handleOpenChange])

  const downloadTemplate = useCallback(() => {
    const blob = new Blob([templateCsvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = templateFileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [templateCsvContent, templateFileName])

  const requiredFieldsMapped = csvFields
    .filter(f => f.required)
    .every(f => mappings[f.key])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && 'Importera testdata'}
            {step === 'map-csv' && 'Kolumnmappning'}
            {step === 'preview-json' && 'Förhandsgranska JSON'}
            {step === 'importing' && 'Importerar...'}
          </DialogTitle>
        </DialogHeader>

        {/* ── Error ─────────────────────────────────────── */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/5 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── Step: Upload ──────────────────────────────── */}
        {step === 'upload' && (
          <div className="space-y-4">
            <div
              className={cn(
                'border-2 border-dashed rounded-lg p-10 text-center transition-colors',
                isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              )}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium mb-1">
                Dra och släpp en fil här
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                CSV (.csv) eller JSON (.json)
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Välj fil
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json"
                onChange={handleFileInput}
                className="hidden"
              />
            </div>

            <div className="flex items-center justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={downloadTemplate}
                className="text-xs text-muted-foreground"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Ladda ner CSV-mall
              </Button>
            </div>
          </div>
        )}

        {/* ── Step: Map CSV ─────────────────────────────── */}
        {step === 'map-csv' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileSpreadsheet className="h-4 w-4" />
              <span>{fileName}: {csvRows.length} rader</span>
            </div>

            <div className="space-y-3">
              {csvFields.map(field => (
                <div key={field.key} className="flex items-center gap-3">
                  <Label className="w-40 text-sm shrink-0">
                    {field.label}{field.required && ' *'}
                  </Label>
                  <Select
                    value={mappings[field.key] ?? '___none___'}
                    onValueChange={(val) => setMappings(prev => ({
                      ...prev,
                      [field.key]: val === '___none___' ? '' : val,
                    }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Välj kolumn..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="___none___">- Välj kolumn -</SelectItem>
                      {csvHeaders.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {/* Preview first 5 rows */}
            {csvRows.length > 0 && (
              <div className="rounded-lg border overflow-auto max-h-48">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {csvHeaders.map(h => (
                        <TableHead key={h} className="text-xs whitespace-nowrap">{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csvRows.slice(0, 5).map((row, i) => (
                      <TableRow key={i}>
                        {row.map((cell, j) => (
                          <TableCell key={j} className="text-xs whitespace-nowrap">{cell}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={reset}>Tillbaka</Button>
              <Button
                onClick={handleCsvImport}
                disabled={!requiredFieldsMapped}
              >
                Importera {csvRows.length} rader
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Step: Preview JSON ────────────────────────── */}
        {step === 'preview-json' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileJson className="h-4 w-4" />
              <span>{fileName}</span>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-md bg-success/10 text-success text-sm">
              <Check className="h-4 w-4 shrink-0" />
              <span>Giltig JSON: {jsonSummary}</span>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={reset}>Tillbaka</Button>
              <Button onClick={handleJsonImport}>
                Importera testdata
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Step: Importing ───────────────────────────── */}
        {step === 'importing' && (
          <div className="py-8 text-center">
            <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Importerar testdata...</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
