'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Upload, FileSpreadsheet, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type RegisterEntity = 'customers' | 'suppliers' | 'articles'

interface RegisterUploadStepProps {
  entity: RegisterEntity
  onFileSelect: (file: File) => void
  isLoading: boolean
  error: string | null
}

export default function RegisterUploadStep({
  entity,
  onFileSelect,
  isLoading,
  error,
}: RegisterUploadStepProps) {
  const t = useTranslations('register_upload_step')
  const [isDragging, setIsDragging] = useState(false)
  const copy =
    entity === 'customers'
      ? { title: t('customers_title'), description: t('customers_description'), hint: t('customers_hint') }
      : entity === 'suppliers'
        ? { title: t('suppliers_title'), description: t('suppliers_description'), hint: t('suppliers_hint') }
        : { title: t('articles_title'), description: t('articles_description'), hint: t('articles_hint') }

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return
    onFileSelect(file)
  }, [onFileSelect])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={cn(
            'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/20 hover:border-muted-foreground/40',
            isLoading && 'pointer-events-none opacity-60',
          )}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t('reading_file')}</p>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium">{t('drop_here')}</p>
              <p className="text-sm text-muted-foreground mt-1">{t('or')}</p>
              <label>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.ods"
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
              <p className="text-xs text-muted-foreground mt-3">XLSX, XLS, CSV, ODS: max 10 MB</p>
            </>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">{t('file_format')}</p>
            <p>{copy.hint}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
