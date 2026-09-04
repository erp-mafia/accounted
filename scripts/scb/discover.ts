/**
 * Print what SCB's current API exposes on the Je layout: the variable list,
 * the category code tables, and one company looked up by org number, so the
 * names in lib/parties/scb/client.ts are checked against the live API.
 *
 * Usage:
 *   SCB_API_CERT_PFX_BASE64=... SCB_API_CERT_PASSWORD=... \
 *     npx tsx scripts/scb/discover.ts [--org 5560125790] [--env <file>]
 *
 * Read-only against SCB. Prints to stdout; never writes to a database.
 */
import { config as dotenv } from 'dotenv'
import { createScbClient } from '@/lib/parties/scb/client'
import { scbConfigFromEnv } from '@/lib/parties/scb/config'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const envFile = arg('env')
  if (envFile) dotenv({ path: envFile })
  const client = createScbClient(scbConfigFromEnv())
  const org = arg('org') ?? '5560125790'
  const show = (label: string, v: unknown) => console.log(`\n=== ${label}\n${JSON.stringify(v, null, 2).slice(0, 12000)}`)
  try {
    show('Variabler (Je)', await client.variables())
  } catch (e) {
    console.error('Variabler failed:', e instanceof Error ? e.message : e)
  }
  try {
    show('KategorierMedKodtabeller (Je)', await client.categories())
  } catch (e) {
    console.error('Kategorier failed:', e instanceof Error ? e.message : e)
  }
  try {
    show(`HamtaForetag ${org}`, await client.lookupByOrgNumber(org))
  } catch (e) {
    console.error('HamtaForetag failed:', e instanceof Error ? e.message : e)
  }
}

void main()
