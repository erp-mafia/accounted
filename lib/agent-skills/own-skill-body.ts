/**
 * Turns the Skills creator's answers into a private company skill. The
 * creator asks three questions; the answers become plain Markdown the agent
 * follows. The labels arrive already translated, so the skill reads in the
 * language the user wrote it in. Output must pass SkillBodySchema: no tags,
 * no braces, plain text only.
 */
export interface OwnSkillAnswers {
  /** The area the skill is for, e.g. "Bokföra inköp". */
  area: string
  /** How the company works today. */
  context: string[]
  /** What the AI must never do without asking. */
  askFirst: string[]
}

export interface OwnSkillCopy {
  name: (area: string) => string
  intro: string
  scopeHeading: string
  scope: (area: string) => string
  contextHeading: string
  askHeading: string
  askLine: (item: string) => string
  lockedLine: string
  rulesHeading: string
  rules: string
  noContext: string
}

/** Strip anything the Markdown validator would reject from a user-visible label. */
function clean(text: string): string {
  return text.replace(/[{}<>`]/g, '').replace(/\s+/g, ' ').trim()
}

export function buildOwnSkill(answers: OwnSkillAnswers, copy: OwnSkillCopy): { name: string; description: string; body: string } {
  const area = clean(answers.area)
  const context = answers.context.map(clean).filter(Boolean)
  const askFirst = answers.askFirst.map(clean).filter(Boolean)
  const name = clean(copy.name(area)).slice(0, 120)
  const lines = [
    `# ${name}`,
    '',
    copy.intro,
    '',
    `## ${copy.scopeHeading}`,
    '',
    copy.scope(area.toLowerCase()),
    '',
    `## ${copy.contextHeading}`,
    '',
    ...(context.length ? context.map((item) => `- ${item}`) : [`- ${copy.noContext}`]),
    '',
    `## ${copy.askHeading}`,
    '',
    ...askFirst.map((item) => `- ${copy.askLine(item.toLowerCase())}`),
    `- ${copy.lockedLine}`,
    '',
    `## ${copy.rulesHeading}`,
    '',
    copy.rules,
    '',
  ]
  const description = (context.length ? context.join(', ') : copy.scope(area.toLowerCase())).slice(0, 500)
  return { name, description, body: lines.join('\n') }
}
