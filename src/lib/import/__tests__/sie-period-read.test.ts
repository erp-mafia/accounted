import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'
import { readSIEUndoLockRefusal,withSIEPeriodRead,withSIEExternalReport } from '../sie-period-read'

// crm#1022: the stage-time and dry-run lock answer is the database's own.
describe('SIE undo lock answer', () => {
  const sentence = 'Räkenskapsåret 2024 (2024-01-01 till 2024-12-31) är låst. Lås upp det under Inställningar > Bokföring > Räkenskapsår först och försök igen.'
  it('asks sie_undo_lock_refusal for the company and import and returns its sentence', async () => {
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValue({data:sentence,error:null})
    expect(await readSIEUndoLockRefusal(supabase as unknown as SupabaseClient,'company','import')).toBe(sentence)
    expect(supabase.rpc).toHaveBeenCalledWith('sie_undo_lock_refusal',{p_company_id:'company',p_import_id:'import'})
  })
  it('answers null when nothing is locked', async () => {
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValue({data:null,error:null})
    expect(await readSIEUndoLockRefusal(supabase as unknown as SupabaseClient,'company','import')).toBeNull()
  })
  it('throws a failed read with its code instead of answering "not locked"', async () => {
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValue({data:null,error:{code:'57014',message:'statement timeout'}})
    await expect(readSIEUndoLockRefusal(supabase as unknown as SupabaseClient,'company','import'))
      .rejects.toMatchObject({code:'57014',message:'statement timeout'})
  })
})

describe('SIE export snapshot lease', () => {
  it.each(['reports.balance-sheet.pdf','reports.income-statement','gnubok_get_balance_sheet','gnubok_get_trial_balance','gnubok_vat_declaration_validate','measures.get','measures.explain','gnubok_get_measure','gnubok_explain_measure','unexplained.list','unexplained.explain','gnubok_list_unexplained','gnubok_get_unexplained'])('%s refuses an incomplete external report',async(operation)=>{
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValue({data:null,error:{code:'55000',message:'SIE_IMPORT_HOLD'}})
    const read=vi.fn()
    await expect(withSIEExternalReport(supabase as unknown as SupabaseClient,'company',operation,read)).rejects.toMatchObject({code:'CONFLICT'})
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['gnubok_sie_import_status','gnubok_list_accounts','imports.sie.create','measures.list','gnubok_list_measures'])('keeps %s available for recovery',async(operation)=>{
    const {supabase}=createMockSupabase(),read=vi.fn().mockResolvedValue('available')
    expect(await withSIEExternalReport(supabase as unknown as SupabaseClient,'company',operation,read)).toBe('available')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
  it('does not build a filing while an import hold exists', async () => {
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValue({data:null,error:{message:'SIE_IMPORT_HOLD'}})
    const read=vi.fn()
    await expect(withSIEPeriodRead(supabase as unknown as SupabaseClient,'company','vat_submission',read)).rejects.toThrow('SIE_IMPORT_HOLD')
    expect(read).not.toHaveBeenCalled()
  })
  it('releases a valid lease before returning the completed snapshot', async () => {
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValueOnce({data:'lease',error:null}).mockResolvedValueOnce({data:null,error:null})
    await expect(withSIEPeriodRead(supabase as unknown as SupabaseClient,'company','sie_export',async()=>'complete')).resolves.toBe('complete')
    expect(supabase.rpc).toHaveBeenLastCalledWith('finish_sie_period_read',{p_company_id:'company',p_token:'lease',p_require_valid:true})
  })
  it('discards an expired snapshot and releases its lease', async () => {
    const {supabase}=createMockSupabase()
    supabase.rpc.mockResolvedValueOnce({data:'lease',error:null})
      .mockResolvedValueOnce({data:null,error:{message:'snapshot expired'}}).mockResolvedValueOnce({data:null,error:null})
    await expect(withSIEPeriodRead(supabase as unknown as SupabaseClient,'company','sie_export',async()=>'partial')).rejects.toThrow('snapshot expired')
    expect(supabase.rpc).toHaveBeenLastCalledWith('finish_sie_period_read',{p_company_id:'company',p_token:'lease',p_require_valid:false})
  })
})
