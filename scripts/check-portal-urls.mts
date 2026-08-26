/**
 * Open every URL in the portal directory and report the ones that are wrong.
 *
 * The directory shipped with eighteen hand-written paths, none of them opened.
 * The file warned about exactly that and shipped anyway, and a founder then hit
 * a 404 on Google Workspace. A sweep found GitHub broken too. This exists so
 * the next wrong URL is found by a script rather than by a person who trusted
 * the link.
 *
 *   npx tsx scripts/check-portal-urls.mts
 *
 * A 404 is the signal. 401/403 and a redirect to a login host both mean the
 * path exists and is asking who you are, which is the expected answer for a
 * billing page. Several hosts (Google, OpenAI, Hetzner) refuse automated
 * requests outright and report as UNREACHABLE: that is not proof of a bad URL,
 * only proof that this script cannot judge it, and those entries should be kept
 * shallow enough that a human landing on them is never lost.
 */
import { PORTAL_DIRECTORY } from '../lib/receipt-hunt/portal-directory'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

type Verdict = 'OK' | 'BROKEN' | 'UNREACHABLE'

async function check(url: string): Promise<{ verdict: Verdict; detail: string }> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': UA },
    })
    const where = res.redirected ? ` -> ${new URL(res.url).host}` : ''
    if (res.status === 404 || res.status === 410) {
      return { verdict: 'BROKEN', detail: `${res.status}${where}` }
    }
    return { verdict: 'OK', detail: `${res.status}${where}` }
  } catch (err) {
    return { verdict: 'UNREACHABLE', detail: err instanceof Error ? err.message.slice(0, 44) : 'okänt fel' }
  }
}

const results = await Promise.all(
  PORTAL_DIRECTORY.map(async (entry) => ({ entry, ...(await check(entry.url)) })),
)

for (const r of results) {
  const mark = r.verdict === 'BROKEN' ? '✗' : r.verdict === 'UNREACHABLE' ? '?' : '✓'
  console.log(`${mark} ${r.entry.vendor.padEnd(22)} ${r.detail.padEnd(30)} ${r.entry.url}`)
}

const broken = results.filter((r) => r.verdict === 'BROKEN')
const unreachable = results.filter((r) => r.verdict === 'UNREACHABLE')

console.log(
  `\n${results.length} länkar: ${results.length - broken.length - unreachable.length} svarade, ` +
    `${unreachable.length} gick inte att nå, ${broken.length} trasiga`,
)

if (unreachable.length > 0) {
  console.log(`\nGick inte att nå (kan inte bedömas härifrån, håll dem grunda):`)
  for (const r of unreachable) console.log(`  ${r.entry.vendor}: ${r.entry.url}`)
}

// Only a genuine 404 fails the run. An unreachable host is a limit of this
// script, not a defect in the directory, and failing on it would train people
// to ignore the output.
if (broken.length > 0) {
  console.error(`\nTrasiga länkar som måste rättas:`)
  for (const r of broken) console.error(`  ${r.entry.vendor}: ${r.entry.url} (${r.detail})`)
  process.exit(1)
}
