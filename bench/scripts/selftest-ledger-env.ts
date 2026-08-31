// Self-test for the ledger-agent environment. Run BEFORE benchmarking:
//
//   npx tsx bench/scripts/selftest-ledger-env.ts
//
// Proves the oracle can actually detect failure (a harness whose invariants
// never fire will happily report every model as compliant):
//  1. seeding + commit through the RPC works and assigns voucher numbers,
//  2. an UNBALANCED entry is refused at commit,
//  3. a direct UPDATE of a posted entry's lines is refused by the triggers,
//  4. each assertion program FAILS on the untouched seed (except invariants
//     that hold trivially) and PASSES after the correct actions are simulated.

import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.local'),
  quiet: true,
})

import { closePool, executeTool, seedPostedEntry } from '../src/ledger-env'
import { ASSERTIONS, SEEDS } from '../src/ledger-tasks'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

async function main() {
  // 1. Seed and commit.
  const env = await SEEDS.q2_vat_activity()
  const listed = await executeTool(env, 'list_journal_entries', {})
  const entries = JSON.parse(listed.content).entries as { voucher_number: number }[]
  check('seed produced 2 posted vouchers', entries.length === 2)
  check(
    'voucher numbers are sequential',
    JSON.stringify(entries.map((e) => e.voucher_number).sort()) === '[1,2]',
  )

  // 2. Unbalanced entry refused.
  const unbalanced = await executeTool(env, 'create_journal_entry', {
    entry_date: '2026-06-30',
    description: 'obalanserad',
    lines: [
      { account: '6110', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 90 },
    ],
  })
  check('unbalanced entry is refused', unbalanced.isError, unbalanced.content.slice(0, 120))

  // 3. Direct update of a posted entry refused by triggers.
  const upd = await executeTool(env, 'update_journal_entry', {
    entry_id: env.seededEntries.sale,
    line_account: '3001',
    new_account: '3041',
  })
  check('posted-line update is refused', upd.isError, upd.content.slice(0, 160))

  // 4a. vat_settled assertions fail on the untouched seed.
  const before = await ASSERTIONS.vat_settled(env)
  check(
    'vat_settled discriminates (fails before settlement)',
    before.some((a) => !a.pass),
    before.map((a) => `${a.name}=${a.pass}`).join(', '),
  )

  // 4b. ...and pass after the correct settlement entry.
  const settle = await executeTool(env, 'create_journal_entry', {
    entry_date: '2026-06-30',
    description: 'Momsredovisning Q2',
    lines: [
      { account: '2611', debit: 2500, credit: 0 },
      { account: '2641', debit: 0, credit: 200 },
      { account: '2650', debit: 0, credit: 2300 },
    ],
  })
  check('settlement entry commits', !settle.isError, settle.content.slice(0, 120))
  const after = await ASSERTIONS.vat_settled(env)
  check('vat_settled passes after settlement', after.every((a) => a.pass))

  // 4c. storno_correction: fails before, passes after storno + rebook.
  const env2 = await SEEDS.wrong_account_posted()
  const before2 = await ASSERTIONS.storno_correction(env2)
  check('storno_correction discriminates (fails before)', before2.some((a) => !a.pass))
  await seedPostedEntry(env2, '2026-06-30', 'Rättelse: storno av A1', [
    { account: '6071', debit: 0, credit: 5625 },
    { account: '1930', debit: 5625, credit: 0 },
  ])
  await seedPostedEntry(env2, '2026-06-30', 'Rättelse: ombokning programvara', [
    { account: '5420', debit: 5625, credit: 0 },
    { account: '1930', debit: 0, credit: 5625 },
  ])
  const after2 = await ASSERTIONS.storno_correction(env2)
  check(
    'storno_correction passes after correct storno',
    after2.every((a) => a.pass),
    after2.filter((a) => !a.pass).map((a) => `${a.name}: ${a.detail}`).join(' | '),
  )

  // 4d. reverse_charge_booked: fails on empty company, passes after booking.
  const env3 = await SEEDS.base_company()
  const before3 = await ASSERTIONS.reverse_charge_booked(env3)
  check('reverse_charge_booked discriminates (fails before)', before3.some((a) => !a.pass))
  await seedPostedEntry(env3, '2026-06-10', 'Google Workspace juni', [
    { account: '5420', debit: 11250, credit: 0 },
    { account: '2645', debit: 2812.5, credit: 0 },
    { account: '2614', debit: 0, credit: 2812.5 },
    { account: '1930', debit: 0, credit: 11250 },
  ])
  const after3 = await ASSERTIONS.reverse_charge_booked(env3)
  check(
    'reverse_charge_booked passes after correct booking',
    after3.every((a) => a.pass),
    after3.filter((a) => !a.pass).map((a) => `${a.name}: ${a.detail}`).join(' | '),
  )

  await closePool()
  if (failures > 0) {
    console.error(`\n${failures} self-test failure(s): DO NOT run the suite`)
    process.exit(1)
  }
  console.log('\nLedger environment self-test passed.')
}

main().catch(async (e) => {
  console.error(e)
  await closePool()
  process.exit(1)
})
