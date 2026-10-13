import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/*
 * The import steps take their file through the one FileDropzone: drag tint,
 * click, Enter or Space, and the picker reset. A step with its own onDrop or
 * a page-global file input id is the copy coming back; two of those copies
 * put the picker behind a label a keyboard could not reach.
 */
const root = path.resolve(__dirname, '../../../')

describe('import steps on the shared dropzone', () => {
  it.each([
    'components/import/SIEUploadStep.tsx',
    'components/import/BankFileUploadStep.tsx',
    'components/import/SkattekontoFileUploadStep.tsx',
    'components/import/OpeningBalanceUploadStep.tsx',
    'components/import/RegisterUploadStep.tsx',
  ])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(src).toContain('<FileDropzone')
    expect(src).not.toContain('onDrop=')
    expect(src).not.toContain('document.getElementById(')
    expect(src).not.toContain('type="file"')
  })

  it('the SIE step leaves the accept attribute off (Safari greys out .sie files)', () => {
    const src = fs.readFileSync(path.join(root, 'components/import/SIEUploadStep.tsx'), 'utf8')
    const zone = src.slice(src.indexOf('<FileDropzone'), src.indexOf('>', src.indexOf('<FileDropzone')))
    expect(zone).not.toContain('accept=')
  })
})

describe('the logo upload on the shared dropzone', () => {
  it('takes the logo through FileDropzone, empty or filled', () => {
    const src = fs.readFileSync(path.join(root, 'components/settings/LogoUpload.tsx'), 'utf8')
    expect(src.match(/<FileDropzone/g)).toHaveLength(2)
    expect(src).not.toContain('onDrop=')
    expect(src).not.toContain('type="file"')
  })
})
