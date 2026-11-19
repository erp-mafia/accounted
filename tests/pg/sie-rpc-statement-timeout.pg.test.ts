import {describe,expect,it} from 'vitest'
import {getClient,getPool} from './setup'

// CREATE OR REPLACE drops function-local settings unless repeated. Keep the
// cancellation budget below the HTTP gateway, including both kinds of undo.
describe('bounded SIE writer timeouts',()=>{
  it.each(['write_sie_job_entries','import_sie_chunk','undo_sie_import_chunk','undo_sie_duplicate_repair_chunk'])('%s keeps a 30s cancellation budget',async(name)=>{
    const result=await getPool().query(`SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1`,[name])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].proconfig).toContain('statement_timeout=30s')
  })
})

// PostgREST runs pgrst.db_pre_request on every request, as the request's role,
// inside the request transaction before the main statement (20260826130000).
async function timeoutAfterHook(path:string) {
  const client=await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout='8s'`)
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(`SELECT set_config('request.path',$1,true)`,[path])
    await client.query('SELECT public.pre_request_statement_timeout()')
    return (await client.query<{timeout:string}>(`SELECT current_setting('statement_timeout') timeout`)).rows[0]!.timeout
  } finally {
    await client.query('ROLLBACK').catch(()=>{})
    client.release()
  }
}

describe('pre-request statement timeout hook',()=>{
  it.each(['/rpc/import_sie_chunk','/rpc/reconcile_sie_import','/rpc/rollup_agent_telemetry'])('raises %s to 30s',async(path)=>{
    expect(await timeoutAfterHook(path)).toBe('30s')
  })
  it.each(['/rpc/import_sie_journal_entries','/rpc/replace_sie_import','/rpc/undo_sie_import','/rpc/undo_sie_import_chunk','/journal_entries',''])(
    'leaves the role default for %j',async(path)=>{
      expect(await timeoutAfterHook(path)).toBe('8s')
    })
  it('stays callable by every request role',async()=>{
    const result=await getPool().query(`SELECT r.role,has_function_privilege(r.role,'public.pre_request_statement_timeout()','EXECUTE') allowed
      FROM (VALUES('anon'),('authenticated'),('service_role')) r(role)`)
    expect(result.rows.every(row=>row.allowed===true)).toBe(true)
  })
})
