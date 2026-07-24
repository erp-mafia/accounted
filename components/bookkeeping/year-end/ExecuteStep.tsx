'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { Lock, Loader2 } from 'lucide-react'

interface ExecuteStepProps {
  periodName: string
  isRunning: boolean
  error: string | null
  /** Advisory: AB closing a profit year with no bolagsskatt booked. */
  bolagsskattMissing?: boolean
  onBack: () => void
  onExecute: () => Promise<void>
}

/**
 * Final confirmation before executing year-end. Uses the destructive confirm
 * dialog because year-end is irreversible per BFL: once the period is closed,
 * no further entries can be posted to it and the closing transaction is
 * immutable.
 */
export function ExecuteStep({ periodName, isRunning, error, bolagsskattMissing, onBack, onExecute }: ExecuteStepProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center gap-2 px-1">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Klar att verkställa
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="space-y-4 px-1">
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
          {bolagsskattMissing && (
            <p className="text-[12.5px] leading-5 text-attn">
              Ingen bolagsskatt är bokförd trots att året visar vinst. Om det inte är avsiktligt
              (t.ex. underskottsavdrag, periodiseringsfond eller överavskrivningar som nollar det
              skattemässiga resultatet), gå tillbaka och boka skatten i dispositionssteget innan
              du verkställer.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </section>

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={onBack} disabled={isRunning}>
          ← Tillbaka
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
