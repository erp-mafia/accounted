/**
 * Whether Hem offers to build the built-in assistant (AgentPromo, the quiet
 * line that leads to /onboarding/agent).
 *
 * Offered only while there is a built-in assistant to build
 * (ASSISTANT_CHAT_ENABLED, lib/env/assistant-chat-switch.ts): switched off,
 * the build page itself leads to Koppla en agent, so a line offering the
 * build would be a door to nothing. Beyond that, as before: until the company
 * has a verified agent_profile, after the first-run checklist is dismissed or
 * completed (the checklist carries the assistant as its last step), and once
 * a connected agent has worked (until then the Kopplingar agent chip is the
 * page's agent prompt).
 *
 * Pure so the decision is testable: the page passes what it already read.
 */
export function agentPromoOffered(input: {
  /** The installation's switch, as assistantChatEnabled() reads it. */
  assistantChatEnabled: boolean
  /** agent_profiles.verified_at is set for the company. */
  agentBuilt: boolean
  /** An agent is connected and has done its first task. */
  agentConnected: boolean
  /** The first-run checklist is dismissed or completed. */
  setupClosed: boolean
}): boolean {
  if (!input.assistantChatEnabled) return false
  return !input.agentBuilt && input.agentConnected && input.setupClosed
}
