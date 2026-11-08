import {it,expect} from 'vitest'
import {streamDocumentImport} from '../document-import-progress'
import type {ImportDocumentsResult} from '../import-documents'
const result={provider:'bokio',scanned:1,total:2,linked:1,skipped:0,failed:0,unmatched:0,locked:0,lockedPeriods:[],unmatchedSamples:[],dryRun:false,partial:false,nextCursor:null} as ImportDocumentsResult
it('streams progress before completion and emits a canonical error on failure',async()=>{
  let finish!:()=>void
  const wait=new Promise<void>(resolve=>{finish=resolve})
  const response=streamDocumentImport(async publish=>{publish(result);await wait;throw new Error('test')},()=>Response.json({error:{code:'PROVIDER_AUTH_EXPIRED'}}))
  expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  const reader=response.body!.getReader();const first=await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('"type":"progress"')
  finish();const last=await reader.read();expect(new TextDecoder().decode(last.value)).toContain('PROVIDER_AUTH_EXPIRED')
  expect((await reader.read()).done).toBe(true)
})
it('reports a completed slice without changing its resume cursor',async()=>{
  const response=streamDocumentImport(async()=>({...result,partial:true,nextCursor:'upload-10'}),()=>Response.json({}))
  expect(await response.text()).toContain('"nextCursor":"upload-10"')
})
