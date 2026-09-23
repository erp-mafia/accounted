import { describe, expect, it } from 'vitest'
import { uploadedFileBaseName } from '@/lib/documents/upload-file-name'

describe('uploadedFileBaseName', () => {
  it('returns a bare filename unchanged', () => {
    expect(uploadedFileBaseName('A31_8c2db060.pdf')).toBe('A31_8c2db060.pdf')
  })

  it('strips the folder-relative path Chrome writes for a folder selection', () => {
    // Real shape from a Fortnox export: <year>/<month>/<type>/<file>.
    expect(
      uploadedFileBaseName(
        '2026/06/Leverantörsfakturor/A166_90493_62864442_Hetzner_2026-05-13_089000921156.pdf',
      ),
    ).toBe('A166_90493_62864442_Hetzner_2026-05-13_089000921156.pdf')
  })

  it('strips Windows-style separators too', () => {
    expect(uploadedFileBaseName('2026\\01\\Verifikationer\\A17_kvitto.pdf')).toBe('A17_kvitto.pdf')
  })

  it('keeps dots, spaces and Swedish characters inside the name', () => {
    expect(uploadedFileBaseName('2026/01/A17_Förhandsavi 2026 Årsavgift 734 314 922.pdf')).toBe(
      'A17_Förhandsavi 2026 Årsavgift 734 314 922.pdf',
    )
    expect(uploadedFileBaseName('A31.kvitto.v2.pdf')).toBe('A31.kvitto.v2.pdf')
  })
})
