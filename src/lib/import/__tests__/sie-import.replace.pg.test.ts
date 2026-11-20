import { randomUUID } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { getPool,runAsServiceRole } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Period-wide deletion has been retired. The replacement handoff, retained
// originals and exact batch storno are exercised in sie-job.pg.test.ts.
describe('retired SIE RPCs cannot bypass durable jobs',()=>{
  // Revoked from every API role at the job cutover (20260911140532), dropped
  // in 20261012100200: no overload of any of the three may come back.
  it.each(['import_sie_journal_entries','replace_sie_import','undo_sie_import'])('%s no longer exists',async(name)=>{
    const result=await getPool().query(`SELECT p.oid::regprocedure::text signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname=$1`,[name])
    expect(result.rows).toEqual([])
  })
  it('keeps unknown legacy executions behind reviewed reconciliation',async()=>{
    const {companyId,userId,fiscalPeriodId}=await seedCompany()
    const row=(await getPool().query(`INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,fiscal_period_id)
      VALUES($1,$2,'legacy.se',$3,4,'failed',$4) RETURNING id`,[companyId,userId,randomUUID(),fiscalPeriodId])).rows[0]
    await expect(runAsServiceRole(c=>c.query('SELECT replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)',
      [companyId,userId,fiscalPeriodId,'replacement.se','a'.repeat(64),'{}',row.id]))).rejects.toThrow(/reviewed reconciliation/)
  })
})
