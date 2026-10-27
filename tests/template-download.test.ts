import test from 'node:test'
import assert from 'node:assert/strict'
import { openResumeTemplateDocument, resolveResumeTemplateUrl } from '../src/utils/downloadResumeTemplate.ts'

const template = { path: '/static/resume-templates/blue-azurill.docx', fileName: '现代留白.docx' }
type DocumentPlatform = Parameters<typeof openResumeTemplateDocument>[2]

test('a configured HTTPS website can serve each fixed template under a deployment subpath', () => {
  for (const name of ['classic-onyx', 'blue-azurill', 'navy-chikorita']) {
    const path = `/static/resume-templates/${name}.docx`
    assert.equal(resolveResumeTemplateUrl(path, 'https://resume.example.com/app/'), `https://resume.example.com/app${path}`)
  }
  assert.equal(resolveResumeTemplateUrl(template.path, 'https://resume.example.com'), `https://resume.example.com${template.path}`)
})

test('WeChat does not receive loopback, insecure, injected or unconfigured download URLs', () => {
  for (const base of [undefined, '', 'http://resume.example.com', 'https://127.0.0.1', 'https://localhost',
    'https://resume.local', 'https://user:secret@resume.example.com', 'https://resume.example.com?token=x',
    'https://resume.example.com/../app', 'https://resume.example.com/%2e%2e', 'https://resume.example.com:99999']) {
    assert.throws(() => resolveResumeTemplateUrl(template.path, base), /网页版/)
  }
  for (const path of ['https://outside.example.com/resume.docx', '/static/resume-templates/../secret.docx',
    `${template.path}?url=https://outside.example.com`, '/static/resume-templates/not-found.docx']) {
    assert.throws(() => resolveResumeTemplateUrl(path, 'https://resume.example.com'), /未找到/)
  }
})

test('opening a Word template waits for the document viewer and enables its save/share menu', async () => {
  let openOptions: Parameters<DocumentPlatform['openDocument']>[0] | undefined
  let completed = false
  const platform: DocumentPlatform = {
    downloadFile(options) {
      assert.equal(options.url, `https://resume.example.com${template.path}`)
      assert.equal(options.timeout, 20000)
      options.success({ statusCode: 200, tempFilePath: 'wxfile://downloaded.docx' })
    },
    openDocument(options) { openOptions = options },
  }
  const pending = openResumeTemplateDocument(template, 'https://resume.example.com', platform)
    .then(result => { completed = true; return result })
  await Promise.resolve()
  assert.equal(completed, false, 'download completion alone must not report that the Word document was opened')
  assert.equal(openOptions?.filePath, 'wxfile://downloaded.docx')
  assert.equal(openOptions?.fileType, 'docx')
  assert.equal(openOptions?.showMenu, true)
  openOptions!.success()
  assert.equal(await pending, 'document-opened')
})

test('failed and missing-file downloads never call the document viewer and offer a recovery path', async () => {
  for (const outcome of ['network', 'http', 'missing-file']) {
    let openCount = 0
    const platform: DocumentPlatform = {
      downloadFile(options) {
        if (outcome === 'network') options.fail()
        else options.success({ statusCode: outcome === 'http' ? 404 : 200, tempFilePath: outcome === 'missing-file' ? '' : 'wxfile://error' })
      },
      openDocument() { openCount++ },
    }
    await assert.rejects(openResumeTemplateDocument(template, 'https://resume.example.com', platform), /网页版/)
    assert.equal(openCount, 0)
  }
})

test('an unavailable viewer rejects without pretending the template was opened', async () => {
  for (const failure of ['callback', 'unsupported']) {
    const platform: DocumentPlatform = {
      downloadFile(options) { options.success({ statusCode: 200, tempFilePath: 'wxfile://document.docx' }) },
      openDocument(options) {
        if (failure === 'unsupported') throw new Error('unsupported API')
        options.fail()
      },
    }
    await assert.rejects(openResumeTemplateDocument(template, 'https://resume.example.com', platform), /网页版/)
  }
})

test('without an HTTPS source no WeChat network or document action is attempted', () => {
  const platform: DocumentPlatform = {
    downloadFile() { assert.fail('no unconfigured download should occur') },
    openDocument() { assert.fail('no document should be opened') },
  }
  assert.throws(() => openResumeTemplateDocument(template, undefined, platform), /网页版/)
})
