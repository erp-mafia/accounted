// Independent audit of the booking gold labels.
//
//   npx tsx bench/scripts/audit-gold.ts --model gpt-5-6-terra-pro,gemini-3-1-pro
//
// The tasks and their answers were authored with Claude, and Claude models are
// then ranked on them. That circularity cannot be argued away, only tested:
// this asks models from OTHER vendors to check each gold answer against
// Swedish rules, seeing the task, our answer and our stated reason, and to say
// whether it is right. Following BenchGuard's rule that judges should not
// share a provider with the thing being judged.
//
// Output: bench/results/gold-audit.json, plus a console list of every
// disagreement for human review. Nothing is changed automatically: a
// disagreement is a prompt to go read the law, not a verdict.

import fs from 'node:fs'
import path from 'node:path'
import { config as loadEnv } from 'dotenv'
import { BENCH_ROOT, loadTasks, extractJsonObject } from '../src/util'
loadEnv({ path: path.join(BENCH_ROOT, '..', '.env.local'), quiet: true })
import { getModel } from '../src/models'
import { chat } from '../src/providers/index'
import type { BookingTask } from '../src/types'

const SYSTEM = `Du är en erfaren svensk redovisningskonsult som granskar en annan konsults kontering. Du får en banktransaktion, företagets uppgifter, och det svar som föreslagits som facit i ett testmaterial, med motivering.

Din uppgift är att avgöra om facit är korrekt enligt svenska regler (BAS-kontoplanen, ML 2023:200, BFL, IL). Var kritisk men rättvis: ett konto kan vara korrekt även om du själv hade valt ett annat, så länge det är försvarbart enligt kontoplanen.

Viktigt om frågans avgränsning, så att du bedömer rätt sak:
- Frågan gäller ENBART vilket kostnads- eller tillgångskonto affärshändelsen ska klassificeras på, samt vilken momsbehandling som gäller. Motkontot (1930, 2440) ingår inte i bedömningen.
- Underlag (kvitto/faktura) förutsätts finnas och vara arkiverat enligt BFL. Att underlagets text inte återges här betyder inte att verifikation saknas; i vissa uppgifter är texten medvetet utelämnad för att pröva om motparten känns igen. Utgå alltså aldrig från att momsavdrag ska nekas på grund av saknat underlag, och föreslå inte observationskonton.
- Vid faktureringsmetoden avses klassificeringen av kostnaden när fakturan bokförs, inte betalningsraden mot leverantörsskulden.

Svara med ENBART ett JSON-objekt:
{"verdict": "correct" | "defensible" | "incorrect", "better_account": "<konto eller null>", "better_vat": "<momsbehandling eller null>", "reason": "<en mening>"}

- "correct": facit är det uppenbart riktiga svaret.
- "defensible": facit går att försvara, men ett annat konto vore minst lika riktigt (ange vilket).
- "incorrect": facit strider mot reglerna (ange vad som är rätt och varför).`

function prompt(t: BookingTask): string {
  const { company, transaction } = t.input
  const { gold } = t
  return [
    `Företag: ${company.business}, ${company.entity_type === 'aktiebolag' ? 'aktiebolag' : 'enskild firma'}, ${company.vat_registered ? 'momsregistrerat' : 'ej momsregistrerat'}, ${company.accounting_method === 'invoice' ? 'faktureringsmetoden' : 'kontantmetoden'}.`,
    `Transaktion ${transaction.date}: ${transaction.amount.toFixed(2)} ${transaction.currency}, motpart ${transaction.counterpart}, "${transaction.description}".`,
    transaction.underlag ? `Underlag: ${transaction.underlag}` : 'Inget underlag bifogat (endast bankraden).',
    '',
    `FÖRESLAGET FACIT: konto ${gold.account}${gold.acceptable_accounts?.length ? ` (även godtagbara: ${gold.acceptable_accounts.join(', ')})` : ''}, momsbehandling ${gold.vat_treatment}.`,
    `Motivering: ${t.rationale}${t.law_ref ? ` (${t.law_ref})` : ''}`,
    '',
    'Är facit korrekt?',
  ].join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--model')
  const modelIds = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'gpt-5-6-terra-pro,gemini-3-1-pro').split(',')
  const tasks = loadTasks<BookingTask>('booking')
  const results: Record<string, unknown>[] = []

  for (const id of modelIds) {
    const spec = getModel(id)
    let agree = 0
    let n = 0
    for (const task of tasks) {
      try {
        const res = await chat(spec, {
          system: SYSTEM,
          messages: [{ role: 'user', content: prompt(task) }],
          maxTokens: 2000,
        })
        const parsed = extractJsonObject(res.text)
        const verdict = String(parsed?.verdict ?? 'unparsed')
        n++
        if (verdict === 'correct') agree++
        results.push({
          auditor: id,
          taskId: task.id,
          verdict,
          betterAccount: parsed?.better_account ?? null,
          betterVat: parsed?.better_vat ?? null,
          reason: parsed?.reason ?? null,
          gold: { account: task.gold.account, vat: task.gold.vat_treatment },
          probe: task.probe,
        })
        if (verdict !== 'correct') {
          console.log(`  ${task.id} [${verdict}] ${task.probe.slice(0, 44)}`)
          console.log(`      gold ${task.gold.account}/${task.gold.vat_treatment} -> suggests ${parsed?.better_account ?? '-'}/${parsed?.better_vat ?? '-'}: ${String(parsed?.reason ?? '').slice(0, 150)}`)
        }
      } catch (e) {
        console.log(`  ${task.id}: audit error ${(e as Error).message.slice(0, 90)}`)
      }
    }
    console.log(`== ${id}: ${agree}/${n} golds judged outright correct\n`)
  }

  const out = path.join(BENCH_ROOT, 'results', 'gold-audit.json')
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n')
  console.log(`Wrote ${out}`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
