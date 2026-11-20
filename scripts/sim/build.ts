/**
 * npm run sim:build: build the simulated company into the tool-pg stack and
 * write what the tests need to .local/sim/state.json. See tests/sim/build.ts.
 *
 *   npm run tools:pg:reset                    # the database, once
 *   npm run sim:build                         # the small company
 *   SIM_SCALE=full npm run sim:build          # the nightly company
 *   npm run sim:build -- --until 2024-06-30   # stop partway through its life
 *
 * Tool logs go to .local/sim/build.log. npm run local:up -- --sim runs this
 * against its own local Supabase instead, naming it in SIM_SUPABASE_URL,
 * SIM_SERVICE_ROLE_KEY, SIM_USER_ID and SIM_PERSONNUMMER_KEY.
 *
 * Nothing is read from the environment that could point this at a real
 * database: the target must be this machine or CI's PostgREST service.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { signServiceRoleJwt, TOOL_PG_DATABASE_URL, TOOL_PG_REST_URL } from '../../tests/tool-pg/client'
import { computeAnswerKey } from '../../tests/sim/answer-key'
import { generateCompany, type SimScaleName } from '../../tests/sim/generate'
import { installSimNetwork } from '../../tests/sim/network'
import { registerScriptInitLoader } from '../lib/register-init-loader'

registerScriptInitLoader()

const DIRECTORY = path.join('.local', 'sim')
const THIS_MACHINE = new Set(['127.0.0.1', 'localhost', 'postgrest'])

/**
 * The Postgres image ships auth.role() and auth.uid() in their old form, which
 * read settings PostgREST 12 no longer sets; GoTrue replaces them with these on
 * a real Supabase, and the tool-pg stack has no GoTrue. Without them every RPC
 * that recognises the service role refuses it.
 */
const AUTH_FUNCTIONS = `
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
  $$;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
`

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** The tool-pg stack has no GoTrue: the auth functions and the owner are put there by hand. */
async function prepareToolPgStack(): Promise<string> {
  const pool = new Pool({ connectionString: TOOL_PG_DATABASE_URL })
  await pool.query(AUTH_FUNCTIONS)
  const userId = randomUUID()
  await pool.query(
    `INSERT INTO auth.users (id, email, instance_id) VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [userId, `sim-${userId}@example.invalid`],
  )
  await pool.end()
  return userId
}

/** Realtime is never used; Node 20 has no WebSocket to resolve (tests/tool-pg/client.ts). */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('simulated company: realtime is not used')
  }
}

async function main(): Promise<void> {
  const seed = Number(process.env.SIM_SEED ?? 20240101)
  const scale = (process.env.SIM_SCALE ?? 'small') as SimScaleName
  const until = arg('until')
  const localUrl = process.env.SIM_SUPABASE_URL
  const databaseUrl = localUrl ?? TOOL_PG_REST_URL
  if (!THIS_MACHINE.has(new URL(databaseUrl).hostname)) throw new Error(`refusing a database elsewhere: ${databaseUrl}`)
  const serviceKey = localUrl ? process.env.SIM_SERVICE_ROLE_KEY! : signServiceRoleJwt()

  process.env.PERSONNUMMER_ENCRYPTION_KEY = process.env.SIM_PERSONNUMMER_KEY ?? randomBytes(32).toString('hex')
  process.env.NEXT_PUBLIC_SUPABASE_URL = databaseUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sim'
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  process.env.CRON_SECRET = 'sim'
  installSimNetwork({ databaseUrl, bareRest: !localUrl })

  fs.mkdirSync(DIRECTORY, { recursive: true })
  const logFile = fs.createWriteStream(path.join(DIRECTORY, 'build.log'))
  const toLog = (...args: unknown[]) => void logFile.write(`${args.map(String).join(' ')}\n`)
  const say = console.log
  console.log = toLog
  console.info = toLog
  console.warn = toLog
  console.error = toLog

  // Imported after the environment is set: the modules read it as they load.
  const { buildSimCompany } = await import('../../tests/sim/build')
  const { createServiceRoleClient } = await import('../../src/lib/supabase/service-client')

  const userId = process.env.SIM_USER_ID ?? (await prepareToolPgStack())
  const plan = generateCompany(seed, scale)
  const key = computeAnswerKey(plan)
  const supabase = createServiceRoleClient(databaseUrl, serviceKey, {
    db: { schema: 'public' },
    realtime: { transport: UnusedRealtimeTransport as never },
    global: { headers: { apikey: serviceKey } },
  })
  say(`Building ${scale} company, seed ${seed}: ${plan.events.length} events`)
  const state = await buildSimCompany(plan, key, { supabase, userId, until, onProgress: say })
  if (localUrl) {
    // local:up's login lands in this company, not the empty one it seeded.
    const { error } = await supabase
      .from('user_preferences')
      .upsert({ user_id: userId, active_company_id: state.companyId }, { onConflict: 'user_id' })
    if (error) throw new Error(`making the simulated company active failed: ${error.message}`)
  }
  fs.writeFileSync(arg('state') ?? path.join(DIRECTORY, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  say(`Built ${state.events} events in ${state.seconds} s: company ${state.companyId}`)
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
