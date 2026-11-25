'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { CheckIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import {
  currentQuestionId,
  isWalkFinished,
  startWalk,
  walkPosition,
  walkReduce,
  type WalkQuestion,
} from '@/lib/onboarding/question-first'
import { saveUiState } from '@/lib/ui-state/client'

/** The longest answer in the person's own words (APP_ANSWER_MAX in lib/questions/app-answer.ts). */
const OWN_WORDS_MAX = 1000

interface HemQuestionFirstProps {
  /** The questions to walk, in order (lib/onboarding/question-first walkQuestions). */
  questions: WalkQuestion[]
  companyId: string
}

/**
 * Hem for a new company with open questions: one question at a time, each
 * answered with one press, passed with "Inte nu" (it stays open under
 * Frågor) or answered in the person's own words. The answer is the question
 * list's own route, so the saved sentence and the ten-minute undo are the
 * list's. When the walk is through, the time is saved and Hem shows what
 * comes next.
 */
export function HemQuestionFirst({ questions, companyId }: HemQuestionFirstProps) {
  const t = useTranslations('dashboard')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const router = useRouter()
  const [state, dispatch] = useReducer(walkReduce, questions, (list) => startWalk(list.map((q) => q.question_id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ownText, setOwnText] = useState('')
  const [finishFailed, setFinishFailed] = useState(false)
  const finishing = useRef(false)

  const finished = isWalkFinished(state)
  const currentId = currentQuestionId(state)
  const current = questions.find((q) => q.question_id === currentId) ?? null
  const { position, total } = walkPosition(state)

  const write = useCallback(
    async (id: string, path: 'answer' | 'reopen', body: unknown, fallback: string): Promise<unknown | null> => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(`/api/questions/${id}/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          notifySessionExpired(res)
          setError((await getResponseErrorMessage(res, undefined, locale)) || fallback)
          return null
        }
        const answer = (await res.json()) as { data?: unknown }
        return answer.data ?? {}
      } catch {
        setError(fallback)
        return null
      } finally {
        setBusy(false)
      }
    },
    [locale],
  )

  async function answer(body: { option_id: string } | { text: string }) {
    if (!current) return
    const data = await write(current.question_id, 'answer', body, t('question_first_action_failed'))
    if (data === null) return
    const fact = typeof data === 'object' && data && 'fact' in data && typeof data.fact === 'string' ? data.fact : ''
    setOwnText('')
    dispatch({ type: 'answered', id: current.question_id, fact })
  }

  async function undo() {
    if (!state.last) return
    const id = state.last.id
    const data = await write(id, 'reopen', {}, t('question_first_undo_failed'))
    if (data === null) return
    dispatch({ type: 'undone', id })
  }

  function notNow() {
    if (!current) return
    setError(null)
    setOwnText('')
    dispatch({ type: 'passed', id: current.question_id })
  }

  const finish = useCallback(async () => {
    if (finishing.current) return
    finishing.current = true
    setFinishFailed(false)
    try {
      const res = await saveUiState({ hem_questions_passed: { [companyId]: new Date().toISOString() } })
      if (!res.ok) throw new Error('save failed')
      router.refresh()
    } catch {
      setFinishFailed(true)
      finishing.current = false
    }
  }, [companyId, router])

  useEffect(() => {
    if (finished) void finish()
  }, [finished, finish])

  const lead = state.last ? (
    <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <CheckIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('question_first_saved', { fact: state.last.fact })}</span>
      </span>
      {!finished && (
        <Button type="button" variant="link" className="h-auto p-0 text-[13px]" onClick={undo} disabled={busy}>
          {t('question_first_undo')}
        </Button>
      )}
    </div>
  ) : (
    <p className="text-[13px] text-muted-foreground">
      {total === 1 ? t('question_first_lead_one') : t('question_first_lead_many', { count: total })}
    </p>
  )

  if (finished) {
    return (
      <section className="stagger-enter max-w-xl space-y-3" aria-live="polite">
        {lead}
        {finishFailed && (
          <div className="flex flex-wrap items-center gap-x-3">
            <p className="text-[13px] text-destructive" role="alert">
              {t('first_thing_close_failed')}
            </p>
            <Button type="button" variant="link" className="h-auto p-0 text-[13px]" onClick={() => void finish()}>
              {t('question_first_retry')}
            </Button>
          </div>
        )}
      </section>
    )
  }
  if (!current) return null

  const own = ownText.trim()

  return (
    <section className="stagger-enter max-w-xl space-y-6" aria-labelledby="hem-question-first-title">
      <div className="space-y-2">
        {lead}
        <h2 id="hem-question-first-title" className="text-[20px] font-medium text-strong" data-ph-mask="">
          {current.question}
        </h2>
        {current.why && (
          <p className="text-[13px] text-muted-foreground" data-ph-mask="">
            {current.why}
          </p>
        )}
      </div>

      {current.options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {current.options.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void answer({ option_id: option.id })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (own) void answer({ text: own })
          }}
        >
          <Input
            value={ownText}
            onChange={(event) => setOwnText(event.target.value)}
            maxLength={OWN_WORDS_MAX}
            disabled={busy}
            aria-label={t('question_first_text_label')}
            className="min-w-0 flex-1 basis-48"
          />
          <Button type="submit" variant="outline" disabled={busy || !own}>
            {t('question_first_submit')}
          </Button>
        </form>
      )}

      {error && (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span className="tabular-nums">{t('question_first_position', { position, total })}</span>
        <Button type="button" variant="ghost" onClick={notNow} disabled={busy}>
          {t('question_first_not_now')}
        </Button>
      </div>
    </section>
  )
}
