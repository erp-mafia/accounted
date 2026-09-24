'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowUpRight, Plus, X } from 'lucide-react'
import { SlideOver, SlideOverContent } from '@/components/ui/slide-over'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { AI_CLIENTS, aiChatLink, aiPrefilledChatLink, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'
import { registrySkillSlug, type RegistrySkillId } from '@/lib/agent-skills/registry'
import { ownSkillSteps } from '@/lib/agent-skills/own-skill-body'
import { formatDateLong } from '@/lib/utils'
import { SkillMarks } from './SkillMarks'
import styles from './skills.module.css'

export type SheetTarget =
  | { kind: 'registry'; id: RegistrySkillId; locked: boolean }
  | { kind: 'own'; slug: string; name: string; installationId: string; draft?: boolean }

/**
 * Opens a chat for the prompt. The chat opens synchronously so the popup is
 * not blocked. With `prefill` the prompt is typed into the new chat through
 * ?q= (see aiPrefilledChatLink): only for curated skills, whose prompt is
 * fixed text plus a skill slug. An own skill's prompt carries the name the
 * user wrote, so it is copied for them to paste into an empty chat instead.
 */
export function copyPromptAndOpen(prompt: string, client: AiClient, prefill = false): Promise<boolean> {
  if (prefill) {
    openAiConnector(aiPrefilledChatLink(client, prompt))
    return Promise.resolve(true)
  }
  const copying = navigator.clipboard?.writeText(prompt) ?? Promise.reject(new Error('No clipboard'))
  openAiConnector(aiChatLink(client))
  return copying.then(() => true, () => false)
}

async function readBody(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Skill body request failed')
  return ((await response.json()).data as { body: string }).body
}

/**
 * The opened skill: a dark, still sheet from the right ("Stilla"). It shows
 * what the skill does and the sentence to say to the AI. The run button
 * opens a chat with a curated skill's prompt already typed in; an own
 * skill's prompt is copied for the user to paste (see copyPromptAndOpen).
 */
export function SkillSheet({ target, companyId, client, canWrite, todo, usage, onClose, onConnect, onEdit, onDelete, onAdd }: {
  target: SheetTarget | null
  companyId: string
  client: AiClient
  canWrite: boolean
  /** How many Att göra items this skill would clear. */
  todo?: number
  /** How often agents ran it in the last half year. */
  usage?: { count: number; last_at: string }
  onClose: () => void
  onConnect: (client: AiClient) => void
  onEdit?: (target: Extract<SheetTarget, { kind: 'own' }>) => void
  onDelete: (target: Extract<SheetTarget, { kind: 'own' }>) => Promise<boolean>
  /** Adds an AI-saved draft so agents can load it. */
  onAdd: (target: Extract<SheetTarget, { kind: 'own' }>) => Promise<boolean>
}) {
  return (
    <SlideOver open={target !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SlideOverContent aria-describedby={undefined} className={styles.sheet}>
        {target && <SheetBody key={target.kind === 'own' ? target.slug : target.id} target={target} companyId={companyId} client={client} canWrite={canWrite} todo={todo} usage={usage} onConnect={onConnect} onEdit={onEdit} onDelete={onDelete} onAdd={onAdd} />}
      </SlideOverContent>
    </SlideOver>
  )
}

function SheetBody({ target, companyId, client, canWrite, todo, usage, onConnect, onEdit, onDelete, onAdd }: {
  target: SheetTarget
  companyId: string
  client: AiClient
  canWrite: boolean
  /** How many Att göra items this skill would clear. */
  todo?: number
  /** How often agents ran it in the last half year. */
  usage?: { count: number; last_at: string }
  onConnect: (client: AiClient) => void
  onEdit?: (target: Extract<SheetTarget, { kind: 'own' }>) => void
  onDelete: (target: Extract<SheetTarget, { kind: 'own' }>) => Promise<boolean>
  /** Adds an AI-saved draft so agents can load it. */
  onAdd: (target: Extract<SheetTarget, { kind: 'own' }>) => Promise<boolean>
}) {
  const t = useTranslations('skills_registry')
  const locale = useLocale()
  const clientName = AI_CLIENTS.find((c) => c.id === client)!.name
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [fullCopy, setFullCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const [addState, setAddState] = useState<'idle' | 'adding' | 'failed'>('idle')

  const own = target.kind === 'own' ? target : null
  const id = target.kind === 'registry' ? target.id : null
  const slug = own ? own.slug : registrySkillSlug(id!, client)
  const title = own ? own.name : t(`skills.${id}.name`)
  const say = own ? t('own_say', { name: own.name }) : t(`skills.${id}.say`)
  const prompt = t('prompt', { say, skill: slug })
  const locked = target.kind === 'registry' && target.locked
  // Fetched as the sheet opens, so the copy runs inside the click and the browser allows it.
  const body = useSWR(!locked ? ['/api/skills', companyId, slug] : null, ([url, , s]) => readBody(`${url}?slug=${encodeURIComponent(s)}`))
  const steps = id ? (t.raw(`skills.${id}.steps`) as string[]) : body.data ? ownSkillSteps(body.data) : []

  function copyFull() {
    const text = body.data
    const copying = text && navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Nothing to copy'))
    void copying.then(() => setFullCopy('copied'), () => setFullCopy('failed'))
  }

  function copyAndOpen() {
    void copyPromptAndOpen(prompt, client, !own).then((ok) => setCopyState(ok ? 'copied' : 'failed'))
  }

  return (
    <div className={styles.sheetBody}>
      <div className={styles.sheetHead}>
        <div className={styles.dtTop}>
          {id && <SkillMarks id={id} />}
          <DialogPrimitive.Title asChild><h2 data-ph-mask={own ? '' : undefined}>{title}</h2></DialogPrimitive.Title>
          <DialogPrimitive.Close asChild><Button variant="outline" size="icon" className="shrink-0 self-start" aria-label={t('close')}><X className="h-4 w-4" aria-hidden /></Button></DialogPrimitive.Close>
        </div>
        <p className={styles.dtD}>{own ? t(own.draft ? 'draft_desc' : 'own_desc') : t(`skills.${id}.desc`)}</p>
        {id && t.has(`skills.${id}.note`) && <p className={styles.dtNote}>{t(`skills.${id}.note`)}</p>}
        {usage && <p className={styles.usesLine}>{t('uses_line', { count: usage.count, date: formatDateLong(usage.last_at, locale) })}</p>}
      </div>
      <div className={styles.sheetMain}>
        {steps.length > 0 && <ol className={styles.steps}>{steps.map((step, i) => <li key={i} data-ph-mask={own ? '' : undefined}>{step}</li>)}</ol>}
        <div className={styles.sheetFoot}>
          {own?.draft ? (
            <div className="flex flex-col gap-2">
              <Button size="lg" className="w-full gap-2" disabled={!canWrite} loading={addState === 'adding'} onClick={() => { setAddState('adding'); void onAdd(own).then((ok) => setAddState(ok ? 'idle' : 'failed')) }}>
                {addState !== 'adding' && <Plus className="h-4 w-4" aria-hidden />}
                {t('add_draft')}
              </Button>
              <div className={styles.nightBtns}>
                <Button variant="outline" size="lg" className="w-full" disabled={!canWrite} onClick={() => setConfirmDelete(true)}>{t('delete')}</Button>
              </div>
              {addState === 'failed' && <p role="alert" className={styles.nightNote}>{t('save_failed')}</p>}
              {deleteFailed && <p role="alert" className={styles.nightNote}>{t('save_failed')}</p>}
            </div>
          ) : locked ? (
            <div className="flex flex-col gap-3">
              <p className={styles.lockedline}>{t('locked_line')}</p>
              <div className={styles.nightBtns}>
                {AI_CLIENTS.map((c, i) => (
                  <Button key={c.id} size="lg" variant={i === 0 ? 'default' : 'outline'} className="w-full" onClick={() => onConnect(c.id)}>
                    {i === 0 ? t('connect_client', { client: c.name }) : c.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {todo ? <p className={styles.todoLine}><b>{todo}</b>{t('sheet_todo', { count: todo })}</p> : null}
              <Button size="lg" className="w-full gap-2" onClick={copyAndOpen}>
                {t('run_client', { client: clientName })}
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Button>
              <p className={styles.goHint}>{t(own ? 'run_hint' : 'run_hint_prefilled', { client: clientName })}</p>
              <div className={styles.nightBtns}>
                <Button variant="outline" size="lg" className="w-full" onClick={copyFull}>{t(fullCopy === 'copied' ? 'copied_full' : 'copy_full')}</Button>
                {own && onEdit && <Button variant="outline" size="lg" className="w-full" disabled={!canWrite} onClick={() => onEdit(own)}>{t('edit_answers')}</Button>}
                {own && <Button variant="outline" size="lg" className="w-full" disabled={!canWrite} onClick={() => setConfirmDelete(true)}>{t('delete')}</Button>}
              </div>
              {copyState !== 'idle' && <p role="status" className={styles.nightNote}>{copyState === 'copied' ? t(own ? 'copied_open' : 'prefilled_open', { client: clientName }) : t('copy_failed')}</p>}
              {copyState === 'failed' && <pre className={styles.fullText} data-ph-mask>{prompt}</pre>}
              {fullCopy === 'failed' && <p role="alert" className={styles.nightNote}>{t('body_failed')}</p>}
              {deleteFailed && <p role="alert" className={styles.nightNote}>{t('save_failed')}</p>}
            </div>
          )}
        </div>
      </div>
      {own && (
        <DestructiveConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t('delete')}
          description={t('delete_confirm')}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          onConfirm={async () => { setDeleteFailed(!(await onDelete(own))) }}
        />
      )}
    </div>
  )
}
