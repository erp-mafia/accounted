import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../dropbox-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dropbox-client')>()
  return { ...actual, uploadDropboxFile: vi.fn() }
})

import { dropboxProvider } from '../dropbox-provider'
import { uploadDropboxFile } from '../dropbox-client'
import type { CloudConnection } from '../../types'

const mockUpload = vi.mocked(uploadDropboxFile)

function makeConnection(overrides: Partial<CloudConnection> = {}): CloudConnection {
  return {
    refresh_token_encrypted: 'enc',
    account_email: 'user@example.com',
    connected_at: '2026-01-01T00:00:00.000Z',
    root_folder_id: null,
    company_folder_id: null,
    ...overrides,
  }
}

const ORIGINAL_APP_FOLDER = process.env.DROPBOX_APP_FOLDER_NAME

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.DROPBOX_APP_FOLDER_NAME
})

afterEach(() => {
  if (ORIGINAL_APP_FOLDER === undefined) delete process.env.DROPBOX_APP_FOLDER_NAME
  else process.env.DROPBOX_APP_FOLDER_NAME = ORIGINAL_APP_FOLDER
})

describe('dropboxProvider storage keys', () => {
  it('owns keys distinct from Google Drive so the two never collide', () => {
    expect(dropboxProvider.keys).toEqual({
      connection: 'dropbox_connection',
      lastSync: 'dropbox_last_sync',
      schedule: 'dropbox_schedule',
    })
  })

  it('uses its own OAuth callback path', () => {
    expect(dropboxProvider.callbackPath).toBe('/oauth/dropbox/callback')
  })
})

describe('dropboxProvider.prepareTarget', () => {
  it('derives the company folder path without calling Dropbox', async () => {
    const { target, connectionPatch } = await dropboxProvider.prepareTarget({
      accessToken: 'token',
      connection: makeConnection(),
      companyLabel: 'Testbolag AB (556000-0000)',
    })

    expect(target.folderId).toBe('/Testbolag AB (556000-0000)')
    expect(connectionPatch).toEqual({
      company_folder_path: '/Testbolag AB (556000-0000)',
    })
  })

  it('reports no change when the stored path already matches', async () => {
    const { connectionPatch } = await dropboxProvider.prepareTarget({
      accessToken: 'token',
      connection: makeConnection({ company_folder_path: '/Testbolag AB (556000-0000)' }),
      companyLabel: 'Testbolag AB (556000-0000)',
    })

    expect(connectionPatch).toBeNull()
  })

  it('sanitises a company name that would produce an invalid path', async () => {
    const { target } = await dropboxProvider.prepareTarget({
      accessToken: 'token',
      connection: makeConnection(),
      companyLabel: 'Bolaget AB / Filial (556000-0000)',
    })

    // A single leading slash: the label must not be able to add path segments.
    expect(target.folderId).toBe('/Bolaget AB - Filial (556000-0000)')
    expect(target.folderId.slice(1)).not.toContain('/')
  })

  it('links to the Apps root when the app folder name is unknown', async () => {
    const { target } = await dropboxProvider.prepareTarget({
      accessToken: 'token',
      connection: makeConnection(),
      companyLabel: 'Testbolag AB',
    })

    expect(target.webViewLink).toBe('https://www.dropbox.com/home/Apps')
  })

  it('deep-links into the company folder when the app folder name is configured', async () => {
    process.env.DROPBOX_APP_FOLDER_NAME = 'Accounted'

    const { target } = await dropboxProvider.prepareTarget({
      accessToken: 'token',
      connection: makeConnection(),
      companyLabel: 'Testbolag AB',
    })

    expect(target.webViewLink).toBe(
      'https://www.dropbox.com/home/Apps/Accounted/Testbolag%20AB'
    )
  })
})

describe('dropboxProvider.putFile', () => {
  it('writes under the company folder and returns the path as the handle', async () => {
    mockUpload.mockResolvedValue({
      path: '/Testbolag AB/Arkiv 2024.zip',
      name: 'Arkiv 2024.zip',
      size_bytes: 42,
    })

    const result = await dropboxProvider.putFile({
      accessToken: 'token',
      target: {
        folderId: '/Testbolag AB',
        webViewLink: 'https://www.dropbox.com/home/Apps',
      },
      name: 'Arkiv 2024.zip',
      data: new ArrayBuffer(42),
      contentType: 'application/zip',
    })

    expect(mockUpload).toHaveBeenCalledWith(
      'token',
      '/Testbolag AB/Arkiv 2024.zip',
      expect.any(ArrayBuffer)
    )
    expect(result).toEqual({
      id: '/Testbolag AB/Arkiv 2024.zip',
      name: 'Arkiv 2024.zip',
      size_bytes: 42,
    })
  })

  it('overwrites by path and ignores the previous handle', async () => {
    mockUpload.mockResolvedValue({
      path: '/Bolag/Grunddata.zip',
      name: 'Grunddata.zip',
      size_bytes: 8,
    })

    await dropboxProvider.putFile({
      accessToken: 'token',
      target: { folderId: '/Bolag', webViewLink: 'https://www.dropbox.com/home/Apps' },
      name: 'Grunddata.zip',
      previousId: '/somewhere/else/Grunddata.zip',
      data: new ArrayBuffer(8),
      contentType: 'application/zip',
    })

    expect(mockUpload.mock.calls[0][1]).toBe('/Bolag/Grunddata.zip')
  })

  it('keeps Swedish file names intact: the header encoder handles them', async () => {
    mockUpload.mockResolvedValue({
      path: '/Bolag/LÄSMIG.txt',
      name: 'LÄSMIG.txt',
      size_bytes: 11,
    })

    await dropboxProvider.putFile({
      accessToken: 'token',
      target: { folderId: '/Bolag', webViewLink: 'https://www.dropbox.com/home/Apps' },
      name: 'LÄSMIG.txt',
      data: new ArrayBuffer(11),
      contentType: 'text/plain',
    })

    expect(mockUpload.mock.calls[0][1]).toBe('/Bolag/LÄSMIG.txt')
  })
})
