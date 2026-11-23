import { describe, it, expect, vi } from 'vitest'
import {
  documentStoragePathCandidates,
  downloadCompanyFolderObject,
  downloadDocumentObject,
  isCompanyFolderDocumentKey,
  isDocumentKeyOfCompany,
  isPlainStorageKey,
  legacySourceOfDocumentKey,
  signDocumentObject,
} from '../storage-key'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const OTHER_USER = '44444444-4444-4444-8444-444444444444'

const scoped = `documents/${COMPANY}/${USER}/1767000000000_kvitto.pdf`
const legacy = `documents/${USER}/1767000000000_kvitto.pdf`
const otherCompany = `documents/${OTHER}/${OTHER_USER}/1767000000000_faktura.pdf`

function storageClient(answer: (path: string) => { data: unknown; error: unknown } = () => ({ data: new Blob(['%PDF']), error: null })) {
  const download = vi.fn(async (path: string) => answer(path))
  const createSignedUrl = vi.fn(async (path: string) => ({ data: { signedUrl: `https://storage.test/${path}` }, error: null }))
  const from = vi.fn(() => ({ download, createSignedUrl }))
  return { client: { storage: { from } } as never, from, download, createSignedUrl }
}

describe('isDocumentKeyOfCompany', () => {
  it('follows a key in the company folder, at any depth', () => {
    expect(isDocumentKeyOfCompany(scoped, COMPANY)).toBe(true)
    expect(isDocumentKeyOfCompany(`documents/${COMPANY}/arrivals/a1/mail.eml`, COMPANY)).toBe(true)
    expect(isDocumentKeyOfCompany(`documents/${COMPANY}/1767000000000_kvitto.pdf`, COMPANY)).toBe(true)
  })

  it('follows a legacy uploader key one folder deep', () => {
    expect(isDocumentKeyOfCompany(legacy, COMPANY)).toBe(true)
  })

  it('does not follow a key in another company folder', () => {
    expect(isDocumentKeyOfCompany(otherCompany, COMPANY)).toBe(false)
    // The company's id one folder down does not make another company's folder its own.
    expect(isDocumentKeyOfCompany(`documents/${OTHER}/${COMPANY}/1767000000000_faktura.pdf`, COMPANY)).toBe(false)
  })

  it('does not follow a key outside the documents/ root or without a company', () => {
    expect(isDocumentKeyOfCompany(`${USER}/${COMPANY}/inbox/kvitto.pdf`, COMPANY)).toBe(false)
    expect(isDocumentKeyOfCompany(`previews/${COMPANY}/doc-v1.jpg`, COMPANY)).toBe(false)
    expect(isDocumentKeyOfCompany(`documents/${COMPANY}`, COMPANY)).toBe(false)
    expect(isDocumentKeyOfCompany(scoped, null)).toBe(false)
    expect(isDocumentKeyOfCompany(null, COMPANY)).toBe(false)
    expect(isDocumentKeyOfCompany('', COMPANY)).toBe(false)
  })

  it('does not follow a key with an empty, "." or ".." part or a character a URL reads differently', () => {
    for (const key of [
      `documents/${COMPANY}/../${OTHER}/${OTHER_USER}/1767000000000_faktura.pdf`,
      `documents/${COMPANY}/./1767000000000_kvitto.pdf`,
      `documents/${COMPANY}//1767000000000_kvitto.pdf`,
      `documents/${COMPANY}/`,
      `/documents/${COMPANY}/1767000000000_kvitto.pdf`,
      `documents/${COMPANY}/%2e%2e/${OTHER}/1767000000000_faktura.pdf`,
      `documents/${COMPANY}/..\\${OTHER}/1767000000000_faktura.pdf`,
      `documents/${COMPANY}/kvitto.pdf?download=1`,
      `documents/${COMPANY}/kvitto.pdf#x`,
      `documents/${COMPANY}/.\n./${OTHER}/1767000000000_faktura.pdf`,
      `documents/../${OTHER}/1767000000000_faktura.pdf`,
    ]) {
      expect(isDocumentKeyOfCompany(key, COMPANY), key).toBe(false)
    }
  })
})

describe('company ids written in capitals', () => {
  const UPPER = COMPANY.toUpperCase()

  it('reads a company id in either case as the same company', () => {
    expect(isDocumentKeyOfCompany(scoped, UPPER)).toBe(true)
    expect(isDocumentKeyOfCompany(`documents/${UPPER}/${USER}/1767000000000_kvitto.pdf`, COMPANY)).toBe(true)
    expect(isCompanyFolderDocumentKey(scoped, UPPER)).toBe(true)
    expect(documentStoragePathCandidates(scoped, UPPER)).toEqual([scoped])
  })

  it('derives the company-scoped copy of a legacy key in lower case, as uploads write it', () => {
    expect(documentStoragePathCandidates(legacy, UPPER)).toEqual([legacy, scoped])
  })
})

describe('isPlainStorageKey', () => {
  it('takes a key as uploads write it, in any bucket', () => {
    expect(isPlainStorageKey(scoped)).toBe(true)
    expect(isPlainStorageKey(`${COMPANY}/sie-originals/${'a'.repeat(64)}.se`)).toBe(true)
    expect(isPlainStorageKey('documents/user-1/kvitto mars, 2026.pdf')).toBe(true)
  })

  it('refuses a key with an empty, "." or ".." part or a character a URL reads differently', () => {
    for (const key of [`${COMPANY}/../../documents/${OTHER}/x.pdf`, `${COMPANY}/./x.se`, `${COMPANY}//x.se`, `/${COMPANY}/x.se`, `${COMPANY}/x.se?a`, `${COMPANY}/x.se#a`, `${COMPANY}/%2e%2e/x.se`, `${COMPANY}\\x.se`, '', null]) {
      expect(isPlainStorageKey(key), String(key)).toBe(false)
    }
  })
})

