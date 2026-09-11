import { randomUUID } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { getPool,runAsServiceRole,withUserContext } from '@/tests/pg/setup'
import { seedCompany,insertAuthUser,insertCompanyMember } from '@/tests/pg/fixtures'

async function fixture(role:'owner'|'admin'|'member'|'viewer'='owner') {
  const {companyId,userId,fiscalPeriodId}=await seedCompany()
  const actor=role==='owner' ? userId : await insertAuthUser()
  if(actor!==userId) await insertCompanyMember({companyId,userId:actor,role})
  const job=(await getPool().query(`INSERT INTO sie_imports(company_id,user_id,execution_actor_id,filename,file_hash,
    sie_type,status,fiscal_period_id,job_state,job_phase) VALUES($1,$2,$3,'actor.se',$4,4,'completed',$5,'completed','finalize') RETURNING id`,
    [companyId,userId,actor,randomUUID(),fiscalPeriodId])).rows[0].id
  return {companyId,userId,actor,job}
}
describe('durable SIE undo authorization',()=>{
  it.each(['owner','admin'] as const)('accepts an explicit %s actor from the server',async(role)=>{
    const f=await fixture(role)
    const result=await runAsServiceRole(c=>c.query('SELECT j.* FROM request_sie_import_undo($1,$2,$3) j',[f.companyId,f.job,f.actor]))
    expect(result.rows[0].job_state).toBe('undoing')
    expect(result.rows[0].execution_actor_id).toBe(f.actor)
  })
  it.each(['member','viewer'] as const)('refuses a %s even for their own completed execution',async(role)=>{
    const f=await fixture(role)
    await expect(runAsServiceRole(c=>c.query('SELECT request_sie_import_undo($1,$2,$3)',[f.companyId,f.job,f.actor]))).rejects.toMatchObject({code:'42501'})
  })
  it('refuses a missing or foreign actor',async()=>{
    const f=await fixture(),other=await seedCompany()
    for(const actor of [null,other.userId]) await expect(runAsServiceRole(c=>c.query('SELECT request_sie_import_undo($1,$2,$3)',[f.companyId,f.job,actor]))).rejects.toMatchObject({code:'42501'})
  })
  it('cannot impersonate the owner from an authenticated viewer session',async()=>{
    const f=await fixture('viewer')
    await expect(withUserContext(f.actor,c=>c.query('SELECT request_sie_import_undo($1,$2,$3)',[f.companyId,f.job,f.userId]))).rejects.toMatchObject({code:'42501'})
  })
})
