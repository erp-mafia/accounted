'use client'

import { useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Upload, FileText, Check } from 'lucide-react'

interface CsvImportWizardProps {
  targetFields: { key: string; label: string; required?: boolean }[]
  defaultMappings?: Record<string, string>
  onImport: (rows: Record<string, string>[]) => Promise<void>
  className?: string
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

export default function CsvImportWizard({
  targetFields,
  defaultMappings,
  onImport,
  className,
}: CsvImportWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [isImporting, setIsImporting] = useState(false)
  const [importCount, setImportCount] = useState(0)
  const [fileName, setFileName] = useState('')

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const parsed = parseCsv(text)
      setHeaders(parsed.headers)
      setRows(parsed.rows)

      // Auto-map using defaults
      const autoMappings: Record<string, string> = {}
      for (const field of targetFields) {
        const defaultCsv = defaultMappings?.[field.key]
        if (defaultCsv && parsed.headers.includes(defaultCsv)) {
          autoMappings[field.key] = defaultCsv
        } else {
          const match = parsed.headers.find(
            h => h.toLowerCase() === field.key.toLowerCase() ||
                 h.toLowerCase() === field.label.toLowerCase()
          )
          if (match) autoMappings[field.key] = match
        }
      }
      setMappings(autoMappings)
      setStep(2)
    }
    reader.readAsText(file)
  }, [targetFields, defaultMappings])

  const handleImport = async () => {
    setIsImporting(true)
    try {
      const mappedRows = rows.map(row => {
        const obj: Record<string, string> = {}
        for (const [fieldKey, csvCol] of Object.entries(mappings)) {
          const colIdx = headers.indexOf(csvCol)
          if (colIdx >= 0 && row[colIdx]) {
            obj[fieldKey] = row[colIdx]
          }
        }
        return obj
      }).filter(row => Object.keys(row).length > 0)

      await onImport(mappedRows)
      setImportCount(mappedRows.length)
      setStep(3)
    } finally {
      setIsImporting(false)
    }
  }

  const reset = () => {
    setStep(1)
    setHeaders([])
    setRows([])
    setMappings({})
    setFileName('')
    setImportCount(0)
  }

  const requiredFieldsMapped = targetFields
    .filter(f => f.required)
    .every(f => mappings[f.key])

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {step === 1 && <><Upload className="h-4 w-4" /> Steg 1: Välj fil</>}
          {step === 2 && <><FileText className="h-4 w-4" /> Steg 2: Kolumnmappning</>}
          {step === 3 && <><Check className="h-4 w-4" /> Import klar</>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {step === 1 && (
          <div className="space-y-4">
            <div className="border-2 border-dashed rounded-lg p-8 text-center">
              <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-3">
                Välj en CSV-fil att importera
              </p>
              <Label htmlFor="csv-upload" className="cursor-pointer">
                <Button variant="outline" size="sm" asChild>
                  <span>Välj fil</span>
                </Button>
              </Label>
              <input
                id="csv-upload"
                type="file"
                accept=".csv,.txt"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {fileName} - {rows.length} rader hittades. Mappa kolumner:
            </p>
            <div className="space-y-3">
              {targetFields.map(field => (
                <div key={field.key} className="flex items-center gap-3">
                  <Label className="w-36 text-sm shrink-0">
                    {field.label}{field.required && ' *'}
                  </Label>
                  <Select
                    value={mappings[field.key] ?? ''}
                    onValueChange={(val) => setMappings(prev => ({ ...prev, [field.key]: val }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Välj kolumn..." />
                    </SelectTrigger>
                    <SelectContent>
                      {headers.map(h => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {rows.length > 0 && (
              <div className="rounded-lg border overflow-auto max-h-48">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {headers.map(h => (
                        <TableHead key={h} className="text-xs whitespace-nowrap">{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 5).map((row, i) => (
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

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={reset}>
                Tillbaka
              </Button>
              <Button
                size="sm"
                onClick={handleImport}
                disabled={!requiredFieldsMapped || isImporting}
              >
                {isImporting ? 'Importerar...' : `Importera ${rows.length} rader`}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="text-center py-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-3">
              <Check className="h-6 w-6 text-success" />
            </div>
            <p className="font-medium">{importCount} rader importerades</p>
            <p className="text-sm text-muted-foreground mt-1">
              Från {fileName}
            </p>
            <Button variant="outline" size="sm" onClick={reset} className="mt-4">
              Importera fler
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
