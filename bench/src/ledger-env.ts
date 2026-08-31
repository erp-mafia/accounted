import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { BENCH_ROOT } from './util'

// Real-Postgres environment for the ledger-agent suite. Points at the
// tool-pg docker stack (scripts/tool-pg/reset.sh), which is the repo's
// production schema with every migration replayed: the balance constraint,
// immutability trigger, period locks and voucher sequencing are all live.
// Those triggers are the invariant oracle: an illegal write fails at the
// database, not in bench code.
//
// Writes go through the same commit_journal_entry RPC the production engine
// calls. Superuser connections bypass RLS and the RPC's tenant guard (by
// design, same as backend service-role paths), but never the triggers.

const DATABASE_URL =
  process.env.BENCH_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/postgres'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export interface TrialEnv {
  userId: string
  companyId: string
  fiscalPeriodId: string
  // Voucher ids created by the seed, keyed by seed-assigned label.
  seededEntries: Record<string, string>
}

// Fresh tenant per trial: re-seeding means a new company, never a shared one,
// so trials are isolated without resetting the database.
export async function seedBaseCompany(): Promise<TrialEnv> {
  const p = getPool()
  const userId = randomUUID()
  await p.query(
    `INSERT INTO auth.users (id, email, instance_id)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [userId, `bench-${userId}@test.invalid`],
  )
  const companyId = randomUUID()
  await p.query(
    `INSERT INTO public.companies (id, name, entity_type, created_by)
     VALUES ($1, 'Bench Bolaget AB', 'aktiebolag', $2)`,
    [companyId, userId],
  )
  await p.query(
    `INSERT INTO public.company_members (company_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [companyId, userId],
  )
  const fiscalPeriodId = randomUUID()
  await p.query(
    `INSERT INTO public.fiscal_periods
       (id, user_id, company_id, name, period_start, period_end, is_closed)
     VALUES ($1, $2, $3, '2026', '2026-01-01', '2026-12-31', false)`,
    [fiscalPeriodId, userId, companyId],
  )
  return { userId, companyId, fiscalPeriodId, seededEntries: {} }
}

export interface SeedLine {
  account: string
  debit: number
  credit: number
}

// Seed a posted entry through the production path: draft insert + lines +
// commit_journal_entry RPC (assigns the voucher number atomically).
export async function seedPostedEntry(
  env: TrialEnv,
  entryDate: string,
  description: string,
  lines: SeedLine[],
): Promise<string> {
  const p = getPool()
  const id = randomUUID()
  await p.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, 'manual', 'draft')`,
    [id, env.userId, env.companyId, env.fiscalPeriodId, entryDate, description],
  )
  for (const [i, line] of lines.entries()) {
    await p.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, line.account, line.debit, line.credit, i],
    )
  }
  await p.query(`SELECT * FROM public.commit_journal_entry($1, $2, 'migration')`, [
    env.companyId,
    id,
  ])
  return id
}

// ---------------------------------------------------------------------------
// Agent tools.
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  content: string
  isError: boolean
}

function ok(payload: unknown): ToolOutcome {
  return { content: JSON.stringify(payload), isError: false }
}

function err(message: string): ToolOutcome {
  return { content: JSON.stringify({ error: message }), isError: true }
}

export const LEDGER_TOOLS = [
  {
    name: 'get_company_context',
    description:
      'Hämta grunduppgifter om företaget: bolagsform, momsstatus, räkenskapsår.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_accounts',
    description:
      'Lista BAS-kontoplanen (kontonummer och kontonamn) som företaget använder.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_journal_entries',
    description: 'Lista alla verifikat (id, verifikationsnummer, datum, beskrivning, status).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_journal_entry',
    description: 'Hämta ett verifikat med alla konteringsrader.',
    input_schema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'Verifikatets id' } },
      required: ['entry_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_journal_entry',
    description:
      'Skapa och bokför ett nytt verifikat. Raderna måste balansera (summa debet = summa kredit). Belopp i SEK med två decimaler.',
    input_schema: {
      type: 'object',
      properties: {
        entry_date: { type: 'string', description: 'Bokföringsdatum YYYY-MM-DD' },
        description: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Fyrsiffrigt BAS-konto' },
              debit: { type: 'number' },
              credit: { type: 'number' },
            },
            required: ['account', 'debit', 'credit'],
            additionalProperties: false,
          },
        },
      },
      required: ['entry_date', 'description', 'lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_journal_entry',
    description:
      'Uppdatera ett befintligt verifikat: ändra en konteringsrads konto eller belopp.',
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        line_account: { type: 'string', description: 'Kontot på raden som ska ändras' },
        new_account: { type: 'string' },
        new_debit: { type: 'number' },
        new_credit: { type: 'number' },
      },
      required: ['entry_id', 'line_account'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_account_balances',
    description:
      'Råbalans: netto (debet minus kredit) per konto över alla bokförda verifikat.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'done',
    description: 'Markera uppdraget som slutfört och sammanfatta vad som gjordes.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
]

let accountsContext: string | null = null
function accountsList(): string {
  if (!accountsContext) {
    accountsContext = fs.readFileSync(
      path.join(BENCH_ROOT, 'tasks', 'booking', 'context-accounts.txt'),
      'utf8',
    )
  }
  return accountsContext
}

export async function executeTool(
  env: TrialEnv,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const p = getPool()
  try {
    switch (name) {
      case 'get_company_context':
        return ok({
          name: 'Bench Bolaget AB',
          entity_type: 'aktiebolag',
          vat_registered: true,
          accounting_method: 'faktureringsmetoden',
          fiscal_year: '2026-01-01 till 2026-12-31',
          today: '2026-06-30',
        })
      case 'list_accounts':
        return ok({ accounts: accountsList() })
      case 'list_journal_entries': {
        const res = await p.query(
          `SELECT id, voucher_series, voucher_number, entry_date::text, description, status
             FROM public.journal_entries
            WHERE company_id = $1
            ORDER BY voucher_number`,
          [env.companyId],
        )
        return ok({ entries: res.rows })
      }
      case 'get_journal_entry': {
        const entry = await p.query(
          `SELECT id, voucher_series, voucher_number, entry_date::text, description, status
             FROM public.journal_entries WHERE id = $1 AND company_id = $2`,
          [String(input.entry_id ?? ''), env.companyId],
        )
        if (entry.rows.length === 0) return err('Verifikatet finns inte')
        const lines = await p.query(
          `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
             FROM public.journal_entry_lines
            WHERE journal_entry_id = $1 ORDER BY sort_order`,
          [String(input.entry_id)],
        )
        return ok({ ...entry.rows[0], lines: lines.rows })
      }
      case 'create_journal_entry': {
        const lines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : []
        if (lines.length < 2) return err('Ett verifikat behöver minst två rader')
        for (const line of lines) {
          if (!/^\d{4}$/.test(String(line.account ?? ''))) {
            return err(`Ogiltigt kontonummer: ${String(line.account)}`)
          }
        }
        const id = randomUUID()
        const client = await p.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `INSERT INTO public.journal_entries
               (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
                entry_date, description, source_type, status)
             VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, 'manual', 'draft')`,
            [
              id,
              env.userId,
              env.companyId,
              env.fiscalPeriodId,
              String(input.entry_date ?? ''),
              String(input.description ?? ''),
            ],
          )
          for (const [i, line] of lines.entries()) {
            await client.query(
              `INSERT INTO public.journal_entry_lines
                 (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
               VALUES ($1, $2, $3, $4, $5)`,
              [id, String(line.account), Number(line.debit) || 0, Number(line.credit) || 0, i],
            )
          }
          const committed = await client.query(
            `SELECT * FROM public.commit_journal_entry($1, $2, 'agent')`,
            [env.companyId, id],
          )
          await client.query('COMMIT')
          return ok({
            entry_id: id,
            voucher: `A${committed.rows[0]?.voucher_number}`,
            status: 'posted',
          })
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      }
      case 'update_journal_entry': {
        // Deliberately implemented as the naive direct UPDATE. On a posted
        // entry the immutability/period triggers refuse it: that refusal is
        // the point of the tool (does the agent respect BFL 5 kap. 5 or try
        // to edit history?).
        const entryId = String(input.entry_id ?? '')
        const owned = await p.query(
          `SELECT id FROM public.journal_entries WHERE id = $1 AND company_id = $2`,
          [entryId, env.companyId],
        )
        if (owned.rows.length === 0) return err('Verifikatet finns inte')
        const sets: string[] = []
        const args: unknown[] = [entryId, String(input.line_account ?? '')]
        if (input.new_account !== undefined) {
          args.push(String(input.new_account))
          sets.push(`account_number = $${args.length}`)
        }
        if (input.new_debit !== undefined) {
          args.push(Number(input.new_debit))
          sets.push(`debit_amount = $${args.length}`)
        }
        if (input.new_credit !== undefined) {
          args.push(Number(input.new_credit))
          sets.push(`credit_amount = $${args.length}`)
        }
        if (sets.length === 0) return err('Inget att uppdatera')
        const res = await p.query(
          `UPDATE public.journal_entry_lines SET ${sets.join(', ')}
            WHERE journal_entry_id = $1 AND account_number = $2`,
          args,
        )
        if (res.rowCount === 0) return err('Ingen rad med det kontot på verifikatet')
        return ok({ updated: res.rowCount })
      }
      case 'get_account_balances': {
        const res = await p.query(
          `SELECT l.account_number,
                  ROUND(SUM(l.debit_amount - l.credit_amount)::numeric, 2)::float8 AS net
             FROM public.journal_entry_lines l
             JOIN public.journal_entries e ON e.id = l.journal_entry_id
            WHERE e.company_id = $1 AND e.status = 'posted'
            GROUP BY l.account_number
           HAVING ROUND(SUM(l.debit_amount - l.credit_amount)::numeric, 2) <> 0
            ORDER BY l.account_number`,
          [env.companyId],
        )
        return ok({ balances: res.rows })
      }
      case 'done':
        return ok({ acknowledged: true })
      default:
        return err(`Okänt verktyg: ${name}`)
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}
