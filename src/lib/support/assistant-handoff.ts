/**
 * The message a conversation with the AI assistant becomes when the user
 * sends it on to a person.
 *
 * The support staff should not have to ask again what the user already
 * wrote: the ticket opens with the user's last question (the desk's list
 * shows a ticket by its first line), then names the page, the assistant's own
 * summary when it gave one, and the turns of the conversation. The user sees
 * and can edit all of it in the form before anything is sent.
 *
 * Pure text in, text out: it runs in the browser and is covered by tests.
 */

export interface SupportTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface HandoffLabels {
  /** The line above the turns, e.g. "Från samtalet med AI-assistenten". */
  heading: string
  page: string
  summary: string
  you: string
  assistant: string
}

export interface HandoffInput {
  turns: SupportTurn[]
  labels: HandoffLabels
  /** The page the user asked from. */
  route?: string | null
  /** The assistant's sentences for the support staff, when it offered a person itself. */
  summary?: string | null
  /** The form takes 5000 characters; the default leaves room to add to the message. */
  maxChars?: number
}

export const HANDOFF_MAX_CHARS = 4400
const USER_TURN_MAX = 600
const ASSISTANT_TURN_MAX = 900

function oneBlock(text: string, max: number): string {
  const clean = text.trim().replace(/\n{3,}/g, '\n\n')
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

export function composeHandoffMessage(input: HandoffInput): string {
  const { labels } = input
  const max = input.maxChars ?? HANDOFF_MAX_CHARS
  const turns = input.turns.filter((turn) => turn.text.trim().length > 0)
  const lastQuestion = [...turns].reverse().find((turn) => turn.role === 'user')

  const head: string[] = []
  if (lastQuestion) head.push(oneBlock(lastQuestion.text, USER_TURN_MAX), '')
  head.push(labels.heading)
  if (input.route) head.push(`${labels.page}: ${input.route}`)
  if (input.summary?.trim()) head.push(`${labels.summary}: ${oneBlock(input.summary, USER_TURN_MAX)}`)

  // The newest turns that fit, in the order they were said.
  const lines = turns.map((turn) =>
    turn.role === 'user'
      ? `${labels.you}: ${oneBlock(turn.text, USER_TURN_MAX)}`
      : `${labels.assistant}: ${oneBlock(turn.text, ASSISTANT_TURN_MAX)}`,
  )
  let used = head.join('\n').length + 1
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 2
    if (used + cost > max) break
    kept.unshift(lines[i])
    used += cost
  }
  return [...head, '', kept.join('\n\n')].join('\n').trim()
}

/**
 * The form's text after a hand-off: what the user had already typed there
 * stays first, the conversation follows, and the whole fits the form.
 */
export function mergeIntoDraft(existing: string, handoff: string, formMax = 5000): string {
  const typed = existing.trim()
  if (!typed || handoff.includes(typed)) return handoff.slice(0, formMax)
  return `${typed}\n\n${handoff}`.slice(0, formMax)
}
