import { cleanText, type CreatorSummary, type CreatorTurn } from './creator-chat'

/**
 * Turns the creator conversation into a private company skill: plain
 * Markdown the AI follows. The headings arrive already translated, so the
 * skill reads in the language the user wrote it in. Every field is cleaned
 * again here, so the output always passes SkillBodySchema.
 */
export interface OwnSkillCopy {
  intro: string
  taskHeading: string
  stepsHeading: string
  rulesHeading: string
  approvalLine: string
  lockedLine: string
  toldHeading: string
  addedLabel: string
}

export function buildOwnSkill(
  summary: CreatorSummary,
  told: { description: string; turns: CreatorTurn[]; extra: string[] },
  copy: OwnSkillCopy,
): { name: string; description: string; body: string } {
  const name = cleanText(summary.name, 120)
  const lede = cleanText(summary.lede, 500)
  const steps = summary.steps.map((step) => cleanText(step, 200)).filter(Boolean)
  const rules = summary.rules.map((rule) => cleanText(rule, 200)).filter(Boolean)
  const lines = [
    `# ${name}`,
    '',
    copy.intro,
    '',
    `## ${copy.taskHeading}`,
    '',
    lede,
    '',
    `## ${copy.stepsHeading}`,
    '',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    `## ${copy.rulesHeading}`,
    '',
    ...rules.map((rule) => `- ${rule}`),
    `- ${copy.approvalLine}`,
    `- ${copy.lockedLine}`,
    '',
    `## ${copy.toldHeading}`,
    '',
    cleanText(told.description, 2000),
    '',
    ...told.turns.map((turn) => `- ${cleanText(turn.question, 200)} ${cleanText(turn.answer, 400)}`),
    ...told.extra.map((item) => `- ${copy.addedLabel} ${cleanText(item, 400)}`),
    '',
  ]
  return { name, description: lede, body: lines.join('\n') }
}
