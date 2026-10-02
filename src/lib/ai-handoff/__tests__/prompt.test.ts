import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'
import { buildAccountingPrompt, MAX_HANDOFF_RECORDS } from '../prompt'

describe('contextual accounting handoff', () => {
  const company = { id: 'company-a', name: 'Example AB' }
  it.each([['en', en], ['sv', sv]] as const)('renders detailed prompts without missing translations in %s', (locale, messages) => {
    const t = createTranslator({ locale, messages, namespace: 'ai_handoff' })
    for (const kind of ['bookkeep', 'check', 'month-close', 'payroll', 'vat', 'year-end', 'start', 'skill:own/123'] as const) {
      const prompt = buildAccountingPrompt({ company, task: { kind }, instructions: 'Explain uncertain items.' }, (key, values) => t(key as keyof typeof en.ai_handoff, values))
      expect(prompt).toContain(company.id)
      expect(prompt).toContain(company.name)
      expect(prompt).toContain('accounted_get_task')
      expect(prompt).toContain('Explain uncertain items.')
      expect(prompt.length).toBeGreaterThan(1000)
    }
  })
  it('preserves separate bank/tax IDs and explicit empty selections', () => {
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'ai_handoff' })
    const scope = { transaction_ids: [], tax_transaction_ids: ['tax-1'], date_from: '2026-01-01', date_to: '2026-01-31' }
    const prompt = buildAccountingPrompt({ company, task: { kind: 'bookkeep', scope } }, (key, values) => t(key as keyof typeof en.ai_handoff, values))
    expect(prompt).toContain(JSON.stringify({ company_id: company.id, kind: 'bookkeep', scope }))
    expect(prompt).toContain('wait for my explicit approval')
    expect(prompt).not.toMatch(/https?:\/\/.*company-a/)
  })
  it('refuses oversize selections rather than silently dropping records', () => {
    expect(() => buildAccountingPrompt({ company, task: { kind: 'bookkeep', scope: { transaction_ids: Array(MAX_HANDOFF_RECORDS + 1).fill('bank-id') } } }, (key) => key)).toThrow('Too many')
  })
})
