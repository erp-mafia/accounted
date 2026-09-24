'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
  HelpCircle,
  Landmark,
  Loader2,
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
  wise: 'Wise',
  camt053: 'ISO 20022 camt.053',
}

interface BankFileUploadStepProps {
  onFileSelect: (file: File, formatOverride?: BankFileFormatId) => void
  isLoading: boolean
  error: string | null
  errorTitle?: string | null
  detectedFormat?: string | null
  detectedFormatName?: string | null
  /** The uploaded file was recognized as a Skatteverket skattekontoutdrag. */
  skattekontoDetected?: boolean
}

export default function BankFileUploadStep({
  onFileSelect,
  isLoading,
  error,
  errorTitle,
  detectedFormat,
  detectedFormatName,
  skattekontoDetected,
}: BankFileUploadStepProps) {
  const t = useTranslations('import')
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
            {t('bankfile_upload_title')}
          </CardTitle>
          <CardDescription>
            {t('bankfile_upload_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Format override */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <label className="text-sm font-medium whitespace-nowrap">{t('bankfile_upload_format_label')}</label>
            <Select
              value={formatOverride || 'auto'}
              onValueChange={handleFormatChange}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder={t('bankfile_upload_format_auto')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('bankfile_upload_format_auto')}</SelectItem>
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
                <SelectItem value="wise">Wise</SelectItem>
                <SelectItem value="wise_statement">{t('bank_format_wise_statement')}</SelectItem>
                <SelectItem value="camt053">ISO 20022 camt.053 (XML)</SelectItem>
                <SelectItem value="generic_csv">{t('bankfile_upload_format_generic_csv')}</SelectItem>
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
                <FileText className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="flex items-center justify-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {t('bankfile_upload_analyzing')}
                </p>
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
                    <Landmark className="mr-1 h-3 w-3" />
                    {detectedFormat === 'wise_statement'
                      ? t('bank_format_wise_statement')
                      : detectedFormatName ||
                        (detectedFormat === 'generic_csv'
                          ? t('bankfile_upload_generic_csv_name')
                          : FORMAT_NAMES[detectedFormat]) ||
                        detectedFormat}
                  </Badge>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">{t('bankfile_upload_drop')}</p>
                  <p className="font-medium sm:hidden">{t('bankfile_upload_tap')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('bankfile_upload_accepted')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Skattekonto redirect: not an error, a pointer to the right flow */}
          {skattekontoDetected && (
            <div className="p-4 bg-muted/30 border border-border rounded-lg flex gap-3">
              <AlertCircle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">{t('skattekonto_detected_title')}</p>
                <p className="mt-1 text-muted-foreground">
                  {t('skattekonto_detected_body')}{' '}
                  <Link href="/import?mode=skattekonto" className="underline underline-offset-2">
                    {t('skattekonto_detected_link')}
                  </Link>
                </p>
              </div>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">{errorTitle || t('bankfile_upload_read_failed')}</p>
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
            {t('bankfile_upload_howto_title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <div>
            <p className="font-medium">Nordea</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_nordea')}
            </p>
          </div>
          <div>
            <p className="font-medium">SEB</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_seb')}
            </p>
          </div>
          <div>
            <p className="font-medium">Swedbank</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_swedbank')}
            </p>
          </div>
          <div>
            <p className="font-medium">Handelsbanken</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_handelsbanken')}
            </p>
          </div>
          <div>
            <p className="font-medium">Länsförsäkringar</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_lansforsakringar')}
            </p>
          </div>
          <div>
            <p className="font-medium">ICA Banken</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_ica_banken')}
            </p>
          </div>
          <div>
            <p className="font-medium">Skandia</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_skandia')}
            </p>
          </div>
          <div>
            <p className="font-medium">Lunar</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_lunar')}
            </p>
          </div>
          <div>
            <p className="font-medium">Northmill</p>
            <p className="text-muted-foreground">
              {t('bankfile_upload_howto_northmill')}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
