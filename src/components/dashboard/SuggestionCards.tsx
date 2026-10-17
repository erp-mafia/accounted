'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { OpenSuggestion } from '@/lib/suggestions/types'

/**
 * The Förslag cards in Att göra: one per open suggestion (at most three,
 * ranked; lib/suggestions/list.ts), the same records the customer's agent
 * finds in its briefing. The question and the reason are the record's own
 * plain Swedish, as every staged operation's title is; the chrome around
 * them is translated.
 *
 * The three answers go through the doors every staged operation has, so an
 * answer here and an answer in chat are the same decision:
 *   Ja          approves the pending operation (the commit route), which
 *               switches the package and writes the receipt and the dated
 *               line in behandlingshistorik; the menu refreshes.
 *   Inte nu     rejects it with the reason "Inte nu": asked again in 30 days.
 *   Visa aldrig rejects it with the reason "Visa aldrig": never asked again.
 * (The database reads the reason, migration 20261016200600.)
 *
 * A rule for automatic booking (create_grant, lib/grants) hands posting
 * authority to agents, so its Ja first asks for a confirmation that says
 * what the rule lets through, as every high-risk approval does.
 */

type Answer = 'yes' | 'not_now' | 'never'

/** The rejection reasons the database reads as snooze and decline. */
const REJECTION_REASON: Record<Exclude<Answer, 'yes'>, string> = {
  not_now: 'Inte nu',
  never: 'Visa aldrig',
}

export function SuggestionCards({
  suggestions,
  onResolved,
}: {
  suggestions: OpenSuggestion[]
  /** Called with the suggestion once it is answered; the parent drops it and refetches the counts. */
  onResolved: (suggestion: OpenSuggestion) => void
}) {
  const t = useTranslations('dashboard')
  const router = useRouter()
  const { toast } = useToast()
  const [busy, setBusy] = useState<{ id: string; answer: Answer } | null>(null)
  const [confirming, setConfirming] = useState<OpenSuggestion | null>(null)

  async function answer(suggestion: OpenSuggestion, choice: Answer) {
    setBusy({ id: suggestion.suggestion_id, answer: choice })
    try {
      const id = suggestion.pending_operation_id
      const res =
        choice === 'yes'
          ? await fetch(`/api/pending-operations/${id}/commit`, { method: 'POST' })
          : await fetch(`/api/pending-operations/${id}/reject`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rejection_category: 'other', rejection_reason: REJECTION_REASON[choice] }),
            })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.error) {
        toast({
          title: t('suggestion_failed_toast'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({
        title:
          choice === 'yes'
            ? t('suggestion_accepted_toast')
            : choice === 'not_now'
              ? t('suggestion_snoozed_toast')
              : t('suggestion_declined_toast'),
      })
      onResolved(suggestion)
      // An approved switch changes what the menu shows.
      if (choice === 'yes') router.refresh()
    } catch {
      toast({ title: t('suggestion_failed_toast'), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      {suggestions.map((s) => {
        const working = busy?.id === s.suggestion_id
        return (
          <div key={s.suggestion_id} className="flex items-start gap-3 border-b border-border px-1 py-3.5">
            <span className="mt-px w-[18px] shrink-0 text-muted-foreground" aria-hidden>
              <Lightbulb className="h-[15px] w-[15px]" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
              <div className="min-w-0">
                <p className="text-[13px]">{s.title}</p>
                {s.reason && <p className="mt-1 text-xs text-muted-foreground">{s.reason}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2" role="group" aria-label={s.title}>
                <Button
                  size="sm"
                  loading={working && busy?.answer === 'yes'}
                  disabled={working}
                  onClick={() => (s.operation_type === 'create_grant' ? setConfirming(s) : void answer(s, 'yes'))}
                >
                  {t('suggestion_yes')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  loading={working && busy?.answer === 'not_now'}
                  disabled={working}
                  onClick={() => void answer(s, 'not_now')}
                >
                  {t('suggestion_not_now')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={working && busy?.answer === 'never'}
                  disabled={working}
                  onClick={() => void answer(s, 'never')}
                >
                  {t('suggestion_never')}
                </Button>
              </div>
            </div>
          </div>
        )
      })}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('suggestion_grant_confirm_title')}
        description={confirming ? `${confirming.title} ${t('suggestion_grant_confirm_description')}` : undefined}
        confirmLabel={t('suggestion_grant_confirm')}
        onConfirm={async () => {
          if (confirming) await answer(confirming, 'yes')
        }}
      />
    </div>
  )
}
