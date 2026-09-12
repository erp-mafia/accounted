import type { SupabaseClient } from '@supabase/supabase-js'
import { SIE_LIMITS } from './sie-job-contract'
import { SIEJobValidationError } from './sie-jobs'

export async function readSIEIntakeFile(supabase:SupabaseClient,companyId:string,path:string,filename:string):Promise<File> {
  const prefix = `${companyId}/sie-intake/`
  if (!path.startsWith(prefix) || !/^[a-f0-9-]{36}\.se$/.test(path.slice(prefix.length)) ||
    !/\.(se|sie|si)$/i.test(filename) || filename.length > 255) {
    throw new SIEJobValidationError('Importens uppladdningslänk eller filnamn är ogiltigt.')
  }
  const {data,error} = await supabase.storage.from('sie-files').download(path)
  if (error || !data) throw new SIEJobValidationError('Den uppladdade SIE-filen hittades inte.')
  if (!data.size || data.size > SIE_LIMITS.fileBytes) throw new SIEJobValidationError('SIE-filen måste vara mellan 1 byte och 50 MB.')
  return new File([data],filename,{type:'application/octet-stream'})
}

export async function readSIERequestFile(form:FormData,supabase:SupabaseClient,companyId:string):Promise<File|null> {
  if (typeof form.get('storagePath') === 'string') return readSIEIntakeFile(supabase,companyId,
    String(form.get('storagePath')),String(form.get('filename')))
  const file = form.get('file')
  return file instanceof File ? file : null
}
