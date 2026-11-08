import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { parseSIEFile } from '../sie-parser'
import type { SIEPreparedEntry } from '../sie-job-contract'
const mocks=vi.hoisted(()=>({prepare:vi.fn(),rows:vi.fn(),source:vi.fn()}))
vi.mock('../sie-import',()=>({importVouchers:mocks.prepare}))
vi.mock('../sie-jobs',()=>({readSIEJobSource:mocks.source}))
vi.mock('@/lib/supabase/fetch-all',()=>({fetchAllRows:mocks.rows}))
import { planSIEResync } from '../sie-resync'
const source=`#FLAGGA 0
#FORMAT PC8
#SIETYP 4
#GEN 20260101
#RAR 0 20260101 20261231
#KONTO 1930 "Bank"
#KONTO 3001 "Sales"
#IB 0 1930 0
#UB 0 1930 100
#VER "A" 1 20260201 "Sale"
{
#TRANS 1930 {} 100
#TRANS 3001 {} -100
}
`
const baseline={id:'baseline',file_storage_path:'archive',job_state:'completed',manifest:{input:{mappings:[],options:{}}}}
function entry(ordinal:number,number=ordinal+1):SIEPreparedEntry {
  return {sourceId:`A${number}`,sourceOrdinal:ordinal,sieImportId:'preview',series:'A',date:'2026-02-01',description:'Sale',sourceSeries:'A',sourceNumber:number,sourceType:'import',lines:[]}
}
function setup(classified:unknown[],existing:unknown[]=[{id:'old',source_voucher_series:'A',source_voucher_number:1}],latest:unknown=baseline,accounts:unknown[]=[]){
  const db=createQueuedMockSupabase()
  db.enqueueMany([{data:[{id:'period'}]},{data:baseline},{data:latest}])
  mocks.rows.mockResolvedValueOnce(existing).mockResolvedValueOnce(accounts)
  const rpc=vi.fn().mockResolvedValue({data:classified,error:null})
  return {...db,supabase:{...db.supabase,rpc} as never,rpc}
}
beforeEach(()=>{vi.clearAllMocks();mocks.rows.mockReset();mocks.prepare.mockResolvedValue({preparedEntries:[entry(0)],skippedDetails:[]});mocks.source.mockResolvedValue(source)})
describe('read-only incremental SIE plan',()=>{
  it('ignores a regenerated export timestamp and makes no mutation request',async()=>{
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}])
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(source.replace('20260101\n#RAR','20261107\n#RAR')),[])
    expect(plan).toMatchObject({added:0,unchanged:1,reviewCount:0,metadataChanged:false,newOrdinals:[]})
    expect(db.rpc).toHaveBeenCalledWith('classify_sie_resync_entries',expect.any(Object))
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.prepare.mock.calls[0][8]).toMatchObject({only:true})
  })
  it('adds only new ordinals while surfacing changes and removed references',async()=>{
    mocks.prepare.mockResolvedValue({preparedEntries:[entry(0),entry(1)],skippedDetails:[]})
    const parsed=parseSIEFile(source);parsed.vouchers.push({...parsed.vouchers[0],number:2})
    const db=setup([{source_ordinal:1,outcome:'new',entry_id:null},{source_ordinal:0,outcome:'changed',entry_id:'old'}],
      [{id:'old',source_voucher_series:'A',source_voucher_number:1},{id:'missing',source_voucher_series:'A',source_voucher_number:3}])
    const plan=await planSIEResync(db.supabase,'company','user',parsed,[])
    expect(plan).toMatchObject({added:1,unchanged:0,newOrdinals:[1],reviewCount:2})
    expect(plan?.reviews).toEqual([{sourceId:'A1',kind:'changed',entryId:'old'},{sourceId:'A3',kind:'removed',entryId:'missing'}])
  })
  it('refuses ambiguous repeated references even when no local voucher exists yet',async()=>{
    mocks.prepare.mockResolvedValue({preparedEntries:[entry(0,1),entry(1,1)],skippedDetails:[]})
    const db=setup([{source_ordinal:0,outcome:'new'},{source_ordinal:1,outcome:'new'}],[])
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(source),[])
    expect(plan).toMatchObject({added:0,reviewCount:2,newOrdinals:[]})
    expect(plan?.reviews.every(review=>review.kind==='ambiguous')).toBe(true)
  })
  it('reports a changed opening balance rather than applying it',async()=>{
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}])
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(source.replace('#IB 0 1930 0','#IB 0 1930 50')),[])
    expect(plan?.reviews).toContainEqual({sourceId:'IB',kind:'opening_balance'})
    expect(plan?.newOrdinals).toEqual([])
  })
  it('does not keep reporting the closing balance after a successful incremental run',async()=>{
    const current=source.replace('#UB 0 1930 100','#UB 0 1930 200')
    mocks.source.mockResolvedValueOnce(source).mockResolvedValueOnce(current)
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}],undefined,{...baseline,id:'latest'})
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(current),[])
    expect(plan).toMatchObject({added:0,unchanged:1,metadataChanged:false,reviewCount:0})
  })
  it('does not repeat a source account rename that another year already applied to the company chart',async()=>{
    const current=source.replace('#KONTO 3001 "Sales"','#KONTO 3001 "Current sales name"')
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}],undefined,baseline,
      [{id:'account',account_number:'3001',account_name:'Current sales name'}])
    const mappings=[{sourceAccount:'3001',sourceName:'Current sales name',targetAccount:'3001',targetName:'Current sales name',confidence:1,matchType:'exact' as const,isOverride:false}]
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(current),mappings)
    expect(plan).toMatchObject({added:0,unchanged:1,metadataChanged:false,reviewCount:0})
    // Both archives retain their source names; comparison is read-only.
    expect(mocks.source).toHaveBeenCalledTimes(1)
  })
  it('continues to report a source rename that the company chart does not have',async()=>{
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}],undefined,baseline,
      [{id:'account',account_number:'3001',account_name:'Sales'}])
    const mappings=[{sourceAccount:'3001',sourceName:'New name',targetAccount:'3001',targetName:'New name',confidence:1,matchType:'exact' as const,isOverride:false}]
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(source.replace('"Sales"','"New name"')),mappings)
    expect(plan).toMatchObject({added:0,metadataChanged:true})
  })
  it('does not hide SRU metadata changes when the source account name is already current',async()=>{
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}],undefined,baseline,
      [{id:'account',account_number:'3001',account_name:'Sales'}])
    const mappings=[{sourceAccount:'3001',sourceName:'Sales',targetAccount:'3001',targetName:'Sales',confidence:1,matchType:'exact' as const,isOverride:false}]
    const parsed=parseSIEFile(source);parsed.accounts.find(account=>account.number==='3001')!.sruCode='7310'
    expect(await planSIEResync(db.supabase,'company','user',parsed,mappings)).toMatchObject({metadataChanged:true})
  })
  it('does not treat a remapped target name as approval of the source account name',async()=>{
    const db=setup([{source_ordinal:0,outcome:'unchanged',entry_id:'old'}],undefined,baseline,
      [{id:'account',account_number:'3001',account_name:'New name'}])
    const mappings=[{sourceAccount:'3001',sourceName:'New name',targetAccount:'3002',targetName:'Other account',confidence:1,matchType:'manual' as const,isOverride:true}]
    expect(await planSIEResync(db.supabase,'company','user',parseSIEFile(source.replace('"Sales"','"New name"')),mappings))
      .toMatchObject({metadataChanged:true})
  })
  it('does not repeat an unchanged source record that the original import already skipped',async()=>{
    mocks.prepare.mockResolvedValue({preparedEntries:[],skippedDetails:[{voucherId:'A1',reason:'empty'}]})
    const db=setup([],[])
    expect(await planSIEResync(db.supabase,'company','user',parseSIEFile(source),[])).toMatchObject({added:0,unchanged:1,reviewCount:0})
  })
  it('does not append an old source voucher that lacked an original posting',async()=>{
    const db=setup([{source_ordinal:0,outcome:'new',entry_id:null}],[])
    const plan=await planSIEResync(db.supabase,'company','user',parseSIEFile(source.replace('Sale','Changed sale')),[])
    expect(plan).toMatchObject({added:0,reviewCount:1,newOrdinals:[]})
    expect(plan?.reviews).toEqual([{sourceId:'A1',kind:'changed'}])
  })
  it('fails closed if a comparison response omits any source entry',async()=>{
    const db=setup([])
    await expect(planSIEResync(db.supabase,'company','user',parseSIEFile(source),[])).rejects.toThrow('incomplete')
  })
})
