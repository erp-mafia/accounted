/**
 * Texts that send people to a settings page name the page as the settings
 * menu shows it. The menu was relabelled on 2026-11-16 (Företag became
 * Företaget → Företagsuppgifter, Allmänt under Bokföring became Bokföring),
 * the Skatteverket connection is a row under Kopplingar, and no section is
 * called Skatt, Fakturering or Konto; these texts still used those names.
 *
 * Each path is checked against the real menu: the assistant's menu trail for
 * the page (ui-map.ts, built from settings-sections.ts and the rail's
 * labels), in sv and en. A group and its row with the same name (Kopplingar,
 * Bokföring) are named once, as the other texts that send people there do.
 * A renamed or moved page fails here instead of reaching a user as a dead
 * direction.
 */
import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { loadUiLabels, menuTrail } from '@/lib/agent/ask/ui-map'
import { gateContext } from '@/lib/agent/ask/__tests__/ui-fixture'

/** Message key, and the settings page that holds what the text sends people to change. */
const TEXTS: ReadonlyArray<readonly [string, string]> = [
  // The company's organisation number and säte: Företagsuppgifter.
  ['supplier_payment_files.debtor_missing_org_link', '/settings/company'],
  ['annualReportStudio.registered_office_fetched_description', '/settings/company'],
  // Disconnecting and reconnecting Skatteverket: Kopplingar → Skatteverket.
  ['salary_agi.missing_scope_description', '/settings/skatteverket'],
  ['salary_agi.kvittens_scope_description', '/settings/skatteverket'],
  ['reconciliation.v2_verdict_no_skv_saldo', '/settings/skatteverket'],
  ['reconciliation.v2_verdict_skv_not_connected', '/settings/skatteverket'],
  // Removing or turning a bank account back on: the bank account lists on Bokföring.
  ['accounts_v2.help', '/settings/bookkeeping'],
  ['settings_voucher_series.archive_offer_body', '/settings/bookkeeping'],
  // A bank account's IBAN and its currency default: Bankkonton för kundfakturor on Fakturor.
  ['invoice_editor_pay.foreign_missing_no_iban', '/settings/invoicing'],
  ['invoice_editor_pay.foreign_open_settings', '/settings/invoicing'],
  // The person's own analytics choice: Ditt konto.
  ['legal_acceptance.analytics_help', '/settings/account'],
]

function text(messages: unknown, key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
  if (typeof value !== 'string') throw new Error(`no message ${key}`)
  return value
}

describe.each([
  ['sv', sv],
  ['en', en],
] as const)('texts name the settings page as the menu shows it (%s)', (locale, messages) => {
  it.each(TEXTS)('%s', async (key, route) => {
    const trail = menuTrail(route, { ctx: gateContext(), labels: await loadUiLabels(locale) })
    expect(trail, route).not.toBeNull()
    const path = trail!.filter((label, i) => label !== trail![i - 1]).join(' → ')

    expect(text(messages, key)).toContain(path)
  })
})
