import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResumeExportFile } from '../shared/types.ts'
import {
  assertExportFile, base64ToBytes, openResumeExportFile, resolveExportFileName, type ExportDocumentPlatform,
} from '../src/utils/saveExportFile.ts'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDF_MIME = 'application/pdf'
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

function exportFile(overrides: Partial<ResumeExportFile> = {}): ResumeExportFile {
  return {
    revision: 3, format: 'docx', template: 'minimal', resumeId: 'resume-1', fileName: '我的简历.docx',
    mimeType: DOCX_MIME, contentBase64: Buffer.from(DOCX_BYTES).toString('base64'), ...overrides,
  }
}

test('decodes base64 into bytes without platform globals and rejects corrupt payloads', () => {
  assert.equal(new TextDecoder().decode(base64ToBytes('SGVsbG8=')), 'Hello')
  assert.deepEqual([...base64ToBytes('AAEC')], [0, 1, 2])
  assert.deepEqual([...base64ToBytes('SGVs\nbG8=')], [...new TextEncoder().encode('Hello')])
  assert.deepEqual([...base64ToBytes('')].length, 0)
  for (const invalid of ['SGVsbG8', 'SGVs!G8=', 'SGV=sbG8=', '====']) {
    assert.throws(() => base64ToBytes(invalid), /导出文件内容无效/)
  }
})

test('resolves a safe file name with the extension matching the requested format', () => {
  assert.equal(resolveExportFileName(exportFile()), '我的简历.docx')
  assert.equal(resolveExportFileName(exportFile({ format: 'pdf', fileName: '最终版.pdf', mimeType: PDF_MIME })), '最终版.pdf')
  assert.equal(resolveExportFileName(exportFile({ fileName: 'a/b\\c:d*e?f"g<h>i|j.docx' })), 'a_b_c_d_e_f_g_h_i_j.docx')
  assert.equal(resolveExportFileName(exportFile({ fileName: '简历.txt' })), '简历.txt.docx')
  assert.equal(resolveExportFileName(exportFile({ fileName: '   ' })), '我的简历.docx')
})

test('rejects mismatched MIME types and content that is not the requested document', () => {
  assert.doesNotThrow(() => assertExportFile(exportFile()))
  assert.doesNotThrow(() => assertExportFile(exportFile({ format: 'pdf', mimeType: PDF_MIME, contentBase64: Buffer.from(PDF_BYTES).toString('base64') })))
  assert.throws(() => assertExportFile(exportFile({ mimeType: PDF_MIME })), /导出文件内容无效/)
  assert.throws(() => assertExportFile(exportFile({ format: 'pdf', mimeType: PDF_MIME })), /导出文件内容无效/)
  assert.throws(() => assertExportFile(exportFile({ format: 'pdf', mimeType: PDF_MIME, contentBase64: Buffer.from(DOCX_BYTES).toString('base64') })), /导出文件内容无效/)
  assert.throws(() => assertExportFile(exportFile({ contentBase64: Buffer.from('<html>').toString('base64') })), /导出文件内容无效/)
})

function platform(options: { writeFails?: boolean; openFails?: boolean; openThrows?: boolean; deferredOpen?: boolean } = {}) {
  const writes: { filePath: string; data: string; encoding: string }[] = []
  const opens: { filePath: string; fileType: string; showMenu: boolean }[] = []
  let pendingOpen: (() => void) | undefined
  const fake: ExportDocumentPlatform = {
    env: { USER_DATA_PATH: '/tmp/wechat-user' },
    getFileSystemManager: () => ({
      writeFile(request) {
        writes.push({ filePath: request.filePath, data: request.data, encoding: request.encoding })
        if (options.writeFails) request.fail({ errMsg: 'no space' })
        else request.success()
      },
    }),
    openDocument(request) {
      opens.push({ filePath: request.filePath, fileType: request.fileType, showMenu: request.showMenu })
      if (options.openThrows) throw new Error('no viewer')
      else if (options.openFails) request.fail({ errMsg: 'viewer failed' })
      else if (options.deferredOpen) pendingOpen = request.success
      else request.success()
    },
  }
  return {
    fake, writes, opens,
    completeOpen() {
      const complete = pendingOpen
      if (!complete) throw new Error('the document viewer was never asked to open the file')
      pendingOpen = undefined
      complete()
    },
  }
}

test('writes the generated file into the mini program user directory before opening it', async () => {
  const file = exportFile()
  const { fake, writes, opens } = platform()
  assert.equal(await openResumeExportFile(file, fake), 'file-opened')
  assert.deepEqual(writes, [{ filePath: '/tmp/wechat-user/我的简历.docx', data: file.contentBase64, encoding: 'base64' }])
  assert.deepEqual(opens, [{ filePath: '/tmp/wechat-user/我的简历.docx', fileType: 'docx', showMenu: true }])
  const pdf = exportFile({ format: 'pdf', mimeType: PDF_MIME, fileName: '我的简历.pdf', contentBase64: Buffer.from(PDF_BYTES).toString('base64') })
  const pdfPlatform = platform()
  await openResumeExportFile(pdf, pdfPlatform.fake)
  assert.equal(pdfPlatform.opens[0]?.fileType, 'pdf')
  assert.equal(pdfPlatform.writes[0]?.filePath, '/tmp/wechat-user/我的简历.pdf')
})

test('resolves only after the document viewer actually opens the saved file', async () => {
  const { fake, completeOpen } = platform({ deferredOpen: true })
  let settled = false
  const pending = openResumeExportFile(exportFile(), fake).then(() => { settled = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'saving the file is not enough; the viewer must open it')
  completeOpen()
  await pending
  assert.equal(settled, true)
})

test('fails honestly when writing or opening the exported file fails', async () => {
  const writeFailure = platform({ writeFails: true })
  await assert.rejects(() => openResumeExportFile(exportFile(), writeFailure.fake), /简历文件保存失败/)
  assert.deepEqual(writeFailure.opens, [])
  await assert.rejects(() => openResumeExportFile(exportFile(), platform({ openFails: true }).fake), /无法打开/)
  await assert.rejects(() => openResumeExportFile(exportFile(), platform({ openThrows: true }).fake), /无法打开/)
})

test('never writes an invalid payload to the device', async () => {
  const { fake, writes } = platform()
  await assert.rejects(() => openResumeExportFile(exportFile({ contentBase64: Buffer.from('<html>').toString('base64') }), fake), /导出文件内容无效/)
  assert.deepEqual(writes, [])
})
