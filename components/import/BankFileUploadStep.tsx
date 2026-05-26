'use client'

import { useState, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Upload,
  FileText,
  AlertCircle,
  CheckCircle,
  Building2,
  HelpCircle,
} from 'lucide-react'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'

const FORMAT_NAMES: Record<string, string> = {
  nordea: 'Nordea',
  nordea_business: 'Nordea Företag',
  seb: 'SEB',
  swedbank: 'Swedbank',
  handelsbanken: 'Handelsbanken',
  lansforsakringar: 'Länsförsäkringar',
  ica_banken: 'ICA Banken',
  skandia: 'Skandia',
  lunar: 'Lunar',
  northmill: 'Northmill',
  generic_csv: 'CSV (manuell mappning)',
  camt053: 'ISO 20022 camt.053',
}

interface BankFileUploadStepProps {
  onFileSelect: (file: File, formatOverride?: BankFileFormatId) => void
  isLoading: boolean
  error: string | null
  detectedFormat?: string | null
  detectedFormatName?: string | null
}

export default function BankFileUploadStep({
  onFileSelect,
  isLoading,
  error,
  detectedFormat,
  detectedFormatName,
}: BankFileUploadStepProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [formatOverride, setFormatOverride] = useState<BankFileFormatId | undefined>(undefined)

  const acceptedExtensions = '.csv,.txt,.xml'

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files.length > 0) {
      const file = files[0]
      const ext = file.name.toLowerCase()
      if (ext.endsWith('.csv') || ext.endsWith('.txt') || ext.endsWith('.xml')) {
        setSelectedFile(file)
        onFileSelect(file, formatOverride)
      }
    }
  }, [onFileSelect, formatOverride])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      setSelectedFile(files[0])
      onFileSelect(files[0], formatOverride)
    }
  }, [onFileSelect, formatOverride])

  const handleFormatChange = (value: string) => {
    const format = value === 'auto' ? undefined : value as BankFileFormatId
    setFormatOverride(format)
    if (selectedFile) {
      onFileSelect(selectedFile, format)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Ladda upp kontoutdrag
          </CardTitle>
          <CardDescription>
            Exportera transaktioner som CSV eller XML från din internetbank och ladda upp filen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Format override */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label className="text-sm font-medium whitespace-nowrap">Bank/format:</label>
            <Select
              value={formatOverride || 'auto'}
              onValueChange={handleFormatChange}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Automatisk identifiering" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatisk identifiering</SelectItem>
                <SelectItem value="nordea">Nordea</SelectItem>
                <SelectItem value="nordea_business">Nordea Företag</SelectItem>
                <SelectItem value="seb">SEB</SelectItem>
                <SelectItem value="swedbank">Swedbank</SelectItem>
                <SelectItem value="handelsbanken">Handelsbanken</SelectItem>
                <SelectItem value="lansforsakringar">Länsförsäkringar</SelectItem>
                <SelectItem value="ica_banken">ICA Banken</SelectItem>
                <SelectItem value="skandia">Skandia</SelectItem>
                <SelectItem value="lunar">Lunar</SelectItem>
                <SelectItem value="northmill">Northmill</SelectItem>
                <SelectItem value="camt053">ISO 20022 camt.053 (XML)</SelectItem>
                <SelectItem value="generic_csv">Annan CSV (manuell mappning)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Drop zone */}
          <div
            className={`
              relative border-2 border-dashed rounded-lg p-8 text-center transition-colors
              ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
              ${error ? 'border-destructive bg-destructive/5' : ''}
              ${isLoading ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:border-primary/50'}
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => document.getElementById('bank-file-input')?.click()}
          >
            <input
              id="bank-file-input"
              type="file"
              accept={acceptedExtensions}
              className="hidden"
              onChange={handleFileInput}
              disabled={isLoading}
            />

            {isLoading ? (
              <div className="space-y-4">
                <FileText className="mx-auto h-12 w-12 text-muted-foreground animate-pulse" />
                <p className="text-muted-foreground">Analyserar fil...</p>
                <Progress value={33} className="w-48 mx-auto" />
              </div>
            ) : selectedFile && detectedFormat ? (
              <div className="space-y-4">
                <CheckCircle className="mx-auto h-12 w-12 text-success" />
                <div>
                  <p className="font-medium">{selectedFile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(1)} KB
                  </p>
                  <Badge variant="secondary" className="mt-2">
                    <Building2 className="mr-1 h-3 w-3" />
                    {detectedFormatName || FORMAT_NAMES[detectedFormat] || detectedFormat}
                  </Badge>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">Dra och släpp bankfil här</p>
                  <p className="font-medium sm:hidden">Tryck för att välja bankfil</p>
                  <p className="text-sm text-muted-foreground">
                    CSV, TXT eller XML (max 10 MB)
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">Kunde inte läsa filen</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bank export instructions */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <HelpCircle className="h-4 w-4" />
            Så exporterar du från din bank
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <div>
            <p className="font-medium">Nordea</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Välj konto → Transaktioner → Exportera (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">SEB</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Kontoutdrag → Hämta som fil (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">Swedbank</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Transaktioner → Exportera kontoutdrag (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">Handelsbanken</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Transaktioner → Ladda ner (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">Länsförsäkringar</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Kontoutdrag → Exportera (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">ICA Banken</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Transaktioner → Exportera till fil (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">Skandia</p>
            <p className="text-muted-foreground">
              Logga in → Konton → Transaktioner → Exportera (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">Lunar</p>
            <p className="text-muted-foreground">
              Logga in → Konto → Transaktioner → Exportera (CSV)
            </p>
          </div>
          <div>
            <p className="font-medium">Northmill</p>
            <p className="text-muted-foreground">
              Logga in → Konto → Kontoutdrag → Ladda ner (CSV)
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
