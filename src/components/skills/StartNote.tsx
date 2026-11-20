'use client'

import { useTranslations } from 'next-intl'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import { CLAUDE_DOWNLOAD, type ClaudeTarget, type HandoffRoute, type StartOutcome } from './run'
import { CopyIcon } from './CopyIcon'
import styles from './skills.module.css'

/**
 * The line under a start button. Before the click it says what will happen
 * only when that needs doing by hand: a copy-and-paste start, a Desktop link
 * or ChatGPT's app pick. A filled-in start needs no line. After the click it
 * says what did: filled in, copied, a copy that failed (with the prompt to
 * copy by hand) or a Desktop link that opened nothing (with the way out). The
 * banner's variant shows only the outcome.
 */
export function StartNote({ route, outcome, client, target, prompt, onWeb, banner = false }: {
  route: HandoffRoute
  outcome: StartOutcome | null
  client: AiClient
  target: ClaudeTarget
  /** The prompt as it was copied, shown when the copy failed. */
  prompt: string
  /** Start again on Claude on the web, after a Desktop link that opened nothing. */
  onWeb: () => void
  banner?: boolean
}) {
  const t = useTranslations('skills_registry')
  const { appName } = useBranding()
  const name = client === 'claude' && target !== 'web' ? t(`open_in_${target}`) : AI_CLIENTS.find((c) => c.id === client)!.name
  // A ChatGPT chat has no custom app until it is picked for that chat.
  const pickApp = client === 'chatgpt' ? t('chatgpt_pick_app', { appName }) : null

  let lines: (string | null)[]
  if (outcome === null) {
    if (banner) return null
    lines = route === 'desktop_link'
      ? [t('run_hint_desktop', { client: name })]
      : [route === 'copy' ? t('run_hint', { client: name }) : null, pickApp]
  } else if (outcome === 'prefilled' || outcome === 'prefilled_copied') {
    lines = [t('prefilled_open', { client: name }), outcome === 'prefilled_copied' ? t('prefilled_backup') : null, pickApp]
  } else if (outcome === 'copied') {
    lines = [t('copied_open', { client: name }), pickApp]
  } else if (outcome === 'copy_failed') {
    lines = [t('copy_failed')]
  } else {
    lines = [t('no_app')]
  }
  const text = lines.filter(Boolean).join(' ')
  if (!text) return null

  const extra = outcome === 'copy_failed' ? (
    <span className={styles.startPrompt}>
      <span data-ph-mask="">{prompt}</span>
      <CopyIcon text={prompt} label={t('copy')} />
    </span>
  ) : outcome === 'no_app' ? (
    <span className={styles.startNoteActions}>
      <a className="underline underline-offset-4" href={CLAUDE_DOWNLOAD} target="_blank" rel="noreferrer">{t('no_app_download')}</a>
      <button type="button" className="underline underline-offset-4" onClick={onWeb}>{t('no_app_web')}</button>
    </span>
  ) : null

  if (banner) return <span className={styles.featuredNote} role="status">{text}{extra && <> {extra}</>}</span>
  return (
    <div className={styles.startNote} role="status">
      <p>{text}</p>
      {extra}
    </div>
  )
}
