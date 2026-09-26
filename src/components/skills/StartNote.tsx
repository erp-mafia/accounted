'use client'

import { useTranslations } from 'next-intl'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import { CLAUDE_DOWNLOAD, type ClaudeTarget, type HandoffRoute, type StartOutcome } from './run'
import { CopyIcon } from './CopyIcon'
import styles from './skills.module.css'

/**
 * The line under a start button. Before the click it says what will happen,
 * so a copy-and-paste start is known before the new tab takes over (and
 * Claude's warning for filled-in links is expected). After the click it says
 * what did: filled in, copied, a copy that failed (with the prompt to copy by
 * hand) or a Desktop link that opened nothing (with the way out). The
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
  // Claude on the web warns about every prompt that arrives through a link.
  const caution = client === 'claude' && route === 'web_prefill' ? t('prefill_caution', { appName }) : null
  // A ChatGPT chat has no custom app until it is picked for that chat.
  const pickApp = client === 'chatgpt' ? t('chatgpt_pick_app', { appName }) : null

  let lines: (string | null)[]
  if (outcome === null) {
    if (banner) return null
    lines = route === 'desktop_link'
      ? [t('run_hint_desktop', { client: name })]
      : [t(route === 'copy' ? 'run_hint' : 'run_hint_prefilled', { client: name }), caution, pickApp]
  } else if (outcome === 'prefilled' || outcome === 'prefilled_copied') {
    lines = [t('prefilled_open', { client: name }), caution, outcome === 'prefilled_copied' ? t('prefilled_backup') : null, pickApp]
  } else if (outcome === 'copied') {
    lines = [t('copied_open', { client: name }), pickApp]
  } else if (outcome === 'copy_failed') {
    lines = [t('copy_failed')]
  } else {
    lines = [t('no_app')]
  }
  const text = lines.filter(Boolean).join(' ')

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
