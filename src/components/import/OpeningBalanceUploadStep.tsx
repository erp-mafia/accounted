'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Upload, FileSpreadsheet, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface OpeningBalanceUploadStepProps {
  onFileSelect: (file: File) => void
  isLoading: boolean
  error: string | null
  /** Optional action rendered under the error text (e.g. route to the bank importer) */
  errorAction?: { label: string; onClick: () => void }
}

export default function OpeningBalanceUploadStep({
  onFileSelect,
  isLoading,
  error,
  errorAction,
}: OpeningBalanceUploadStepProps) {
  const t = useTranslations('opening_balance_upload_step')
  const [isDragging, setIsDragging] = useState(false)

  const ACCEPTED_TYPES = '.xlsx,.xls,.csv,.ods'

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['xlsx', 'xls', 'csv', 'ods'].includes(ext)) {
      return
    }
    onFileSelect(file)
  }, [onFileSelect])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone */}
        <div
          className={cn(
            'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/20 hover:border-muted-foreground/40',
            isLoading && 'pointer-events-none opacity-60',
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t('reading_file')}</p>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium">
                {t('drop_here')}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {t('or')}
              </p>
              <label>
                <input
                  type="file"
                  accept={ACCEPTED_TYPES}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFile(file)
                    e.target.value = ''
                  }}
                />
                <Button variant="outline" size="sm" className="mt-2" asChild>
                  <span>{t('choose_file')}</span>
                </Button>
              </label>
              <p className="text-xs text-muted-foreground mt-3">
                {t('accepted_formats')}
              </p>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p className="text-sm text-destructive">{error}</p>
              {errorAction && (
                <Button variant="outline" size="sm" onClick={errorAction.onClick}>
                  {errorAction.label}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Info */}
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">{t('file_format_title')}</p>
            <p>{t('file_format_body')}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
