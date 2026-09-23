import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from './setup'

let client: PoolClient
beforeAll(async () => { client = await getPool().connect(); await client.query('BEGIN') })
afterAll(async () => { if (client) { await client.query('ROLLBACK'); client.release() } })
beforeEach(async () => { await client.query('SAVEPOINT scenario') })
afterEach(async () => { await client.query('ROLLBACK TO SAVEPOINT scenario') })

async function seed(isSandbox = true) {
  const [user, company, period] = Array.from({ length: 3 }, () => randomUUID())
  await client.query("INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')",
    [user, `sie-cleanup-${user}@test.invalid`])
  await client.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic cleanup company','aktiebolag',$2)", [company, user])
  await client.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')", [company, user])
  await client.query('INSERT INTO company_settings(company_id,user_id,is_sandbox) VALUES($1,$2,$3)', [company, user, isSandbox])
  await client.query("INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')",
    [period, company, user])
  await client.query("INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_type,account_class,normal_balance) VALUES($1,$2,'1930','Bank','asset',1,'debit'),($1,$2,'3001','Sales','revenue',3,'credit')", [company, user])
  return { user, company, period }
}

async function importFixture(f: Awaited<ReturnType<typeof seed>>, kind: 'legacy' | 'completed' | 'paused' | 'repair') {
  const [job, entry, second] = Array.from({ length: 3 }, () => randomUUID())
  await client.query(`INSERT INTO sie_imports(id,company_id,user_id,execution_actor_id,filename,file_hash,status,sie_type,
    fiscal_period_id,job_state,job_phase,job_kind) VALUES($1,$2,$3,$3,'synthetic.se',$4,'completed',4,$5,$6,$7,$8)`,
  [job, f.company, f.user, randomUUID(), f.period, kind === 'legacy' ? null : 'completed',
    kind === 'legacy' ? null : 'finalize', kind === 'repair' ? 'duplicate_repair' : 'import'])
  if (kind === 'legacy') return { job, entry: null }

  for (const [ordinal, id] of [entry, second].entries()) {
    await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,
      entry_date,description,source_type,status,import_batch_id,source_ordinal,source_content_hash)
      VALUES($1,$2,$3,$4,'A',$5,'2026-02-01','Synthetic import','import','draft',$6,$7,$8)`,
    [id, f.company, f.user, f.period, ordinal + 1, job, ordinal, 'b'.repeat(64)])
    await client.query("INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,'1930',100,0),($1,'3001',0,100)", [id])
    await client.query("UPDATE journal_entries SET status='posted' WHERE id=$1", [id])
  }
  await client.query(`UPDATE fiscal_periods SET opening_balance_entry_id=$2,opening_balances_set=true,
    opening_balance_review_import_id=$3,opening_balance_review_token=$4,opening_balance_review_entry_id=$2,
    opening_balance_review_reason='import' WHERE id=$1`, [f.period, entry, job, randomUUID()])
  await client.query('UPDATE sie_imports SET opening_balance_entry_id=$2 WHERE id=$1', [job, entry])
  await client.query(`INSERT INTO sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES($1,$2,$3,'vouchers',0,$4,'completed','{}',now())`, [job, f.company, f.user, 'b'.repeat(64)])
  await client.query(`INSERT INTO document_attachments(company_id,user_id,storage_path,file_name,sha256_hash,journal_entry_id,upload_source)
    VALUES($1,$2,'synthetic/cleanup.pdf','cleanup.pdf','synthetic',$3,'file_upload')`, [f.company, f.user, entry])
  if (kind === 'paused' || kind === 'repair') {
    await client.query("UPDATE sie_imports SET job_state='paused',job_phase=$2,worker_id=$3,lease_until=now()+interval '2 minutes' WHERE id=$1",
      [job, kind === 'repair' ? 'undo' : 'vouchers', randomUUID()])
    if (kind === 'repair') await client.query(`INSERT INTO sie_duplicate_repair_items(import_id,company_id,user_id,ordinal,keep_entry_id,reverse_entry_id,content_hash)
      VALUES($1,$2,$3,0,$4,$5,$6)`, [job, f.company, f.user, entry, second, 'b'.repeat(64)])
    await client.query('UPDATE fiscal_periods SET import_hold=$2 WHERE id=$1', [f.period, job])
  } else {
    await client.query("INSERT INTO sie_period_read_leases(company_id,expires_at,purpose) VALUES($1,now()+interval '5 minutes','report_export')", [f.company])
  }
  return { job, entry }
}

async function rejected(query: () => Promise<unknown>, message: RegExp) {
  await client.query('SAVEPOINT refusal')
  await expect(query()).rejects.toThrow(message)
  await client.query('ROLLBACK TO SAVEPOINT refusal')
}

describe('SIE history during verified sandbox teardown', () => {
  it('cannot attach a contradictory sandbox classification to the same company', async () => {
    const f = await seed()
    await rejected(() => client.query('INSERT INTO company_settings(company_id,user_id,is_sandbox) VALUES($1,$2,false)',
      [f.company, f.user]), /company_settings_company_id_key/)
  })

  it.each(['legacy', 'completed', 'paused', 'repair'] as const)('cleans a sandbox with %s import state and all SIE dependencies', async kind => {
    const f = await seed()
    await importFixture(f, kind)
    await client.query('SET LOCAL ROLE service_role')
    await client.query('SELECT cleanup_sandbox_user($1)', [f.user])
    await client.query('RESET ROLE')
    for (const table of ['sie_imports', 'sie_import_chunks', 'sie_duplicate_repair_items', 'sie_period_read_leases', 'journal_entries', 'operations']) {
      expect((await client.query(`SELECT count(*)::int n FROM ${table} WHERE company_id=$1`, [f.company])).rows[0].n).toBe(0)
    }
    expect((await client.query('SELECT count(*)::int n FROM auth.users WHERE id=$1', [f.user])).rows[0].n).toBe(0)
    const flags = (await client.query("SELECT current_setting('gnubok.sandbox_cleanup',true) sc,current_setting('gnubok.allow_delete',true) del")).rows[0]
    expect(flags.sc).not.toBe('true')
    expect(flags.del).not.toBe('true')
  })

  it('keeps real-company history even when the cleanup flags are forged', async () => {
    const f = await seed(false)
    const { job, entry } = await importFixture(f, 'completed')
    const second = (await client.query('SELECT id FROM journal_entries WHERE import_batch_id=$1 AND source_ordinal=1', [job])).rows[0].id
    await client.query(`INSERT INTO sie_duplicate_repair_items(import_id,company_id,user_id,ordinal,keep_entry_id,reverse_entry_id,content_hash)
      VALUES($1,$2,$3,0,$4,$5,$6)`, [job, f.company, f.user, entry, second, 'b'.repeat(64)])
    await client.query("SELECT set_config('gnubok.sandbox_cleanup','true',true),set_config('gnubok.allow_delete','true',true)")
    await rejected(() => client.query('DELETE FROM sie_imports WHERE id=$1', [job]), /history cannot be deleted/)
    await rejected(() => client.query('DELETE FROM journal_entries WHERE id=$1', [entry]), /batch entries cannot be deleted/)
    await rejected(() => client.query('DELETE FROM sie_duplicate_repair_items WHERE import_id=$1', [job]), /scope is immutable/)
    await rejected(() => client.query('DELETE FROM operations WHERE id=$1', [job]), /terminal status .* cannot be deleted/)
    await rejected(() => client.query('SELECT cleanup_sandbox_user($1)', [f.user]), /not a sandbox user/)
    expect((await client.query('SELECT status FROM journal_entries WHERE id=$1', [entry])).rows[0].status).toBe('posted')
  })

  it('does not accept a forged cleanup flag from a service-role caller', async () => {
    const f = await seed()
    const { job } = await importFixture(f, 'completed')
    await client.query("SELECT set_config('gnubok.sandbox_cleanup','true',true)")
    await client.query('SET LOCAL ROLE service_role')
    await rejected(() => client.query('DELETE FROM sie_imports WHERE id=$1', [job]), /history cannot be deleted/)
    await rejected(() => client.query('DELETE FROM operations WHERE id=$1', [job]), /terminal status .* cannot be deleted/)
  })

  it('keeps completed sandbox manifests immutable outside the DELETE teardown path', async () => {
    const f = await seed()
    const { job } = await importFixture(f, 'completed')
    await client.query("SELECT set_config('gnubok.sandbox_cleanup','true',true)")
    await rejected(() => client.query(`UPDATE sie_imports SET manifest='{"forged":true}' WHERE id=$1`, [job]), /manifest is immutable/)
    await rejected(() => client.query(`UPDATE operations SET result='{"forged":true}' WHERE id=$1`, [job]), /terminal status .* is immutable/)
  })

  it.each(['succeeded', 'failed', 'cancelled'])('retains %s sandbox operations outside cleanup', async status => {
    const f = await seed()
    const operation = randomUUID()
    await client.query(`INSERT INTO operations(id,company_id,user_id,operation_type,status)
      VALUES($1,$2,$3,'imports.sie',$4)`, [operation, f.company, f.user, status])
    await rejected(() => client.query('DELETE FROM operations WHERE id=$1', [operation]), /terminal status .* cannot be deleted/)
    await client.query("SELECT set_config('gnubok.sandbox_cleanup','true',true)")
    await client.query('DELETE FROM company_settings WHERE company_id=$1', [f.company])
    await rejected(() => client.query('DELETE FROM operations WHERE id=$1', [operation]), /terminal status .* cannot be deleted/)
  })

  it('refuses a mixed real and sandbox user before modifying either company', async () => {
    const f = await seed()
    const { job } = await importFixture(f, 'completed')
    const other = randomUUID()
    await client.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic real company','aktiebolag',$2)", [other, f.user])
    await client.query('INSERT INTO company_settings(company_id,user_id,is_sandbox) VALUES($1,$2,false)', [other, f.user])
    await rejected(() => client.query('SELECT cleanup_sandbox_user($1)', [f.user]), /not a sandbox user/)
    expect((await client.query('SELECT id FROM sie_imports WHERE id=$1', [job])).rows).toHaveLength(1)
  })

  it('waits behind a worker company lock before deleting sandbox state', async () => {
    const f = await seed()
    await importFixture(f, 'legacy')
    const worker = await getPool().connect()
    try {
      await worker.query('BEGIN')
      await worker.query("SELECT pg_advisory_xact_lock(hashtextextended('sie-company:'||$1::text,0))", [f.company])
      await client.query("SET LOCAL lock_timeout='200ms'")
      await rejected(() => client.query('SELECT cleanup_sandbox_user($1)', [f.user]), /lock timeout/)
    } finally {
      await worker.query('ROLLBACK')
      worker.release()
    }
  })
})
