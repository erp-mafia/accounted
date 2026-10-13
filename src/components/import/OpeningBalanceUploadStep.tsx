'use client'

import { useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Upload, FileSpreadsheet, AlertCircle, Loader2 } from 'lucide-react'
import { FileDropzone } from '@/components/ui/file-dropzone'

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
  const ACCEPTED_TYPES = '.xlsx,.xls,.csv,.ods'

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['xlsx', 'xls', 'csv', 'ods'].includes(ext)) {
      return
    }
    onFileSelect(file)
  }, [onFileSelect])

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
        <FileDropzone
          onFile={handleFile}
          accept={ACCEPTED_TYPES}
          disabled={isLoading}
          label="Välj fil med ingående balanser"
          className="flex flex-col items-center justify-center p-10"
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
              {/* The zone is the button: this only looks like one. */}
              <Button variant="outline" size="sm" className="mt-2" asChild>
                <span>Välj fil</span>
              </Button>
              <p className="text-xs text-muted-foreground mt-3">
                XLSX, XLS, CSV, ODS: max 10 MB
              </p>
            </>
          )}
        </FileDropzone>

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
