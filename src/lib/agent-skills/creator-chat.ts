/**
 * The short fields an own flow is built from (buildOwnSkill in
 * own-skill-body.ts): a name, one line on what it does, steps and rules, and
 * what the user said about it. The AI that saves a flow over MCP
 * (gnubok_create_skill) writes these fields; the body is built from them, so
 * it always passes the Markdown validator.
 */
export interface CreatorTurn {
  question: string
  answer: string
}

export interface CreatorSummary {
  kind: 'summary'
  name: string
  /** One sentence: what the AI does and how often. */
  lede: string
  steps: string[]
  rules: string[]
  /** Two or three short chips: how often, what it covers, who approves. */
  facts: string[]
}

/** Strip what the Markdown validator rejects, and collapse whitespace. */
export function cleanText(text: string, max: number): string {
  return text.replace(/[{}<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}
