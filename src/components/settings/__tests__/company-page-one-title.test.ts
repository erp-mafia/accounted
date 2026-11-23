/**
 * The top bar names the settings page Företagsuppgifter. Its first group
 * carried the same word as a heading right under it, a second title. The
 * group that the page name is about has no label of its own; the groups after
 * it (Aktiekapital) keep theirs.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const form = fs.readFileSync(path.resolve(__dirname, '../CompanyInfoForm.tsx'), 'utf8')

describe('Företagsuppgifter has one title', () => {
  it('the first group has no label', () => {
    expect(form).toMatch(/return \(\s*<SettingsGroup>/)
    expect(form).not.toContain('company_info_heading')
  })

  it('the unused heading text is gone from both languages', () => {
    expect('company_info_heading' in sv.settings_company).toBe(false)
    expect('company_info_heading' in en.settings_company).toBe(false)
  })
})