describe('legacySourceOfDocumentKey', () => {
  it('gives the legacy key a repointed row was copied from: the row user\'s own folder, one level', () => {
    expect(legacySourceOfDocumentKey(scoped, COMPANY, USER)).toBe(legacy)
  })

  it('gives nothing for any other key', () => {
    expect(legacySourceOfDocumentKey(scoped, COMPANY, OTHER_USER)).toBeNull()
    expect(legacySourceOfDocumentKey(legacy, COMPANY, USER)).toBeNull()
    expect(legacySourceOfDocumentKey(otherCompany, COMPANY, OTHER_USER)).toBeNull()
    expect(legacySourceOfDocumentKey(`documents/${COMPANY}/${USER}/inbox/1_kvitto.pdf`, COMPANY, USER)).toBeNull()
    expect(legacySourceOfDocumentKey(scoped, COMPANY, null)).toBeNull()
  })
})

describe('isCompanyFolderDocumentKey', () => {
  it('takes the company folder only, never a legacy key', () => {
    expect(isCompanyFolderDocumentKey(scoped, COMPANY)).toBe(true)
    expect(isCompanyFolderDocumentKey(legacy, COMPANY)).toBe(false)
    expect(isCompanyFolderDocumentKey(otherCompany, COMPANY)).toBe(false)
    expect(isCompanyFolderDocumentKey(`documents/${COMPANY}/../${OTHER}/x.pdf`, COMPANY)).toBe(false)
  })
})

describe('documentStoragePathCandidates', () => {
  it('lists the stored pointer first, then the company-scoped copy of a legacy key', () => {
    expect(documentStoragePathCandidates(legacy, COMPANY)).toEqual([legacy, `documents/${COMPANY}/${USER}/1767000000000_kvitto.pdf`])
  })

  it('offers no other key for a company-scoped pointer', () => {
    expect(documentStoragePathCandidates(scoped, COMPANY)).toEqual([scoped])
  })

  it('offers only the stored key for a key in the company folder, however deep', () => {
    const nested = `documents/${COMPANY}/${OTHER}/${OTHER_USER}/1767000000000_faktura.pdf`
    expect(documentStoragePathCandidates(nested, COMPANY)).toEqual([nested])
  })

  it('offers nothing for a key outside the company, or without a company', () => {
    expect(documentStoragePathCandidates(otherCompany, COMPANY)).toEqual([])
    expect(documentStoragePathCandidates(`${USER}/audit-packages/1_archive.zip`, COMPANY)).toEqual([])
    expect(documentStoragePathCandidates(legacy, null)).toEqual([])
  })
})

describe('downloadDocumentObject', () => {
  it('falls back to the company-scoped copy of a legacy key', async () => {
    const copy = `documents/${COMPANY}/${USER}/1767000000000_kvitto.pdf`
    const { client, download } = storageClient((path) =>
      path === copy ? { data: new Blob(['ok']), error: null } : { data: null, error: { message: 'Object not found' } },
    )
    const result = await downloadDocumentObject(client, legacy, COMPANY)
    expect(result.resolvedPath).toBe(copy)
    expect(download.mock.calls.map((call) => call[0])).toEqual([legacy, copy])
  })

  it('reads nothing for a key outside the company and answers 403', async () => {
    const { client, from, download } = storageClient()
    const result = await downloadDocumentObject(client, otherCompany, COMPANY)
    expect(from).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(result.blob).toBeNull()
    expect(result.error).toMatchObject({ status: 403 })
    expect(result.errors).toHaveLength(1)
  })
})

describe('downloadCompanyFolderObject', () => {
  it('reads a key in the company folder of the documents bucket', async () => {
    const { client, from, download } = storageClient()
    const key = `documents/${COMPANY}/reconciliation/manual_2350/2026-12-31/x.pdf`
    const result = await downloadCompanyFolderObject(client, 'documents', key, COMPANY)
    expect(result.blob).not.toBeNull()
    expect(from).toHaveBeenCalledWith('documents')
    expect(download).toHaveBeenCalledWith(key)
  })

  it.each([
    ['another bucket', 'sie-files', scoped],
    ['a legacy key', 'documents', legacy],
    ['another company folder', 'documents', otherCompany],
  ])('reads nothing for %s', async (_case, bucket, key) => {
    const { client, from } = storageClient()
    const result = await downloadCompanyFolderObject(client, bucket, key, COMPANY)
    expect(result.blob).toBeNull()
    expect(result.error).toMatchObject({ status: 403 })
    expect(from).not.toHaveBeenCalled()
  })
})

describe('signDocumentObject', () => {
  it('signs a key inside the company', async () => {
    const { client, createSignedUrl } = storageClient()
    const { data, error } = await signDocumentObject(client, scoped, COMPANY, 300)
    expect(error).toBeNull()
    expect(data?.signedUrl).toContain(scoped)
    expect(createSignedUrl).toHaveBeenCalledWith(scoped, 300)
  })

  it('signs nothing for a key outside the company', async () => {
    const { client, createSignedUrl } = storageClient()
    const { data, error } = await signDocumentObject(client, otherCompany, COMPANY, 300)
    expect(data).toBeNull()
    expect(error).toMatchObject({ status: 403 })
    expect(createSignedUrl).not.toHaveBeenCalled()
  })
})
