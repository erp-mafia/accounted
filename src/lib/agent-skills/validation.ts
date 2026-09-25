import { z } from 'zod'

/** Shared by private skill saves and community validation. Not a trust check. */
export function markdownProblems(body: string): string[] {
  const problems: string[] = []
  let fence: { character: string; length: number } | null = null
  for (const [index, line] of body.split('\n').entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      continue
    }
    if (fence) continue
    const text = line.replace(/(`+)(.*?)\1/g, '')
    if (/^\s*(import|export)\s/.test(text) || /<\/?[A-Za-z]|[{}]|javascript\s*:/i.test(text)) {
      problems.push(`Line ${index + 1}: use plain Markdown; tags, expressions, imports and executable URLs are not allowed.`)
    }
  }
  if (fence) problems.push('Unclosed fenced code block.')
  return problems
}

export const SkillBodySchema = z.string().trim().min(1).superRefine((body, ctx) => {
  if (new TextEncoder().encode(body).length > 32768) ctx.addIssue({ code: 'custom', message: 'Skill bodies may not exceed 32 KB.' })
  for (const message of markdownProblems(body)) ctx.addIssue({ code: 'custom', message })
})

/** What a shared item is, chosen by its author at submission: a flow, knowledge or an analysis. */
export const COMMUNITY_KINDS = ['workflow', 'rules', 'analysis'] as const

export const CreateCompanySkillSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), atom_id: z.string().min(1).max(200), scope: z.enum(['company', 'team']).default('company') }).strict(),
  z.object({ kind: z.literal('own'), name: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(500), body: SkillBodySchema, scope: z.enum(['company', 'team']).default('company'), item_kind: z.enum(['workflow', 'rules', 'analysis']).default('workflow') }).strict(),
])

export const UpdateCompanySkillSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), name: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(500), body: SkillBodySchema }).strict(),
  z.object({ action: z.literal('submit'), confirmed_no_customer_data: z.literal(true), author_handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/), kind: z.enum(COMMUNITY_KINDS).optional() }).strict(),
  z.object({ action: z.literal('withdraw') }).strict(),
  z.object({ action: z.literal('add') }).strict(),
])
