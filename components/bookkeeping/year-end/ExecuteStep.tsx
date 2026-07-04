'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { Lock, Loader2 } from 'lucide-react'

interface ExecuteStepProps {
  periodName: string
  isRunning: boolean
  error: string | null
  onBack: () => void
  onExecute: () => Promise<void>
}

/**
 * Final confirmation before executing year-end. Uses the destructive confirm
 * dialog because year-end is irreversible per BFL: once the period is closed,
 * no further entries can be posted to it and the closing transaction is
 * immutable.
 */
export function ExecuteStep({ periodName, isRunning, error, onBack, onExecute }: ExecuteStepProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Klar att verkställa
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            När du verkställer bokslutet för <strong>{periodName}</strong> kommer följande att hända
            i en transaktion:
          </p>
          <ul className="text-sm space-y-2 list-disc pl-5 text-muted-foreground">
            <li>Kursrevaluering bokas för öppna poster i utländsk valuta (om relevant)</li>
            <li>Bokslutsverifikationen skapas och nollställer klass 3-8</li>
            <li>Perioden låses och stängs (oåterkalleligt enligt BFL)</li>
            <li>En ny räkenskapsperiod skapas och får ingående balanser från balansräkningen</li>
            <li>IB/UB-kontinuitet verifieras</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Det här går inte att ångra. Om du behöver göra rättelser efter bokslutet använder du
            stornering eller bokar i den nya perioden.
          </p>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={isRunning}>
          Tillbaka
        </Button>
        <Button
          variant="destructive"
          onClick={() => setConfirmOpen(true)}
          disabled={isRunning}
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Verkställer bokslut…
            </>
          ) : (
            <>Verkställ bokslut</>
          )}
        </Button>
      </div>

      <DestructiveConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Verkställ bokslut?"
        description={`${periodName} kommer att stängas och låsas. Detta är oåterkalleligt enligt Bokföringslagen.`}
        confirmLabel="Ja, verkställ"
        cancelLabel="Avbryt"
        onConfirm={onExecute}
      />
    </div>
  )
}
