import { randomUUID } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

describe('legacy repair and bank matching concurrency',()=>{
  it('serializes stage and legacy matching before either checks its target',async()=>{
    const {companyId:company,userId:actor,fiscalPeriodId:period}=await seedCompany()
    const [keep,reverse]=[randomUUID(),randomUUID()]
    const a=await getPool().connect(),b=await getPool().connect()
    try {
      await a.query('BEGIN')
      // Reproduce pre-migration rows in one committed synthetic fixture. Only
      // the new provenance trigger is disabled, then enabled before commit.
      await a.query('ALTER TABLE journal_entries DISABLE TRIGGER guard_sie_entry_provenance')
      for(const [i,id] of [keep,reverse].entries()) {
        await a.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,
          source_type,source_voucher_series,source_voucher_number,entry_date,description,status)
          VALUES($1,$2,$3,$4,'A',$5,'import','A',1,'2026-02-01','Synthetic legacy race','draft')`,[id,company,actor,period,i+1])
        await a.query("INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,'1930',100,0),($1,'3001',0,100)",[id])
      }
      await a.query('ALTER TABLE journal_entries ENABLE TRIGGER guard_sie_entry_provenance')
      await a.query("UPDATE journal_entries SET status='posted' WHERE id=ANY($1)",[[keep,reverse]])
      await a.query('COMMIT')
      const hash=(await a.query('SELECT sie_repair_content_hash($1) hash',[keep])).rows[0].hash
      const args=[company,actor,period,'f'.repeat(64),JSON.stringify([{keepId:keep,reverseId:reverse,contentHash:hash,keepLinks:[],reverseLinks:[]}])]
      const stageSQL='SELECT j.* FROM stage_sie_duplicate_repair($1,$2,$3,$4,$5) j'
      const matchSQL="INSERT INTO transactions(company_id,user_id,date,amount,description,journal_entry_id) VALUES($1,$2,'2026-02-01',100,'Synthetic race match',$3)"
      await a.query('BEGIN')
      await a.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
      await a.query('SET LOCAL ROLE service_role')
      await a.query(stageSQL,args)
      // Stage owns the period but is not committed or visible to B yet. B
      // must fail on the row lock, rather than pass an empty active-job read.
      await b.query('BEGIN')
      await expect(b.query(matchSQL,[company,actor,reverse])).rejects.toMatchObject({code:'55P03'})
      await b.query('ROLLBACK');await a.query('ROLLBACK')

      // Reverse ordering: the match owns the period through commit. Staging
      // must not install its reviewed hold while the match is uncommitted.
      await b.query('BEGIN')
      await b.query(matchSQL,[company,actor,reverse])
      await a.query('BEGIN')
      await a.query("SET LOCAL lock_timeout='150ms'")
      await a.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
      await a.query('SET LOCAL ROLE service_role')
      await expect(a.query(stageSQL,args)).rejects.toMatchObject({code:'55P03'})
      await a.query('ROLLBACK');await b.query('ROLLBACK')
    } finally {
      await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release()
    }
  })
})
