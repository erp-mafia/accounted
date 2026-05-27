'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Circle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import ReviewCard from './ReviewCard'

type StepId = 'tic' | 'select' | 'narrative' | 'finalize'
type StepStatus = 'pending' | 'in_progress' | 'success' | 'fallback' | 'error'

interface StepConfig {
  id: StepId
  label: string
  fallbackLabel?: string
}

const STEPS: StepConfig[] = [
  { id: 'tic', label: 'Hämtar uppgifter', fallbackLabel: 'Inga företagsuppgifter, fortsätter ändå' },
  { id: 'select', label: 'Identifierar din verksamhet', fallbackLabel: 'Använder standardval' },
  { id: 'narrative', label: 'Sammanfattar', fallbackLabel: 'Standardsammanfattning' },
  { id: 'finalize', label: 'Klar' },
]

interface InitialFields {
  entity_type_label: string
  sni_codes: { code: string; name: string }[]
  purpose: string | null
  city: string | null
  fiscal_period: string | null
  vat_period: string | null
  f_skatt: string | null
  employees: string | null
}

interface ProfilePayload {
  company_id: string
  horizontal_atoms: string[]
  vertical_atoms: string[]
  modifier_atoms: string[]
  is_multi_vertical: boolean
  profile_summary: string
  verification_questions: string[]
  uncertainty_notes: string[]
  composer_model: string
  composed_at: string
}

interface Props {
  companyId: string
  companyName: string
  firstName: string | null
  initialFields: InitialFields
  atomTitles: Record<string, string>
  alreadyVerified: boolean
  existingSummary: string | null
}

export default function AgentOnboarding({
  companyId,
  companyName,
  firstName,
  initialFields,
  atomTitles,
  alreadyVerified,
  existingSummary,
}: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<'building' | 'review' | 'done'>(
    alreadyVerified ? 'review' : 'building',
  )
  const [statuses, setStatuses] = useState<Record<StepId, StepStatus>>({
    tic: 'pending',
    select: 'pending',
    narrative: 'pending',
    finalize: 'pending',
  })
  // Hydrate from props during the initial render so we don't flash an empty
  // ReviewCard for already-verified profiles.
  const [profile, setProfile] = useState<ProfilePayload | null>(() => {
    if (alreadyVerified && existingSummary) {
      return {
        company_id: companyId,
        horizontal_atoms: [],
        vertical_atoms: [],
        modifier_atoms: [],
        is_multi_vertical: false,
        profile_summary: existingSummary,
        verification_questions: [],
        uncertainty_notes: [],
        composer_model: '',
        composed_at: '',
      }
    }
    return null
  })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const setStatus = useCallback((id: StepId, status: StepStatus) => {
    setStatuses((prev) => ({ ...prev, [id]: status }))
  }, [])

  // No started-ref guard: React 19 Strict Mode runs this effect twice in dev.
  // The first invocation's cleanup aborts its fetch; the second invocation
  // makes the request that actually completes. The stream endpoint is
  // idempotent (it upserts agent_profiles on company_id), so a transient
  // duplicate call during Strict Mode rerun is safe.
  useEffect(() => {
    if (alreadyVerified) return

    const controller = new AbortController()
    void runStream(companyId, controller.signal, {
      setStatus,
      onProfile: (p) => setProfile(p),
      onError: (msg) => setErrorMessage(msg),
      onComplete: () => setPhase('review'),
    })

    return () => {
      controller.abort()
    }
  }, [companyId, alreadyVerified, setStatus])

  if (phase === 'review' || phase === 'done') {
    return (
      <ReviewCard
        companyId={companyId}
        companyName={companyName}
        initialFields={initialFields}
        atomTitles={atomTitles}
        profile={profile}
        onVerified={() => router.push('/chat/intake')}
      />
    )
  }

  return (
    <div className="w-full">
      <header className="mb-10 text-center">
        <p className="text-sm uppercase tracking-wider text-muted-foreground">
          {firstName ? `${firstName}, ` : ''}ett ögonblick
        </p>
        <h1 className="font-display text-3xl md:text-4xl tracking-tight mt-2">
          Vi bygger din bokföringsassistent
        </h1>
        <p className="text-muted-foreground mt-3 text-balance">
          Skräddarsyr för {companyName}. Tar oftast under en halv minut.
        </p>
      </header>

      <Card className="border-border">
        <CardContent className="p-6 md:p-8">
          <ol className="space-y-4">
            {STEPS.map((step) => (
              <StepRow key={step.id} step={step} status={statuses[step.id]} />
            ))}
          </ol>

          {errorMessage && (
            <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
              <div>
                <p className="font-medium">Något gick fel</p>
                <p className="text-muted-foreground mt-1">{errorMessage}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => window.location.reload()}
                >
                  Försök igen
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}

function StepRow({ step, status }: { step: StepConfig; status: StepStatus }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">
        {status === 'success' && <Check className="h-4 w-4 text-success" />}
        {status === 'fallback' && <Check className="h-4 w-4 text-warning" />}
        {status === 'in_progress' && <Loader2 className="h-4 w-4 animate-spin text-foreground" />}
        {status === 'pending' && <Circle className="h-4 w-4 text-muted-foreground/50" />}
        {status === 'error' && <AlertTriangle className="h-4 w-4 text-destructive" />}
      </span>
      <span
        className={cn(
          'text-sm leading-6',
          status === 'pending' && 'text-muted-foreground',
          status === 'fallback' && 'text-muted-foreground',
        )}
      >
        {status === 'fallback' && step.fallbackLabel ? step.fallbackLabel : step.label}
      </span>
    </li>
  )
}

async function runStream(
  companyId: string,
  signal: AbortSignal,
  cbs: {
    setStatus: (id: StepId, status: StepStatus) => void
    onProfile: (p: ProfilePayload) => void
    onError: (msg: string) => void
    onComplete: () => void
  },
): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/agent/onboarding/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId }),
      signal,
    })
  } catch (err) {
    if (signal.aborted) return
    cbs.onError(err instanceof Error ? err.message : 'Kunde inte starta byggsekvensen.')
    return
  }

  if (!response.ok || !response.body) {
    cbs.onError(`HTTP ${response.status}: kunde inte starta byggsekvensen.`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line) as
            | { step: StepId; status: StepStatus }
            | { step: 'finalize'; status: 'success'; profile: ProfilePayload }
            | { step: 'error'; status: 'error'; message: string }
            | { step: 'prewarm'; status: StepStatus }

          if (event.step === 'error') {
            cbs.onError(event.message || 'Okänt fel under byggsekvensen.')
            continue
          }

          if (event.step === 'prewarm') {
            // Pre-warm runs after finalize — surface nothing in the UI; the
            // user has already moved to Phase B by then.
            continue
          }

          cbs.setStatus(event.step, event.status as StepStatus)

          if (event.step === 'finalize' && 'profile' in event) {
            cbs.onProfile(event.profile)
            cbs.onComplete()
          }
        } catch {
          // Malformed JSON line — keep reading.
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      cbs.onError(err instanceof Error ? err.message : 'Streamen avbröts.')
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released
    }
  }
}
