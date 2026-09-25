import { aiChatLink, aiPrefilledChatLink, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'

/**
 * Opens a chat for the prompt. The chat opens synchronously so the popup is
 * not blocked. With `prefill` the prompt is typed into the new chat through
 * ?q= (see aiPrefilledChatLink): only for curated agents, whose prompt is
 * fixed text plus an agent id. An own agent's prompt carries the name the
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

/**
 * Where a Claude start opens. The web is the default because it works for
 * everyone; Claude Desktop (chat) and Cowork (Desktop's agent mode, which can
 * also schedule) open through Desktop's documented links. A link can choose
 * the surface and fill in the text, never the model, approval mode or
 * connectors: those stay the user's settings in Claude. If Desktop is not
 * installed the link does nothing, which is why it is a choice, not the default.
 */
export type ClaudeTarget = 'web' | 'desktop' | 'cowork'
export const CLAUDE_TARGETS: readonly ClaudeTarget[] = ['web', 'desktop', 'cowork']

const DESKTOP_NEW: Record<Exclude<ClaudeTarget, 'web'>, string> = {
  desktop: 'claude://claude.ai/new',
  cowork: 'claude://cowork/new',
}

/** The desktop link for a target, with the prompt filled in when `prefill`. */
export function claudeDesktopLink(target: Exclude<ClaudeTarget, 'web'>, prompt: string, prefill: boolean): string {
  return prefill ? `${DESKTOP_NEW[target]}?q=${encodeURIComponent(prompt)}` : DESKTOP_NEW[target]
}

/** Opens the prompt in Claude where the user chose; same prefill rule as copyPromptAndOpen. */
export function openInClaude(target: ClaudeTarget, prompt: string, prefill: boolean): Promise<boolean> {
  if (target === 'web') return copyPromptAndOpen(prompt, 'claude', prefill)
  const copying = prefill ? Promise.resolve() : navigator.clipboard?.writeText(prompt) ?? Promise.reject(new Error('No clipboard'))
  window.location.href = claudeDesktopLink(target, prompt, prefill)
  return copying.then(() => true, () => false)
}
