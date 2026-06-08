'use client'

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Upload, FileText, AlertCircle, CheckCircle, Loader2, XCircle, RefreshCw } from 'lucide-react'

const LOADING_PHASES = [
  { message: 'Läser fil...', progress: 10 },
  { message: 'Identifierar teckenkodning...', progress: 30 },
  { message: 'Tolkar SIE-data...', progress: 55 },
  { message: 'Matchar konton mot BAS-kontoplanen...', progress: 85 },
] as const

interface SIEUploadStepProps {
  onFileSelect: (file: File) => void
  isLoading: boolean
  error: string | null
  errorType?: 'duplicate' | 'duplicate_period' | 'validation' | 'parse' | 'network'
  validationErrors?: string[]
  validationWarnings?: string[]
  duplicateImportId?: string | null
  onReplace?: (importId: string) => Promise<void>
  isReplacing?: boolean
}

export default function SIEUploadStep({ onFileSelect, isLoading, error, errorType, validationErrors, validationWarnings, duplicateImportId, onReplace, isReplacing }: SIEUploadStepProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [loadingPhase, setLoadingPhase] = useState(0)

  // Cycle through loading phases on timers
  useEffect(() => {
    if (!isLoading) {
      setLoadingPhase(0)
      return
    }

    const timers = [
      setTimeout(() => setLoadingPhase(1), 2000),
      setTimeout(() => setLoadingPhase(2), 4000),
      setTimeout(() => setLoadingPhase(3), 7000),
    ]

    return () => timers.forEach(clearTimeout)
  }, [isLoading])

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
      if (file.name.toLowerCase().endsWith('.sie') || file.name.toLowerCase().endsWith('.se')) {
        setSelectedFile(file)
        onFileSelect(file)
      }
    }
  }, [onFileSelect])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      setSelectedFile(files[0])
      onFileSelect(files[0])
    }
  }, [onFileSelect])

  const phase = LOADING_PHASES[loadingPhase]

  // Full-card takeover while analyzing the file
  if (isLoading && selectedFile) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-8 pb-8">
            <div className="flex flex-col items-center text-center space-y-6">
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
              <div className="space-y-1">
                <p className="font-medium text-lg">{phase.message}</p>
                <p className="text-sm text-muted-foreground">
                  {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                </p>
              </div>
              <Progress value={phase.progress} className="w-64 mx-auto transition-all duration-1000" />
              <p className="text-xs text-muted-foreground">
                Lämna inte sidan förrän analysen är klar
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Ladda upp SIE-fil
          </CardTitle>
          <CardDescription>
            Exportera en SIE4-fil från ditt nuvarande bokföringssystem (Fortnox, Visma, etc.)
            och ladda upp den här för att importera din bokföring.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Drop zone */}
          <div
            className={`
              relative border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer hover:border-primary/50
              ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
              ${error ? 'border-destructive bg-destructive/5' : ''}
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => document.getElementById('file-input')?.click()}
          >
            <input
              id="file-input"
              type="file"
              accept=".sie,.se"
              className="hidden"
              onChange={handleFileInput}
              disabled={isLoading}
            />

            {selectedFile ? (
              <div className="space-y-4">
                <CheckCircle className="mx-auto h-12 w-12 text-success" />
                <div>
                  <p className="font-medium">{selectedFile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">Dra och släpp SIE-fil här</p>
                  <p className="font-medium sm:hidden">Tryck för att välja SIE-fil</p>
                  <p className="text-sm text-muted-foreground hidden sm:block">eller klicka för att välja fil</p>
                  <p className="text-sm text-muted-foreground sm:hidden">.sie eller .se-filer</p>
                </div>
              </div>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="mt-4 space-y-3">
              <div className={`p-4 rounded-lg flex gap-3 ${
                errorType === 'duplicate' || errorType === 'duplicate_period'
                  ? 'bg-warning/10 border border-warning/20'
                  : 'bg-destructive/10 border border-destructive/20'
              }`}>
                <AlertCircle className={`h-5 w-5 flex-shrink-0 mt-0.5 ${
                  errorType === 'duplicate' || errorType === 'duplicate_period'
                    ? 'text-warning'
                    : 'text-destructive'
                }`} />
                <div className="space-y-1.5 min-w-0">
                  <p className={`font-medium ${
                    errorType === 'duplicate' || errorType === 'duplicate_period'
                      ? 'text-warning'
                      : 'text-destructive'
                  }`}>
                    {errorType === 'duplicate' && 'Filen har redan importerats'}
                    {errorType === 'duplicate_period' && 'Överlappande räkenskapsår'}
                    {errorType === 'validation' && 'Filen innehåller valideringsfel'}
                    {errorType === 'parse' && 'Kunde inte tolka filen'}
                    {errorType === 'network' && 'Uppladdningen misslyckades'}
                    {!errorType && 'Ett fel uppstod'}
                  </p>
                  <p className="text-sm text-muted-foreground">{error}</p>

                  {/* Actionable guidance */}
                  <div className="text-sm text-muted-foreground pt-1 border-t border-border/50 mt-2">
                    {(errorType === 'duplicate' || errorType === 'duplicate_period') && (
                      <div className="space-y-2">
                        <p>Den befintliga importens verifikationer kommer att makuleras (status ändras till &quot;makulerad&quot;). De finns kvar som spårbar historik.</p>
                        {duplicateImportId && onReplace && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-warning/50 text-warning hover:bg-warning/10"
                            disabled={isReplacing}
                            onClick={(e) => {
                              e.stopPropagation()
                              onReplace(duplicateImportId)
                            }}
                          >
                            {isReplacing ? (
                              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Ersätter...</>
                            ) : (
                              <><RefreshCw className="h-4 w-4 mr-2" />Ersätt befintlig import</>
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                    {errorType === 'validation' && (
                      <p>Prova att exportera filen igen från ditt bokföringsprogram. Om felet kvarstår, kontrollera att alla verifikationer är korrekt bokförda i källsystemet.</p>
                    )}
                    {errorType === 'parse' && (
                      <p>Kontrollera att filen är en SIE4-fil exporterad från ett bokföringsprogram (Fortnox, Visma, Bokio etc). Filen kan vara skadad om den redigerats manuellt.</p>
                    )}
                    {errorType === 'network' && (
                      <p>Kontrollera din internetanslutning och försök igen. Om problemet kvarstår, prova att ladda upp filen från en dator eller hör av dig till support.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Validation errors list */}
              {validationErrors && validationErrors.length > 0 && (
                <div className="p-4 bg-destructive/5 border border-destructive/15 rounded-lg space-y-2">
                  <p className="text-sm font-medium text-destructive">Fel som blockerar import ({validationErrors.length})</p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {validationErrors.map((err, i) => (
                      <div key={i} className="text-sm flex gap-2">
                        <XCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">{err}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Validation warnings list */}
              {validationWarnings && validationWarnings.length > 0 && (
                <div className="p-4 bg-warning/5 border border-warning/15 rounded-lg space-y-2">
                  <p className="text-sm font-medium text-warning">Varningar ({validationWarnings.length})</p>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {validationWarnings.map((warn, i) => (
                      <div key={i} className="text-sm flex gap-2">
                        <AlertCircle className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">{warn}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Vad är SIE?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              SIE (Standard Import Export) är det svenska standardformatet för att överföra
              bokföringsdata mellan system. Det används av alla större bokföringsprogram i Sverige.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Vilken SIE-typ?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <ul className="space-y-1">
              <li><strong>SIE4</strong> - Full historik med alla verifikationer (rekommenderas)</li>
              <li><strong>SIE1</strong> - Endast årssaldon (enklare import)</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Export instructions */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base">Så exporterar du från...</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <div>
            <p className="font-medium">Fortnox</p>
            <p className="text-muted-foreground">Inställningar → Import/Export → Exportera SIE</p>
          </div>
          <div>
            <p className="font-medium">Visma</p>
            <p className="text-muted-foreground">Rapporter → Övrigt → Exportera till SIE</p>
          </div>
          <div>
            <p className="font-medium">Bokio</p>
            <p className="text-muted-foreground">Inställningar → Bokföring → Exportera SIE-fil</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
