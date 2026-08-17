'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Upload, FileText, AlertCircle, HelpCircle } from 'lucide-react'

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
  const [isDragging, setIsDragging] = useState(false)

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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      acceptFile(e.dataTransfer.files[0])
    },
    [acceptFile],
  )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {t('skattekonto_upload_title')}
          </CardTitle>
          <CardDescription>{t('skattekonto_upload_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="button"
            tabIndex={isLoading ? -1 : 0}
            aria-label={t('skattekonto_tap_select')}
            className={`
              relative border-2 border-dashed rounded-lg p-8 text-center transition-colors
              ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
              ${error ? 'border-destructive bg-destructive/5' : ''}
              ${isLoading ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:border-primary/50'}
            `}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setIsDragging(false)
            }}
            onDrop={handleDrop}
            onClick={() => document.getElementById('skattekonto-file-input')?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                document.getElementById('skattekonto-file-input')?.click()
              }
            }}
          >
            <input
              id="skattekonto-file-input"
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(',')}
              className="hidden"
              onChange={(e) => acceptFile(e.target.files?.[0])}
              disabled={isLoading}
            />

            {isLoading ? (
              <div className="space-y-4">
                <FileText className="mx-auto h-12 w-12 text-muted-foreground animate-pulse" />
                <p className="text-muted-foreground">{t('skattekonto_analyzing')}</p>
                <Progress value={33} className="w-48 mx-auto" />
              </div>
            ) : (
              <div className="space-y-4">
                <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">{t('skattekonto_drop_here')}</p>
                  <p className="font-medium sm:hidden">{t('skattekonto_tap_select')}</p>
                  <p className="text-sm text-muted-foreground">{t('skattekonto_file_types')}</p>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
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

      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <HelpCircle className="h-4 w-4" />
            {t('skattekonto_howto_title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <div>
            <p className="font-medium">Skatteverket</p>
            <p className="text-muted-foreground">{t('skattekonto_howto_steps')}</p>
          </div>
          <p className="text-muted-foreground">{t('skattekonto_howto_note')}</p>
        </CardContent>
      </Card>
    </div>
  )
}
