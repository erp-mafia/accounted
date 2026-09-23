'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { SlideOver, SlideOverContent } from '@/components/ui/slide-over'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { AI_CLIENTS, aiChatLink, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'
import { registrySkillSlug, type RegistrySkillId } from '@/lib/agent-skills/registry'
import { SkillMarks } from './SkillMarks'
import styles from './skills.module.css'

export type SheetTarget =
  | { kind: 'registry'; id: RegistrySkillId; locked: boolean }
  | { kind: 'own'; slug: string; name: string; installationId: string }

/**
 * Copies the prompt and opens an empty chat. The chat opens synchronously so
 * the popup is not blocked; the prompt travels by clipboard, never in the URL.
 */
export function copyPromptAndOpen(prompt: string, client: AiClient): Promise<boolean> {
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
 * what the skill does and the sentence to say to the AI. "Kopiera och öppna"
 * copies the prompt and opens an empty chat: the prompt names a skill and
 * nothing else, but it still travels by clipboard, never in the chat URL.
 */
export function SkillSheet({ target, companyId, client, canWrite, onClose, onConnect, onEdit, onDelete }: {
  target: SheetTarget | null
  companyId: string
  client: AiClient
  canWrite: boolean
  onClose: () => void
  onConnect: (client: AiClient) => void
  onEdit: (target: Extract<SheetTarget, { kind: 'own' }>) => void
  onDelete: (target: Extract<SheetTarget, { kind: 'own' }>) => Promise<boolean>
}) {
  return (
    <SlideOver open={target !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SlideOverContent aria-describedby={undefined} className={styles.sheet}>
        {target && <SheetBody key={target.kind === 'own' ? target.slug : target.id} target={target} companyId={companyId} client={client} canWrite={canWrite} onConnect={onConnect} onEdit={onEdit} onDelete={onDelete} />}
      </SlideOverContent>
    </SlideOver>
  )
}

function SheetBody({ target, companyId, client, canWrite, onConnect, onEdit, onDelete }: {
  target: SheetTarget
  companyId: string
  client: AiClient
  canWrite: boolean
  onConnect: (client: AiClient) => void
  onEdit: (target: Extract<SheetTarget, { kind: 'own' }>) => void
  onDelete: (target: Extract<SheetTarget, { kind: 'own' }>) => Promise<boolean>
}) {
  const t = useTranslations('skills_registry')
  const clientName = AI_CLIENTS.find((c) => c.id === client)!.name
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [fullCopy, setFullCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)

  const own = target.kind === 'own' ? target : null
  const id = target.kind === 'registry' ? target.id : null
  const slug = own ? own.slug : registrySkillSlug(id!, client)
  const title = own ? own.name : t(`skills.${id}.name`)
  const say = own ? t('own_say', { name: own.name }) : t(`skills.${id}.say`)
  const prompt = t('prompt', { say, skill: slug })
  const steps = id ? (t.raw(`skills.${id}.steps`) as string[]) : []
  const locked = target.kind === 'registry' && target.locked
  // Fetched as the sheet opens, so the copy runs inside the click and the browser allows it.
  const body = useSWR(!locked ? ['/api/skills', companyId, slug] : null, ([url, , s]) => readBody(`${url}?slug=${encodeURIComponent(s)}`))

  function copyFull() {
    const text = body.data
    const copying = text && navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Nothing to copy'))
    void copying.then(() => setFullCopy('copied'), () => setFullCopy('failed'))
  }

  function copyAndOpen() {
    void copyPromptAndOpen(prompt, client).then((ok) => setCopyState(ok ? 'copied' : 'failed'))
  }

  return (
    <div className={styles.sheetBody}>
      <div className={styles.sheetHead}>
        <div className={styles.dtTop}>
          {id && <SkillMarks id={id} />}
          <DialogPrimitive.Title asChild><h2 data-ph-mask={own ? '' : undefined}>{title}</h2></DialogPrimitive.Title>
          <DialogPrimitive.Close className={styles.x} aria-label={t('close')}><X className="h-4 w-4" aria-hidden /></DialogPrimitive.Close>
        </div>
        <p className={styles.dtD}>{own ? t('own_desc') : t(`skills.${id}.desc`)}</p>
      </div>
      <div className={styles.sheetMain}>
        {steps.length > 0 && <ol className={styles.steps}>{steps.map((step) => <li key={step}>{step}</li>)}</ol>}
        <div className={styles.sheetFoot}>
          <div className={styles.promptbox}>
            <span>{t('say_label')}</span>
            <p data-ph-mask={own ? '' : undefined}>{`”${say}”`}</p>
          </div>
          {locked ? (
            <div className="flex flex-col gap-3">
              <p className={styles.lockedline}>{t('locked_line')}</p>
              <div className={styles.nightBtns}>
                {AI_CLIENTS.map((c, i) => (
                  <button key={c.id} type="button" className={i === 0 ? styles.pill : `${styles.pill} ${styles.pillGhost}`} onClick={() => onConnect(c.id)}>
                    {i === 0 ? t('connect_client', { client: c.name }) : c.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className={styles.nightBtns}>
                <button type="button" className={styles.run} onClick={copyAndOpen}>{t('run_client', { client: clientName })}</button>
                <button type="button" className={`${styles.pill} ${styles.pillGhost}`} onClick={copyFull}>{t(fullCopy === 'copied' ? 'copied_full' : 'copy_full')}</button>
                {own && <button type="button" className={`${styles.pill} ${styles.pillGhost}`} disabled={!canWrite} onClick={() => onEdit(own)}>{t('edit_answers')}</button>}
                {own && <button type="button" className={`${styles.pill} ${styles.pillGhost}`} disabled={!canWrite} onClick={() => setConfirmDelete(true)}>{t('delete')}</button>}
              </div>
              {copyState !== 'idle' && <p role="status" className={styles.nightNote}>{copyState === 'copied' ? t('copied_open', { client: clientName }) : t('copy_failed')}</p>}
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
