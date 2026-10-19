'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Lightbulb, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/info-tooltip'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { OpenSuggestion } from '@/lib/suggestions/types'

/**
 * The Förslag cards in Att göra: one per open suggestion (at most three,
 * ranked; lib/suggestions/list.ts), the same records the customer's agent
 * finds in its briefing. The question and the reason are the record's own
 * plain Swedish, as every staged operation's title is; the chrome around
 * them is translated. Each card is one line: the question with the reason
 * as its hover hint, Ja, and a menu with the two ways to say no.
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
  const tCommon = useTranslations('common')
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
        const titleId = `suggestion-${s.suggestion_id}`
        return (
          <div
            key={s.suggestion_id}
            role="group"
            aria-labelledby={titleId}
            className="flex items-center gap-3 border-b border-border px-1 py-3.5"
          >
            <span className="w-[18px] shrink-0 text-muted-foreground" aria-hidden>
              <Lightbulb className="h-[15px] w-[15px]" />
            </span>
            <p id={titleId} className="min-w-0 flex-1 text-[13px]">
              {s.reason ? (
                // The reason is the question's hover (and focus) hint. A
                // tooltip, not a title attribute: the reason names the
                // counterparty, and replays record attributes unmasked.
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {s.title}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start" className="max-w-sm" data-ph-mask="">
                    {s.reason}
                  </TooltipContent>
                </Tooltip>
              ) : (
                s.title
              )}
            </p>
            <Button
              size="sm"
              className="shrink-0"
              loading={working && busy?.answer === 'yes'}
              disabled={working}
              onClick={() => (s.operation_type === 'create_grant' ? setConfirming(s) : void answer(s, 'yes'))}
            >
              {t('suggestion_yes')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={working}
                  aria-label={tCommon('more_options')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void answer(s, 'not_now')}>{t('suggestion_not_now')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void answer(s, 'never')}>{t('suggestion_never')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('suggestion_grant_confirm_title')}
        description={
          confirming
            ? `${confirming.title} ${t(
                // A rule for a supplier's invoices (create_grant:supplier-<id>) says what it books.
                confirming.suggestion_key.startsWith('create_grant:supplier-')
                  ? 'suggestion_grant_confirm_description_supplier'
                  : 'suggestion_grant_confirm_description',
              )}`
            : undefined
        }
        confirmLabel={t('suggestion_grant_confirm')}
        onConfirm={async () => {
          if (confirming) await answer(confirming, 'yes')
        }}
      />
    </div>
  )
}
