'use client'

import { useState } from 'react'
import { PaperAirplaneIcon } from '@/components/icons'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { StandaloneLabel, StandaloneOutcome } from '@/components/standalone/StandalonePage'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { REMINDER_ANSWER_NOTE_MAX } from '@/lib/reminders/answer-limits'
import { cn } from '@/lib/utils'
import type { ReminderResponseType } from '@/types'

/**
 * The answer half of /invoice-action/[token]: "Jag har betalat" or "Något
 * stämmer inte", an optional note, then the thanks. The server page passes
 * every text already worded in the customer's language.
 */

export interface InvoiceActionTexts {
  question: string
  questionHelp: string
  paidOption: string
  paidHelp: string
  disputedOption: string
  disputedHelp: string
  notePaid: string
  noteDisputed: string
  send: string
  thanks: string
  thanksBody: string
  answeredPaid: string
  answeredDisputed: string
  invoiceLabel: string
  errors: { LINK_INVALID: string; NOTE_TOO_LONG: string; default: string }
}

export function AnsweredCard({
  texts,
  response,
}: {
  texts: Pick<InvoiceActionTexts, 'thanks' | 'thanksBody' | 'answeredPaid' | 'answeredDisputed' | 'invoiceLabel'>
  response: ReminderResponseType | null
  invoiceNumber: string | null
}) {
  return (
    <StandaloneOutcome className="mt-5 border-t-hairline pt-4" mark={<StatusGlyph tone="ok" size={16} />} title={texts.thanks}>
      {response === 'marked_paid' ? `${texts.answeredPaid} ` : response === 'disputed' ? `${texts.answeredDisputed} ` : ''}
      {texts.thanksBody}
    </StandaloneOutcome>
  )
}

export function InvoiceActionForm({
  token,
  texts,
  invoiceNumber,
  children,
}: {
  token: string
  texts: InvoiceActionTexts
  invoiceNumber: string | null
  /** The invoice card, shown above the question until the customer has answered. */
  children: React.ReactNode
}) {
  const [answer, setAnswer] = useState<ReminderResponseType | null>(null)
  const [note, setNote] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)

  async function submit() {
    if (!answer) return
    setIsSubmitting(true)
    setError(null)
    try {
      const response = await fetch('/api/invoices/reminders/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action: answer, note: note.trim() || null }),
      })
      if (response.ok) {
        setAnswered(true)
        return
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      // Answered already (another tab, a double click): the thanks says the same.
      if (body?.error === 'ALREADY_ANSWERED') setAnswered(true)
      else if (body?.error === 'LINK_INVALID' || body?.error === 'NOTE_TOO_LONG') setError(texts.errors[body.error])
      else setError(texts.errors.default)
    } catch {
      // The request never reached us: the customer may try again.
      setError(texts.errors.default)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (answered) return <AnsweredCard texts={texts} response={answer} invoiceNumber={invoiceNumber} />

  const options = [
    { value: 'marked_paid', label: texts.paidOption, help: texts.paidHelp },
    { value: 'disputed', label: texts.disputedOption, help: texts.disputedHelp },
  ] as const

  return (
    <>
      {children}
      <section className="mt-5 flex flex-col gap-3">
        <div role="radiogroup" aria-label={texts.question} className="flex flex-col gap-2">
          <StandaloneLabel>{texts.question}</StandaloneLabel>
          {options.map((option) => {
            const checked = answer === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setAnswer(option.value)}
                className={cn(
                  'flex min-h-[52px] w-full items-center gap-3 rounded-lg bg-control px-3 py-2 text-left shadow-raised transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
                  checked && 'ring-1 ring-inset ring-strong',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-4 w-4 shrink-0 rounded-full border border-muted-foreground',
                    checked && 'border-[5px] border-strong',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-strong">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.help}</span>
                </span>
              </button>
            )
          })}
        </div>

        {answer && (
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, REMINDER_ANSWER_NOTE_MAX))}
            placeholder={answer === 'marked_paid' ? texts.notePaid : texts.noteDisputed}
            aria-label={answer === 'marked_paid' ? texts.notePaid : texts.noteDisputed}
            rows={3}
            maxLength={REMINDER_ANSWER_NOTE_MAX}
          />
        )}
        {error && <AuthFormError message={error} />}
        <Button size="lg" className="w-full" onClick={submit} loading={isSubmitting} disabled={!answer}>
          <PaperAirplaneIcon className="h-4 w-4" />
          {texts.send}
        </Button>
        <p className="text-sm text-foreground">{texts.questionHelp}</p>
      </section>
    </>
  )
}
