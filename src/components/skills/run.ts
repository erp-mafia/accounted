import { aiChatLink, aiPrefilledChatLink, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'

/**
 * Where a Claude start opens. The web is the default because it works for
 * everyone; Claude Desktop (chat) and Cowork (Desktop's agent mode, which can
 * also schedule) open through Desktop's documented claude:// links. A link can
 * choose the surface and fill in the text, never the model, approval mode or
 * connectors: those stay the user's settings in Claude. Without Desktop a
 * claude:// link is not harmless: Chrome does nothing, Firefox shows an error
 * page and Safari an alert. So Desktop is a choice, never the default, a phone
 * is not offered it, and a launch that took no focus from the page is
 * reported and forgotten (launchAppLink, ClaudeStart).
 */
export type ClaudeTarget = 'web' | 'desktop' | 'cowork'
export const CLAUDE_TARGETS: readonly ClaudeTarget[] = ['web', 'desktop', 'cowork']

/** Where Claude Desktop is downloaded, for a launch that opened nothing. */
export const CLAUDE_DOWNLOAD = 'https://claude.com/download'

/** The targets a device can open: a phone or tablet (coarse pointer) has no Claude Desktop. */
export function claudeTargetsFor(coarsePointer: boolean): readonly ClaudeTarget[] {
  return coarsePointer ? ['web'] : CLAUDE_TARGETS
}

/** The remembered target when this device can open it, else the web. */
export function usableClaudeTarget(target: ClaudeTarget, coarsePointer: boolean): ClaudeTarget {
  return claudeTargetsFor(coarsePointer).includes(target) ? target : 'web'
}

const DESKTOP_NEW: Record<Exclude<ClaudeTarget, 'web'>, string> = {
  desktop: 'claude://claude.ai/new',
  cowork: 'claude://cowork/new',
}

/** The desktop link for a target, with the prompt filled in when `prefill`. */
export function claudeDesktopLink(target: Exclude<ClaudeTarget, 'web'>, prompt: string, prefill: boolean): string {
  return prefill ? `${DESKTOP_NEW[target]}?q=${encodeURIComponent(prompt)}` : DESKTOP_NEW[target]
}

/**
 * A start's prompt in its two forms. `bare` is fixed text plus an id and may
 * travel in an https ?q= link. `pinned` also names the company (name and
 * company_id), so someone with several companies runs on the one they are
 * looking at; it goes only where no URL log sees it: the clipboard or a
 * claude:// link, which hands the text to the app on the same device.
 */
export interface StartPrompt {
  bare: string
  pinned: string
}

/** The prompt with the company pinned after it (see StartPrompt). */
export function pinCompany(prompt: string, pin: string): StartPrompt {
  return { bare: prompt, pinned: `${prompt} ${pin}` }
}

/**
 * How a start reaches the AI. Claude Desktop and Cowork always get the
 * prompt filled in: a claude:// link stays on the device, like a paste. On
 * the web only Accounted's own text (`fixedText`: its flows and analyses) is
 * filled in through ?q=; anything a user wrote is copied for them to paste
 * into an empty chat.
 */
export type HandoffRoute = 'desktop_link' | 'web_prefill' | 'copy'
export function handoffRoute(client: AiClient, target: ClaudeTarget, fixedText: boolean): HandoffRoute {
  if (client === 'claude' && target !== 'web') return 'desktop_link'
  return fixedText ? 'web_prefill' : 'copy'
}

/**
 * What a start did, for the line under its button. `prefilled`: the chat
 * opened with the prompt typed in. `prefilled_copied`: the same, and the
 * prompt is on the clipboard too, in case the chat dropped it. `copied`: an
 * empty chat opened and the prompt is on the clipboard. `copy_failed`: an
 * empty chat opened but the clipboard refused. `no_app`: a claude:// link
 * took no focus from the page, so Claude Desktop is most likely missing.
 */
export type StartOutcome = 'prefilled' | 'prefilled_copied' | 'copied' | 'copy_failed' | 'no_app'

function writeClipboard(text: string): Promise<boolean> {
  const copying = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('No clipboard'))
  return copying.then(() => true, () => false)
}

/**
 * Opens a chat for the prompt and puts `clipboardText` on the clipboard. The
 * clipboard is written first, while this page still has focus, and the chat
 * opens synchronously so the popup is not blocked. With `prefill` the prompt
 * is typed into the new chat through ?q= (see aiPrefilledChatLink), so only
 * pass fixed text then; the clipboard copy is the backup for a chat that
 * drops ?q=, which claude.ai does not document. Resolves whether the copy
 * worked.
 */
export function copyPromptAndOpen(prompt: string, client: AiClient, prefill = false, clipboardText = prompt): Promise<boolean> {
  const copying = writeClipboard(clipboardText)
  openAiConnector(prefill ? aiPrefilledChatLink(client, prompt) : aiChatLink(client))
  return copying
}

/**
 * Resolves true once the page loses focus or is hidden within `waitMs`, false
 * when it stays in front: an app that opens, or the browser's "Open Claude?"
 * prompt, takes the focus within moments; a scheme nothing handles does not.
 */
export function watchForLeave(win: EventTarget, doc: EventTarget & { visibilityState: DocumentVisibilityState }, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (left: boolean) => {
      clearTimeout(timer)
      win.removeEventListener('blur', onBlur)
      doc.removeEventListener('visibilitychange', onVisibility)
      resolve(left)
    }
    const onBlur = () => finish(true)
    const onVisibility = () => { if (doc.visibilityState === 'hidden') finish(true) }
    win.addEventListener('blur', onBlur)
    doc.addEventListener('visibilitychange', onVisibility)
    const timer = setTimeout(() => finish(false), waitMs)
  })
}

/** Opens a claude:// link in this tab and resolves whether anything took it (watchForLeave). */
export function launchAppLink(href: string, waitMs = 1500): Promise<boolean> {
  const left = watchForLeave(window, document, waitMs)
  window.location.href = href
  return left
}

/** Starts the prompt in the company's AI, by the route above. */
export async function startInAi(client: AiClient, target: ClaudeTarget, prompt: StartPrompt, fixedText: boolean): Promise<StartOutcome> {
  const route = handoffRoute(client, target, fixedText)
  if (route === 'desktop_link') {
    const opened = await launchAppLink(claudeDesktopLink(target === 'cowork' ? 'cowork' : 'desktop', prompt.pinned, true))
    return opened ? 'prefilled' : 'no_app'
  }
  if (route === 'web_prefill') {
    return (await copyPromptAndOpen(prompt.bare, client, true, prompt.pinned)) ? 'prefilled_copied' : 'prefilled'
  }
  return (await copyPromptAndOpen(prompt.pinned, client, false)) ? 'copied' : 'copy_failed'
}
