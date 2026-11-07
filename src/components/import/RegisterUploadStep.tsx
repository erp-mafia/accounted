'use client'

import { useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  ArrowUpTrayIcon,
  ExclamationCircleIcon,
  SpinnerIcon,
  TableCellsIcon,
} from '@/components/icons'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { ARTICLE_BROWSER_MAX_FILE_BYTES } from '@/lib/import/articles/browser-parse'

export type RegisterEntity = 'customers' | 'suppliers' | 'articles'

interface RegisterUploadStepProps {
  entity: RegisterEntity
  onFileSelect: (file: File) => void
  isLoading: boolean
  error: string | null
}

const COPY: Record<RegisterEntity, { title: string; description: string; hint: string }> = {
  customers: {
    title: 'Ladda upp fil med kunder',
    description:
      'Ladda upp en Excel- eller CSV-fil med ditt kundregister. Filen bör innehålla minst en kolumn med kundnamn.',
    hint:
      'Vanliga kolumner identifieras automatiskt: t.ex. "Namn", "Orgnr", "E-post", "Telefon", "Adress", "Postort".',
  },
  suppliers: {
    title: 'Ladda upp fil med leverantörer',
    description:
      'Ladda upp en Excel- eller CSV-fil med ditt leverantörsregister. Filen bör innehålla minst en kolumn med leverantörsnamn.',
    hint:
      'Vanliga kolumner identifieras automatiskt: t.ex. "Namn", "Orgnr", "Bankgiro", "Plusgiro", "IBAN", "E-post".',
  },
  articles: {
    title: 'Ladda upp fil med artiklar',
    description:
      'Ladda upp en Excel- eller CSV-fil med ditt artikelregister. Filen bör innehålla minst en kolumn med benämning. Filer exporterade från Fortnox, Visma och Bokio känns igen automatiskt.',
    hint:
      'Vanliga kolumner identifieras automatiskt: t.ex. "Benämning", "Artikelnummer", "Pris", "Moms", "Enhet", "Försäljningskonto".',
  },
}

export default function RegisterUploadStep({
  entity,
  onFileSelect,
  isLoading,
  error,
}: RegisterUploadStepProps) {
  const copy = COPY[entity]

  const handleFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return
    onFileSelect(file)
  }, [onFileSelect])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FileDropzone
          onFile={handleFile}
          accept=".xlsx,.xls,.csv,.ods"
          disabled={isLoading}
          label={copy.title}
          className="flex flex-col items-center justify-center p-10"
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-3">
              <SpinnerIcon className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Läser fil och identifierar kolumner...</p>
            </div>
          ) : (
            <>
              <ArrowUpTrayIcon className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium">Dra och släpp din fil här</p>
              <p className="text-sm text-muted-foreground mt-1">eller</p>
              {/* The zone is the button: this only looks like one. */}
              <Button variant="outline" size="sm" className="mt-2" asChild>
                <span>Välj fil</span>
              </Button>
              {/* Articles are read in the browser (crm#1383), not posted. */}
              <p className="text-xs text-muted-foreground mt-3">
                XLSX, XLS, CSV, ODS: max {entity === 'articles' ? ARTICLE_BROWSER_MAX_FILE_BYTES / 1024 / 1024 : 10} MB
              </p>
            </>
          )}
        </FileDropzone>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <ExclamationCircleIcon className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
          <TableCellsIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Filformat</p>
            <p>{copy.hint}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
