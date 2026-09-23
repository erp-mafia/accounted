import { randomUUID } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { getPool,runAsServiceRole,withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Period-wide deletion has been retired. The replacement handoff, retained
// originals and exact batch storno are exercised in sie-job.pg.test.ts.
describe('retired SIE RPCs cannot bypass durable jobs',()=>{
  it.each(['import_sie_journal_entries','replace_sie_import','undo_sie_import'])('%s has no network-role execute grant',async(name)=>{
    const result=await getPool().query(`SELECT r.role,has_function_privilege(r.role,p.oid,'EXECUTE') allowed
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN (VALUES('anon'),('authenticated'),('service_role')) r(role)
      WHERE n.nspname='public' AND p.proname=$1`,[name])
    expect(result.rows.length).toBeGreaterThanOrEqual(3)
    expect(result.rows.every(row=>row.allowed===false)).toBe(true)
  })
  it('rejects both service-role and owner calls before any legacy replacement write',async()=>{
    const {companyId,userId}=await seedCompany()
    const sql='SELECT replace_sie_import($1,$2,$3)'
    await expect(runAsServiceRole(c=>c.query(sql,[companyId,randomUUID(),userId]))).rejects.toMatchObject({code:'42501'})
    await expect(withUserContext(userId,c=>c.query(sql,[companyId,randomUUID(),userId]))).rejects.toMatchObject({code:'42501'})
  })
  it('keeps unknown legacy executions behind reviewed reconciliation',async()=>{
    const {companyId,userId,fiscalPeriodId}=await seedCompany()
    const row=(await getPool().query(`INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,fiscal_period_id)
      VALUES($1,$2,'legacy.se',$3,4,'failed',$4) RETURNING id`,[companyId,userId,randomUUID(),fiscalPeriodId])).rows[0]
    await expect(runAsServiceRole(c=>c.query('SELECT replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)',
      [companyId,userId,fiscalPeriodId,'replacement.se','a'.repeat(64),'{}',row.id]))).rejects.toThrow(/reviewed reconciliation/)
  })
})
