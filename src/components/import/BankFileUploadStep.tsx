'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowUpTrayIcon,
  BuildingLibraryIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  SpinnerIcon,
} from '@/components/icons'
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
  avanza: 'Avanza',
  wise: 'Wise',
  generic_csv: 'CSV (manuell mappning)',
  camt053: 'ISO 20022 camt.053',
}

/**
 * Where each bank keeps its export, in the `import` namespace: shown under
 * the Bank/format select for the chosen bank only.
 */
const EXPORT_PATH_KEYS: Partial<Record<BankFileFormatId, string>> = {
  nordea: 'bank_export_nordea',
  seb: 'bank_export_seb',
  swedbank: 'bank_export_swedbank',
  handelsbanken: 'bank_export_handelsbanken',
  lansforsakringar: 'bank_export_lansforsakringar',
  ica_banken: 'bank_export_ica_banken',
  skandia: 'bank_export_skandia',
  lunar: 'bank_export_lunar',
  northmill: 'bank_export_northmill',
  avanza: 'bank_export_avanza',
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [formatOverride, setFormatOverride] = useState<BankFileFormatId | undefined>(undefined)

  // A BG Max file (Bankgirot's deposit specification, crm#1170) comes as
  // .txt, .bgm, .dat or with no extension at all: the content decides what it is.
  // Excel (.xls/.xlsx): some banks give account history only as a workbook,
  // Länsförsäkringar's kontoutdrag one file per month (crm#1236).
  const acceptedExtensions = '.csv,.txt,.xml,.bgm,.bgmax,.dat,.xls,.xlsx'

  // One rule for a dropped and a picked file: the picker's accept filter can
  // be switched to "all files", and a dropped file never had it.
  const handleFile = useCallback((file: File) => {
    const name = file.name.toLowerCase()
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
    if (!['.csv', '.txt', '.xml', '.bgm', '.bgmax', '.dat', '.xls', '.xlsx', ''].includes(extension)) return
    setSelectedFile(file)
    onFileSelect(file, formatOverride)
  }, [onFileSelect, formatOverride])

  const exportPathKey = formatOverride ? EXPORT_PATH_KEYS[formatOverride] : undefined

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
            <ArrowUpTrayIcon className="h-5 w-5" />
            {t('bank_upload_title')}
          </CardTitle>
          <CardDescription>{t('bgmax_upload_hint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Format override, with the chosen bank's export path under it */}
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <label className="text-sm font-medium whitespace-nowrap">{t('bank_format_label')}</label>
              <Select
                value={formatOverride || 'auto'}
                onValueChange={handleFormatChange}
              >
                <SelectTrigger className="w-full sm:w-64">
                  <SelectValue placeholder={t('bank_format_auto')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('bank_format_auto')}</SelectItem>
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
                  <SelectItem value="avanza">Avanza</SelectItem>
                  <SelectItem value="wise">Wise</SelectItem>
                  <SelectItem value="wise_statement">{t('bank_format_wise_statement')}</SelectItem>
                  <SelectItem value="camt053">ISO 20022 camt.053 (XML)</SelectItem>
                  <SelectItem value="generic_csv">{t('bank_format_generic_csv')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {exportPathKey && <p className="text-xs text-muted-foreground">{t(exportPathKey)}</p>}
          </div>

          {/* Drop zone */}
          <FileDropzone
            onFile={handleFile}
            accept={acceptedExtensions}
            disabled={isLoading}
            invalid={!!error}
            label="Välj bankfil"
            className="relative p-8 text-center"
          >

            {isLoading ? (
              <div className="space-y-4">
                <DocumentTextIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div className="flex items-center justify-center gap-2 text-muted-foreground">
                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Analyserar fil...
                </div>
              </div>
            ) : selectedFile && detectedFormat ? (
              <div className="space-y-4">
                <CheckCircleIcon className="mx-auto h-12 w-12 text-success" />
                <div>
                  <p className="font-medium">{selectedFile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(1)} KB
                  </p>
                  <Badge variant="secondary" className="mt-2">
                    <BuildingLibraryIcon className="mr-1 h-3 w-3" />
                    {detectedFormat === 'wise_statement'
                      ? t('bank_format_wise_statement')
                      : detectedFormatName || FORMAT_NAMES[detectedFormat] || detectedFormat}
                  </Badge>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <ArrowUpTrayIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">Dra och släpp bankfil här</p>
                  <p className="font-medium sm:hidden">Tryck för att välja bankfil</p>
                  <p className="text-sm text-muted-foreground">
                    {t('bank_upload_formats')}
                  </p>
                </div>
              </div>
            )}
          </FileDropzone>

          {/* Skattekonto redirect: not an error, a pointer to the right flow */}
          {skattekontoDetected && (
            <div className="p-4 rounded-lg flex gap-3 bg-control shadow-raised">
              <ExclamationCircleIcon className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
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
            <div className="bg-destructive/8 p-4 rounded-lg flex gap-3">
              <ExclamationCircleIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">{errorTitle || 'Kunde inte läsa filen'}</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
