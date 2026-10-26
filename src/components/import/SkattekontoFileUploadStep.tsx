'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  ArrowUpTrayIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  SpinnerIcon,
} from '@/components/icons'

interface SkattekontoFileUploadStepProps {
  onFileSelect: (file: File) => void
  isLoading: boolean
  error: string | null
  errorTitle?: string | null
}

const ACCEPTED_EXTENSIONS = ['.csv', '.txt', '.skv']

export default function SkattekontoFileUploadStep({
  onFileSelect,
  isLoading,
  error,
  errorTitle,
}: SkattekontoFileUploadStepProps) {
  const t = useTranslations('import')

  const acceptFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      const name = file.name.toLowerCase()
      if (ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        onFileSelect(file)
      }
    },
    [onFileSelect],
  )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowUpTrayIcon className="h-5 w-5" />
            {t('skattekonto_upload_title')}
            {/* Where Skatteverket keeps the file: the description says what
                to download, the clicks live behind the "?". */}
            <HelpPopover className="shrink-0">
              <p>{t('skattekonto_howto_steps')}</p>
              <p className="mt-2">{t('skattekonto_howto_note')}</p>
            </HelpPopover>
          </CardTitle>
          <CardDescription>{t('skattekonto_upload_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FileDropzone
            onFile={acceptFile}
            accept={ACCEPTED_EXTENSIONS.join(',')}
            disabled={isLoading}
            invalid={!!error}
            label={t('skattekonto_tap_select')}
            className="relative p-8 text-center"
          >

            {isLoading ? (
              <div className="space-y-4">
                <DocumentTextIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div className="flex items-center justify-center gap-2 text-muted-foreground">
                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {t('skattekonto_analyzing')}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <ArrowUpTrayIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">{t('skattekonto_drop_here')}</p>
                  <p className="font-medium sm:hidden">{t('skattekonto_tap_select')}</p>
                  <p className="text-sm text-muted-foreground">{t('skattekonto_file_types')}</p>
                </div>
              </div>
            )}
          </FileDropzone>

          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex gap-3">
              <ExclamationCircleIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">
                  {errorTitle || t('skattekonto_error_title')}
                </p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
