/**
 * PH 203 / crm#1446: a customer could not find how to remove an underlag
 * from the Inkorg ("Hittar ingen ta bort knapp"). The removal was there, in
 * every first decision (lib/inkorg/decision.ts not_underlag), but it read
 * "Inte ett underlag": nothing said Ta bort until the confirm dialog. The
 * answer now says what it does, in the words of that dialog. Components are
 * not rendered in this suite (vitest runs in `node`), so the copy is pinned
 * on the message files and the wiring on the component source.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const source = fs.readFileSync(path.resolve(__dirname, '../FocusDecision.tsx'), 'utf8')

describe('Inkorg removal answer', () => {
  it('says Ta bort, the words of its own confirm dialog', () => {
    expect(sv.inkorg.action_not_underlag).toBe('Ta bort ur Inkorgen')
    expect(sv.inkorg.drop_confirm_title).toBe(`${sv.inkorg.action_not_underlag}?`)
    expect(en.inkorg.action_not_underlag).toBe('Remove from the Inbox')
    expect(en.inkorg.drop_confirm_title).toBe(`${en.inkorg.action_not_underlag}?`)
  })

  it('the answer button and the quiet link both open the confirm, never the delete itself', () => {
    expect(source).toMatch(/onClick=\{\(\) => void dropItem\(\)\}>\s*\{t\('action_not_underlag'\)\}/)
    expect(source).toMatch(/onClick=\{\(\) => void dropItem\(\)\} className=\{cn\(QUIET_LINK_CLASS[^}]*\}\s*>\s*\{t\('action_not_underlag'\)\}/)
    const body = source.slice(source.indexOf('async function dropItem()'))
    const confirmAt = body.indexOf('await confirm(')
    const deleteAt = body.indexOf("{ method: 'DELETE' }")
    expect(confirmAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(confirmAt)
  })
})
