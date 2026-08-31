/**
 * Operator tool for Peppol access (service role; .env.local points at prod).
 *
 *   npx tsx --env-file=.env.local scripts/peppol/access.ts list
 *       Open requests first, then every company with a row (status, cap, sends used).
 *   npx tsx --env-file=.env.local scripts/peppol/access.ts enable <company_id|orgnr> [--max-sends N] [--receive] [--by you@accounted.se] [--note "..."]
 *       Grants sending (capped at N transmissions, omit for no cap) and, with
 *       --receive, the right to publish the company's identifier (one contracted
 *       tenant slot). Re-running adjusts the same row.
 *   npx tsx --env-file=.env.local scripts/peppol/access.ts disable <company_id|orgnr> [--note "..."]
 *   npx tsx --env-file=.env.local scripts/peppol/access.ts show <company_id|orgnr>
 *
 * Nothing here talks to Qvalia; it only flips what the product allows.
 */

import { createClient } from '@supabase/supabase-js'
import {
  countPeppolSends,
  getPeppolAccess,
  setPeppolAccess,
} from '@/lib/invoices/peppol-access'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)')
  process.exit(2)
}
const service = createClient(supabaseUrl, serviceRoleKey)

const [, , command = 'list', target, ...rest] = process.argv

function flag(name: string): string | null {
  const index = rest.indexOf(`--${name}`)
  if (index === -1) return null
  return rest[index + 1] ?? ''
}

async function resolveCompanyId(input: string | undefined): Promise<string> {
  if (!input) throw new Error('company id or organisation number required')
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) return input
  const digits = input.replace(/\D/g, '')
  const { data, error } = await service
    .from('company_settings')
    .select('company_id, company_name, org_number')
    .limit(2000)
  if (error) throw error
  const hits = ((data ?? []) as Array<{ company_id: string; company_name: string | null; org_number: string | null }>)
    .filter((row) => (row.org_number ?? '').replace(/\D/g, '') === digits)
  if (hits.length !== 1) throw new Error(`${hits.length} companies match org number ${input}`)
  return hits[0].company_id
}

async function describe(companyId: string): Promise<string> {
  const { data } = await service
    .from('company_settings')
    .select('company_name, org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  const row = data as { company_name: string | null; org_number: string | null } | null
  return `${row?.company_name ?? '?'} (${row?.org_number ?? '?'}) ${companyId}`
}

async function main(): Promise<void> {
  switch (command) {
    case 'list': {
      const { data, error } = await service
        .from('peppol_access')
        .select('*')
        .order('status', { ascending: true })
        .order('requested_at', { ascending: true })
      if (error) throw error
      const rows = (data ?? []) as Array<{ company_id: string; status: string; max_sends: number | null; receive_enabled: boolean; requested_at: string | null; enabled_at: string | null; request_note: string | null }>
      if (rows.length === 0) { console.log('No Peppol access rows.'); return }
      for (const row of rows) {
        const sends = row.status === 'enabled' ? await countPeppolSends(service, row.company_id) : 0
        console.log(
          `${row.status.padEnd(9)} ${await describe(row.company_id)}  sends ${sends}/${row.max_sends ?? '∞'}  receive=${row.receive_enabled}`
          + (row.requested_at ? `  requested ${row.requested_at}` : '')
          + (row.request_note ? `\n           note: ${row.request_note}` : ''),
        )
      }
      return
    }
    case 'show': {
      const companyId = await resolveCompanyId(target)
      console.log(await describe(companyId))
      console.log(JSON.stringify(await getPeppolAccess(service, companyId), null, 2))
      console.log('sends used:', await countPeppolSends(service, companyId))
      return
    }
    case 'enable': {
      const companyId = await resolveCompanyId(target)
      const maxSendsRaw = flag('max-sends')
      const maxSends = maxSendsRaw === null ? undefined : (maxSendsRaw === '' || maxSendsRaw === 'none' ? null : Number.parseInt(maxSendsRaw, 10))
      if (maxSends !== undefined && maxSends !== null && !Number.isFinite(maxSends)) throw new Error('--max-sends expects a number or "none"')
      const row = await setPeppolAccess({
        service,
        companyId,
        status: 'enabled',
        maxSends,
        receiveEnabled: rest.includes('--receive') ? true : (rest.includes('--no-receive') ? false : undefined),
        by: flag('by') ?? `scripts/peppol/access.ts (${process.env.USER ?? 'operator'})`,
        note: flag('note') ?? undefined,
      })
      console.log(`enabled: ${await describe(companyId)}`)
      console.log(JSON.stringify(row, null, 2))
      return
    }
    case 'disable': {
      const companyId = await resolveCompanyId(target)
      const row = await setPeppolAccess({
        service,
        companyId,
        status: 'disabled',
        by: flag('by') ?? `scripts/peppol/access.ts (${process.env.USER ?? 'operator'})`,
        note: flag('note') ?? undefined,
      })
      console.log(`disabled: ${await describe(companyId)}`)
      console.log(JSON.stringify(row, null, 2))
      return
    }
    default:
      throw new Error(`Unknown command "${command}". See the header comment.`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
