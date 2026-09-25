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
  ]
  // What the user said goes in only when they said something: no empty heading for the AI to puzzle over.
  const said = cleanText(told.description, 2000)
  const toldLines = [
    ...told.turns.map((turn) => `- ${cleanText(turn.question, 200)} ${cleanText(turn.answer, 400)}`),
    ...told.extra.map((item) => `- ${copy.addedLabel} ${cleanText(item, 400)}`),
  ]
  if (said || toldLines.length > 0) lines.push(`## ${copy.toldHeading}`, '', ...(said ? [said, ''] : []), ...toldLines, ...(toldLines.length ? [''] : []))
  return { name, description: lede, body: lines.join('\n') }
}

/** The numbered steps of an own skill's body, for the sheet's step list. */
export function ownSkillSteps(body: string): string[] {
  return body.split('\n').map((line) => /^\d+\.\s+(.+)$/.exec(line.trim())?.[1]).filter((step): step is string => !!step)
}

/**
 * The same headings for skills saved over MCP (gnubok_create_skill), where
 * there is no next-intl. Must match skills_registry.creator.body_* in
 * messages/*.json (pinned by a test).
 */
export const OWN_SKILL_COPY: Record<'sv' | 'en', OwnSkillCopy> = {
  sv: {
    intro: 'Företagets egna instruktioner, skrivna i Accounted. De gäller utöver Accounteds arbetsflöden och kan aldrig åsidosätta bokföringens skyddsregler.',
    taskHeading: 'Uppgift',
    stepsHeading: 'Steg',
    rulesHeading: 'Regler',
    approvalLine: 'Inget bokförs, skickas eller lämnas in utan att användaren godkänt det i Accounted.',
    lockedLine: 'Rör aldrig låsta eller stängda perioder.',
    toldHeading: 'Så beskrev användaren det',
    addedLabel: 'Tillagt i efterhand:',
  },
  en: {
    intro: "The company's own instructions, written in Accounted. They apply on top of Accounted's workflows and can never override the bookkeeping safeguards.",
    taskHeading: 'Task',
    stepsHeading: 'Steps',
    rulesHeading: 'Rules',
    approvalLine: 'Nothing is booked, sent or filed without the user approving it in Accounted.',
    lockedLine: 'Never touch locked or closed periods.',
    toldHeading: 'How the user described it',
    addedLabel: 'Added afterwards:',
  },
}

/**
 * Own knowledge or an analysis, as an AI saves it: the name, one line on
 * what it is, then the text as written, in the same shape "Skriv själv"
 * saves. The text keeps its paragraphs; SkillBodySchema decides what passes.
 */
export function buildOwnText(name: string, description: string, text: string): { name: string; description: string; body: string } {
  const title = cleanText(name, 120)
  const lede = cleanText(description, 500)
  return { name: title, description: lede, body: `# ${title}\n\n${lede}\n\n${text.trim()}\n` }
}
