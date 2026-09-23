import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import dotenv from 'dotenv'

const env=dotenv.parse(readFileSync('.env.sie-runtime.local'))
if(env.NEXT_PUBLIC_SUPABASE_URL!=='https://metjnjrhvujscngnpzdv.supabase.co') throw new Error('Staging only')
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
let fixture
if(existsSync('.env.sie-ui.json')) fixture=JSON.parse(readFileSync('.env.sie-ui.json','utf8'))
else {
  const report=JSON.parse(readFileSync('.env.sie-acceptance.json','utf8'))
  const company=report.fixtures[1].company
  const {data:companyRow,error:companyError}=await admin.from('companies').select('id,name').eq('id',company).single()
  if(companyError || !companyRow.name.startsWith('SIE acceptance')) throw new Error('Synthetic company required')
  const email=`sie-browser-${randomUUID()}@test.invalid`,password=randomBytes(32).toString('hex')
  const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true})
  if(error) throw error
  fixture={company,user:data.user.id,email,password}
  writeFileSync('.env.sie-ui.json',JSON.stringify(fixture,null,2))
  for(const result of [
    await admin.from('company_members').insert({company_id:company,user_id:fixture.user,role:'owner'}),
    await admin.from('user_preferences').upsert({user_id:fixture.user,active_company_id:company,locale:'sv'},{onConflict:'user_id'}),
    await admin.from('company_settings').update({onboarding_complete:true,company_name:'SIE browser test AB'}).eq('company_id',company),
  ]) if(result.error) throw result.error
}
const cookies=[]
const client=createServerClient(env.NEXT_PUBLIC_SUPABASE_URL,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{
  cookies:{getAll:()=>[],setAll:values=>cookies.push(...values)},
})
const {error}=await client.auth.signInWithPassword({email:fixture.email,password:fixture.password})
if(error) throw error
writeFileSync('.env.sie-browser-state.json',JSON.stringify({cookies:cookies.map(cookie=>({
  name:cookie.name,value:cookie.value,domain:'localhost',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax',
})),origins:[]}))
console.log('Synthetic staging browser session prepared')
