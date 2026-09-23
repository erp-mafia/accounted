import {describe,expect,it} from 'vitest'
import {getPool} from './setup'

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
