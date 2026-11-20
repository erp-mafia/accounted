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

// crm#1799: a supplier invoice whose proposed account was wrong (and that belonged on two) had one visible way to
// "change" it, "Öppna i verifikatredigeraren", which books a verifikat and never a supplier invoice. One click
// skips the invoice form, where every row has its own account, so nothing led there.
describe('Inkorg supplier invoice: where the accounts are changed', () => {
  it('names the roads in both languages', () => {
    for (const messages of [sv, en]) {
      for (const key of ['action_change_accounts', 'action_book_without_invoice', 'action_register_as_invoice', 'action_nobody_paid_yet'] as const) {
        expect(messages.inkorg[key]).toBeTruthy()
      }
    }
    expect(sv.inkorg.action_change_accounts).toBe('Ändra kontering')
    expect(sv.inkorg.action_book_without_invoice).toBe('Bokför direkt, utan leverantörsfaktura')
    expect(sv.inkorg.action_nobody_paid_yet).toBe('Ingen, fakturan är obetald')
  })

  it('Ändra kontering opens the form one click would have spared, before the verifikat editor link', () => {
    const change = source.indexOf("{t('action_change_accounts')}")
    const escape = source.indexOf("t('action_book_without_invoice')")
    expect(change).toBeGreaterThan(-1)
    expect(escape).toBeGreaterThan(change)
    expect(source).toMatch(/\{changesAccounts && \(\s*<button type="button" onClick=\{openPlanEditor\}/)
  })

  it('the verifikat editor link says it makes no supplier invoice whenever the item is on its way to one', () => {
    expect(source).toMatch(/registersInvoice \? t\('action_book_without_invoice'\) : tWork\('payer_open_editor'\)/)
    expect(source).toMatch(/const registersInvoice = decision\.actions\.includes\('register_invoice'\) \|\| decision\.actions\.includes\('register_and_settle'\)/)
  })

  it('"Vem betalade?" answers nobody yet with the invoice form', () => {
    expect(source).toMatch(/decision\.question === 'who_paid'\s*\? t\('action_nobody_paid_yet'\)/)
    expect(source).toMatch(/decision\.quietActions\.includes\('register_invoice'\) && \(\s*<button type="button" onClick=\{\(\) => setOpen\('invoice'\)\}/)
  })
})
