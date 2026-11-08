import {describe,expect,it} from 'vitest'
import {buildVoucherIndex,type VoucherRow} from '@/lib/documents/voucher-ref-resolver'
import {explainUnmatchedDocument,pageUnmatchedDocuments,type UnmatchedProviderDocument} from '../document-match-review'
const period={id:'year',period_start:'2026-01-01',period_end:'2026-12-31',is_closed:false,locked_at:null}
const ref={series:'V',number:33,date:'2026-02-01'}
const voucher:VoucherRow={id:'active',fiscal_period_id:'year',entry_date:'2026-02-01',source_voucher_series:'V',source_voucher_number:33,status:'posted'}
describe('unmatched provider document explanations',()=>{
  it('distinguishes unavailable references, periods and vouchers',()=>{
    const index=buildVoucherIndex([])
    expect(explainUnmatchedDocument(index,[period],null).reason).toBe('missing_reference')
    expect(explainUnmatchedDocument(index,[],ref).reason).toBe('missing_period')
    expect(explainUnmatchedDocument(index,[],{...ref,dateTo:'2026-12-31'}).reason).toBe('missing_period')
    expect(explainUnmatchedDocument(index,[period],ref).reason).toBe('missing_voucher')
  })
  it('includes both the posted and reversed original behind an ambiguous source identity',()=>{
    const rows=[voucher,{...voucher,id:'original',status:'reversed',reversed_by_id:'storno'}]
    const result=explainUnmatchedDocument(buildVoucherIndex(rows),[period],ref)
    expect(result.reason).toBe('ambiguous')
    expect(result.candidates.map(row=>row.id)).toEqual(['active','original'])
    expect(explainUnmatchedDocument(buildVoucherIndex(rows),[period],{...ref,dateTo:'2026-12-31'}).reason).toBe('ambiguous')
  })
  it('distinguishes a different date in the right period from the reference in another year',()=>{
    expect(explainUnmatchedDocument(buildVoucherIndex([voucher]),[period],ref,true)).toMatchObject({reason:'date_mismatch',candidates:[voucher]})
    expect(explainUnmatchedDocument(buildVoucherIndex([{...voucher,fiscal_period_id:'previous',entry_date:'2025-02-01'}]),[period],ref).reason).toBe('other_period')
  })
  it('pages and searches the complete set of 495 rows in stable chronological order',()=>{
    const rows:UnmatchedProviderDocument[]=Array.from({length:495},(_,i)=>({uploadId:`upload-${String(i).padStart(3,'0')}`,fileName:`Receipt ${i}`,voucher:`V${i}`,date:i<250?'2025-01-01':'2026-01-01',dateTo:null,reason:'ambiguous' as const,candidateCount:2,candidates:[]})).reverse()
    const first=pageUnmatchedDocuments('bokio',rows,{offset:0,limit:25})
    const second=pageUnmatchedDocuments('bokio',rows,{offset:25,limit:25})
    expect(first).toMatchObject({total:495,filteredTotal:495,reasonCounts:{ambiguous:495}})
    expect(first.items[0].uploadId).toBe('upload-000')
    expect(new Set([...first.items,...second.items].map(row=>row.uploadId)).size).toBe(50)
    expect(pageUnmatchedDocuments('bokio',rows,{offset:0,limit:25,query:'v494'}).items.map(row=>row.uploadId)).toEqual(['upload-494'])
    expect(pageUnmatchedDocuments('bokio',rows,{offset:475,limit:25}).items).toHaveLength(20)
  })
})
