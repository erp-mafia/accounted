/**
 * The company's explicit rules on Bokföringsregler (HandWrittenRules): the
 * bookkeeping profile's heading, help and row, in both languages, and no
 * section for a company with none.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderInLocale } from '@/tests/i18n-render'
import { markupText } from '@/tests/markup-text'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { ExplicitRule } from '@/lib/agent-context/ledger-context'

// The account label reads the company's chart through the page's providers: here it says what it was asked to show.
vi.mock('@/components/ui/account-number', () => ({
  AccountNumber: ({ number, showName }: { number: string; showName?: boolean }) => createElement('span', { 'data-account': number, 'data-name': showName ? 'shown' : 'hidden' }, number),
}))
// The help opens on a click: here its text is in the page, so it can be read.
vi.mock('@/components/ui/help-popover', () => ({
  HelpPopover: ({ children }: { children: ReactNode }) => createElement('span', { 'data-help': '' }, children),
}))

const { default: HandWrittenRules } = await import('../HandWrittenRules')

const rule = (over: Partial<ExplicitRule> & Pick<ExplicitRule, 'rule_name' | 'match'>): ExplicitRule => ({ account_number: null, vat_treatment: null, source: 'mapping_rule', ...over })

const RULES = [
  rule({ rule_name: 'Hyra', match: 'FASTIGHETS AB', account_number: '5010', vat_treatment: 'exempt' }),
  rule({ rule_name: 'Bankavgift', match: 'MÅNADSAVGIFT', account_number: '6570' }),
  rule({ rule_name: 'Utan konto', match: 'OKÄND' }),
]

const render = (rules: ExplicitRule[], locale: 'sv' | 'en' = 'sv') => renderInLocale(createElement(HandWrittenRules, { rules }), locale)
/** The rows of the section: the text of each as one line. */
const ROW_START = '<div class="flex flex-wrap items-baseline'
const rows = (html: string) =>
  html
    .split(ROW_START)
    .slice(1)
    .map((row) => markupText(row.slice(row.indexOf('>') + 1)))

describe('the company\'s own rules on Bokföringsregler', () => {
  it('has no section for a company with none', () => {
    expect(render([])).toBe('')
  })

  it("is headed as the bookkeeping profile heads them, with the profile's help behind the heading", () => {
    const html = render(RULES)
    expect(html).toMatch(new RegExp(`<h2[^>]*>${sv.agentKnowledge.rules_title}</h2>`))
    expect(html).toMatch(new RegExp(`<span data-help="">${sv.agentKnowledge.rules_description}</span>`))
    expect(sv.agentKnowledge.rules_title).toBe('Dina regler')
    // One heading, named by the section itself.
    expect(html.match(/<h[1-6]/g)).toHaveLength(1)
    expect(html).toContain('aria-labelledby="hand-written-rules-title"')
  })

  it('shows each rule as the profile does: its name, what it matches, the account with its name, the VAT and that it is a rule', () => {
    const html = render(RULES)
    expect(rows(html)).toEqual(['Hyra FASTIGHETS AB 5010 · Momsfri · Regel', 'Bankavgift MÅNADSAVGIFT 6570 · Regel', 'Utan konto OKÄND - · Regel'])
    // The account is asked for with its name.
    expect([...html.matchAll(/data-account="(\d+)" data-name="(\w+)"/g)].map((m) => [m[1], m[2]])).toEqual([
      ['5010', 'shown'],
      ['6570', 'shown'],
    ])
  })

  it('reads in English for an English reader, the VAT treatment under its Swedish name', () => {
    const html = render(RULES, 'en')
    expect(html).toMatch(new RegExp(`<h2[^>]*>${en.agentKnowledge.rules_title}</h2>`))
    expect(html).toContain(en.agentKnowledge.rules_description)
    expect(rows(html)[0]).toBe('Hyra FASTIGHETS AB 5010 · Momsfri · Rule')
  })

  it('is the one row the bookkeeping profile lists its rules with, under the same heading', () => {
    const profile = fs.readFileSync(path.resolve(__dirname, '../../agent-knowledge/AgentKnowledgeView.tsx'), 'utf8')
    expect(profile).toContain("<SettingsGroup label={t('rules_title')} help={t('rules_description')}>")
    expect(profile).toContain('<ExplicitRuleRows rules={explicit_rules} />')
    const section = fs.readFileSync(path.resolve(__dirname, '../HandWrittenRules.tsx'), 'utf8')
    expect(section).toContain("useTranslations('agentKnowledge')")
    expect(section).toContain('<ExplicitRuleRows rules={rules} />')
  })
})
