'use client'

import { useState } from 'react'
import { ChatBubbleLeftIcon, CheckCircleIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
  invoiceNumber,
}: {
  texts: Pick<InvoiceActionTexts, 'thanks' | 'thanksBody' | 'answeredPaid' | 'answeredDisputed' | 'invoiceLabel'>
  response: ReminderResponseType | null
  invoiceNumber: string | null
}) {
  return (
    <Card className="w-full">
      <CardContent className="pt-6 text-center">
        <CheckCircleIcon className="h-12 w-12 text-success mx-auto mb-4" />
        <h2 className="text-lg mb-2">{texts.thanks}</h2>
        <p className="text-muted-foreground mb-4">
          {response === 'marked_paid' ? `${texts.answeredPaid} ` : response === 'disputed' ? `${texts.answeredDisputed} ` : ''}
          {texts.thanksBody}
        </p>
        <div className="bg-muted rounded-lg p-4 text-left">
          <p className="text-sm text-muted-foreground">{texts.invoiceLabel}</p>
          <p className="font-medium">{invoiceNumber}</p>
        </div>
      </CardContent>
    </Card>
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
    { value: 'marked_paid', label: texts.paidOption, help: texts.paidHelp, icon: <CheckCircleIcon className="h-5 w-5 text-success" /> },
    { value: 'disputed', label: texts.disputedOption, help: texts.disputedHelp, icon: <ChatBubbleLeftIcon className="h-5 w-5 text-muted-foreground" /> },
  ] as const

  return (
    <>
      {children}
      <Card>
        <CardHeader>
          <CardTitle>{texts.question}</CardTitle>
          <CardDescription>{texts.questionHelp}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div role="radiogroup" aria-label={texts.question} className="space-y-3">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={answer === option.value}
                onClick={() => setAnswer(option.value)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                  answer === option.value ? 'border-foreground bg-muted' : 'border-border hover:bg-secondary/60',
                )}
              >
                {option.icon}
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-sm text-muted-foreground">{option.help}</span>
                </span>
              </button>
            ))}
          </div>

          {answer && (
            <div className="space-y-3 pt-1">
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, REMINDER_ANSWER_NOTE_MAX))}
                placeholder={answer === 'marked_paid' ? texts.notePaid : texts.noteDisputed}
                aria-label={answer === 'marked_paid' ? texts.notePaid : texts.noteDisputed}
                rows={3}
                maxLength={REMINDER_ANSWER_NOTE_MAX}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button className="w-full" onClick={submit} loading={isSubmitting}>
                {texts.send}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}
