'use client'

import { useCallback, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Upload, FileSpreadsheet, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface OpeningBalanceUploadStepProps {
  onFileSelect: (file: File) => void
  isLoading: boolean
  error: string | null
}

export default function OpeningBalanceUploadStep({
  onFileSelect,
  isLoading,
  error,
}: OpeningBalanceUploadStepProps) {
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
        <CardTitle>Ladda upp fil med ingående balanser</CardTitle>
        <CardDescription>
          Ladda upp en Excel- eller CSV-fil med ditt företags ingående balanser.
          Filen bör innehålla kontonummer och belopp (debet/kredit eller saldo).
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
              <p className="text-sm text-muted-foreground">Läser fil och identifierar kolumner...</p>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium">
                Dra och släpp din fil här
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                eller
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
                  <span>Välj fil</span>
                </Button>
              </label>
              <p className="text-xs text-muted-foreground mt-3">
                XLSX, XLS, CSV, ODS: max 10 MB
              </p>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Info */}
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Filformat</p>
            <p>
              Filen bör ha en rubrikrad med kolumner för kontonummer och belopp.
              Vanliga format stöds automatiskt: t.ex. kolumner som heter &quot;Konto&quot;,
              &quot;Debet&quot;, &quot;Kredit&quot; eller &quot;Saldo&quot;.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
