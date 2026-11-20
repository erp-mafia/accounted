import { describe, expect, it } from 'vitest'
import { CreateCompanySkillSchema, UpdateCompanySkillSchema, SkillBodySchema, isReservedHandle } from '../validation'

describe('shared private/community Markdown validator', () => {
  it.each(['<script>alert(1)</script>', '<div>hello</div>', '{fetch("secret")}', 'import x from "remote"', 'export const x = 1', '[click](javascript:alert(1))', '```\nnot closed'])('rejects executable or malformed Markdown: %s', (body) => {
    expect(SkillBodySchema.safeParse(body).success).toBe(false)
  })
  it('allows literal examples only inside code', () => {
    expect(SkillBodySchema.safeParse('Use `<tag>` literally.\n\n```json\n{"a": 1}\n```').success).toBe(true)
  })
  it('does not let a shorter or mismatched fence end a code block', () => {
    expect(SkillBodySchema.safeParse('````\n```\n<script>\n').success).toBe(false)
  })
  it('counts UTF-8 bytes, not JS characters', () => {
    expect(SkillBodySchema.safeParse('å'.repeat(16384)).success).toBe(true)
    expect(SkillBodySchema.safeParse('å'.repeat(16385)).success).toBe(false)
  })
  it('requires explicit sharing consent and a public handle', () => {
    expect(UpdateCompanySkillSchema.safeParse({ action: 'submit', author_handle: 'author' }).success).toBe(false)
    expect(UpdateCompanySkillSchema.safeParse({ action: 'submit', author_handle: 'author', confirmed_no_customer_data: true }).success).toBe(true)
  })
  it.each(['accounted', 'admin', 'support', 'gnubok', 'accounted-team', 'skatteverket'])('refuses the reserved handle %s', (handle) => {
    expect(isReservedHandle(handle)).toBe(true)
    expect(UpdateCompanySkillSchema.safeParse({ action: 'submit', author_handle: handle, confirmed_no_customer_data: true }).success).toBe(false)
  })
  it.each(['anna-bokforing', 'accountedfan', 'my-accounted', 'supporter'])('lets an ordinary handle through: %s', (handle) => {
    expect(isReservedHandle(handle)).toBe(false)
    expect(UpdateCompanySkillSchema.safeParse({ action: 'submit', author_handle: handle, confirmed_no_customer_data: true }).success).toBe(true)
  })
  it('rejects spoofed ownership and mixed catalog/private content', () => {
    expect(CreateCompanySkillSchema.safeParse({ kind: 'catalog', atom_id: 'vertical/x', body: 'X' }).success).toBe(false)
    expect(CreateCompanySkillSchema.safeParse({ kind: 'own', name: 'N', description: 'D', body: 'B', company_id: 'foreign' }).success).toBe(false)
  })
})
