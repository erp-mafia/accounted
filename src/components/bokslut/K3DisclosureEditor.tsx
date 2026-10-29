'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpPopover } from '@/components/ui/help-popover'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  contentApplies,
  disclosureAnswersPatch,
  editableDisclosures,
  equityOverridesPatch,
  takesText,
} from '@/lib/bokslut/arsredovisning/disclosures/editor-model'
import type {
  DisclosureAnswer,
  DisclosureAnswers,
  DisclosureEvaluation,
} from '@/lib/bokslut/arsredovisning/disclosures/types'
import {
  USER_CLASSIFIABLE_KINDS,
  equityMovementLabel,
  type EquityMovementKind,
} from '@/lib/bokslut/arsredovisning/equity-kinds'
import type { EquitySpecificationYear } from '@/lib/bokslut/arsredovisning/equity-specification'

const SECTION_HEADING_CLASS = 'font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground'

interface K3DisclosureEditorProps {
  periodId: string
  evaluations: readonly DisclosureEvaluation[]
  answers: DisclosureAnswers
  equityYear: EquitySpecificationYear | null
  equityOverrides: Readonly<Record<string, EquityMovementKind>>
  equityStatementSeparate: boolean
  /** After a save: the narrative's new updated_at, so the page refreshes the document and the check. */
  onSaved: (updatedAt: string | null) => void
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * The K3 disclosure matrix as questions (disclosures/k3-mindre.ts): each
 * requirement the books cannot answer, with the question, the choices or the
 * text it needs, and what is still missing. Saved on its own through the
 * narrative endpoint (only the changed answers are sent; the server merges).
 * The requirement texts are the document's Swedish; the chrome is translated.
 */
export function K3DisclosureEditor({
  periodId,
  evaluations,
  answers,
  equityYear,
  equityOverrides,
  equityStatementSeparate,
  onSaved,
  onDirtyChange,
}: K3DisclosureEditorProps) {
  const t = useTranslations('k3Disclosures')
  const { toast } = useToast()
  const [draft, setDraft] = useState<Record<string, DisclosureAnswer | undefined>>(answers)
  const [draftOverrides, setDraftOverrides] = useState<Record<string, EquityMovementKind | undefined>>(equityOverrides)
  const [separate, setSeparate] = useState(equityStatementSeparate)
  const [saving, setSaving] = useState(false)

  // A saved answer comes back with the refreshed document: start over from it.
  const savedKey = JSON.stringify([answers, equityOverrides, equityStatementSeparate])
  useEffect(() => {
    setDraft(answers)
    setDraftOverrides(equityOverrides)
    setSeparate(equityStatementSeparate)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- savedKey carries the three props
  }, [savedKey])

  const answersPatch = useMemo(() => disclosureAnswersPatch(answers, draft), [answers, draft])
  const overridesPatch = useMemo(
    () => equityOverridesPatch(equityOverrides, draftOverrides),
    [equityOverrides, draftOverrides],
  )
  const dirty =
    Object.keys(answersPatch).length > 0
    || Object.keys(overridesPatch).length > 0
    || separate !== equityStatementSeparate
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const editable = editableDisclosures(evaluations)
  const unsupported = evaluations.filter((e) => e.status === 'unsupported')
  // Verifikat still to classify, and those already classified so the choice can be changed.
  const equityEntries = [...(equityYear?.unclassified ?? []), ...(equityYear?.user_classified ?? [])]

  const setAnswer = (id: string, change: Partial<DisclosureAnswer>) =>
    setDraft((current) => ({ ...current, [id]: { ...(current[id] ?? {}), ...change } }))

  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/narrative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(Object.keys(answersPatch).length > 0 ? { disclosure_answers: answersPatch } : {}),
          ...(Object.keys(overridesPatch).length > 0 ? { equity_movement_overrides: overridesPatch } : {}),
          ...(separate !== equityStatementSeparate ? { equity_statement_separate: separate } : {}),
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(getUserErrorMessage(body?.error))
      toast({ title: t('saved') })
      onSaved(typeof body.data?.updated_at === 'string' ? body.data.updated_at : null)
    } catch (err) {
      toast({
        title: t('save_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <h3 className={SECTION_HEADING_CLASS}>{t('title')}</h3>
        <HelpPopover>{t('help')}</HelpPopover>
      </div>

      {unsupported.length > 0 && (
        <ul className="space-y-2">
          {unsupported.map((e) => (
            <li key={e.id} className="space-y-1 text-sm">
              <Badge variant="destructive">{t('status_unsupported')}</Badge>
              <p>{e.message}</p>
            </li>
          ))}
        </ul>
      )}

      {editable.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('nothing_to_answer')}</p>
      ) : (
        <div className="space-y-6">
          {editable.map((e) => {
            const answer = draft[e.id]
            const showContent = contentApplies(e, answer)
            const choice = e.choices.find((c) => c.value === answer?.choice)
            return (
              <div key={e.id} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{e.title}</p>
                  {e.status === 'missing' && <Badge variant="warning">{t('status_missing')}</Badge>}
                  <span className="text-[11px] text-muted-foreground">{e.sources.join(', ')}</span>
                </div>
                {e.hint && <p className="text-[12.5px] text-muted-foreground">{e.hint}</p>}

                {e.applicability === 'ask' && e.question && (
                  <div className="space-y-2">
                    <Label htmlFor={`k3d-${e.id}-applies`}>{e.question}</Label>
                    <Select
                      value={answer?.applies === true ? 'yes' : answer?.applies === false ? 'no' : ''}
                      onValueChange={(next) => setAnswer(e.id, { applies: next === 'yes' })}
                    >
                      <SelectTrigger id={`k3d-${e.id}-applies`} className="max-w-xs">
                        <SelectValue placeholder={t('choose')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="no">{t('no')}</SelectItem>
                        <SelectItem value="yes">{t('yes')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {showContent && e.choices.length > 0 && (
                  <div className="space-y-2">
                    {e.applicability !== 'ask' && e.question && (
                      <Label htmlFor={`k3d-${e.id}-choice`}>{e.question}</Label>
                    )}
                    <Select
                      value={answer?.choice ?? ''}
                      onValueChange={(next) => setAnswer(e.id, { choice: next })}
                    >
                      <SelectTrigger id={`k3d-${e.id}-choice`} aria-label={e.question ?? e.title}>
                        <SelectValue placeholder={t('choose')} />
                      </SelectTrigger>
                      <SelectContent>
                        {e.choices.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {choice?.text && <p className="text-[12.5px] text-muted-foreground">{choice.text}</p>}
                  </div>
                )}

                {showContent && takesText(e, answer) && (
                  <div className="space-y-2">
                    <Label htmlFor={`k3d-${e.id}-text`}>{e.text_label ?? t('text_label')}</Label>
                    <Textarea
                      id={`k3d-${e.id}-text`}
                      value={answer?.text ?? ''}
                      onChange={(event) => setAnswer(e.id, { text: event.target.value })}
                      rows={3}
                      maxLength={8000}
                    />
                  </div>
                )}

                {showContent && e.producer === 'confirmed' && e.confirmation && (
                  <label className="flex cursor-pointer items-start gap-3 text-sm">
                    <Checkbox
                      id={`k3d-${e.id}-confirmed`}
                      checked={answer?.confirmed === true}
                      onCheckedChange={(checked) => setAnswer(e.id, { confirmed: Boolean(checked) })}
                    />
                    {e.confirmation}
                  </label>
                )}
              </div>
            )
          })}
        </div>
      )}

      {equityEntries.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('equity_title')}</p>
          <p className="text-[12.5px] text-muted-foreground">{t('equity_description')}</p>
          {equityEntries.map((entry) => (
            <div key={entry.journal_entry_id} className="grid gap-2 md:grid-cols-2 md:items-center">
              <p className="text-sm">
                <span className="tabular-nums">{formatDate(entry.entry_date)}</span>{' '}
                {entry.voucher ?? ''} {entry.description ?? ''}{' '}
                <span className="tabular-nums">{formatCurrency(entry.amount)}</span>
              </p>
              <Select
                value={draftOverrides[entry.journal_entry_id] ?? ''}
                onValueChange={(next) =>
                  setDraftOverrides((current) => ({ ...current, [entry.journal_entry_id]: next as EquityMovementKind }))
                }
              >
                <SelectTrigger aria-label={t('equity_kind_label')}>
                  <SelectValue placeholder={t('choose')} />
                </SelectTrigger>
                <SelectContent>
                  {USER_CLASSIFIABLE_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {equityMovementLabel(kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-3 text-sm">
        <Checkbox
          id="k3d-equity-separate"
          checked={separate}
          onCheckedChange={(checked) => setSeparate(Boolean(checked))}
        />
        {t('equity_separate')}
      </label>

      <div>
        <Button type="button" size="sm" onClick={() => void save()} loading={saving} disabled={!dirty}>
          {t('save')}
        </Button>
      </div>
    </div>
  )
}
