import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resumeTemplates } from '../src/data/resumeTemplates';

test('public template catalogue resolves to actual Word files and full page preview images', async () => {
  const ids = new Set<string>();
  for (const template of resumeTemplates) {
    assert.equal(ids.has(template.id), false, 'template ids must be unique');
    ids.add(template.id);
    assert.match(template.fileName, /^[^/\\]+\.docx$/);
    for (const [url, extension] of [[template.downloadUrl, 'docx'], [template.previewUrl, 'png']] as const) {
      assert.match(url, new RegExp(`^/static/resume-templates/[a-z-]+\\.${extension}$`));
      const file = fileURLToPath(new URL(`../src${url}`, import.meta.url));
      const bytes = await readFile(file);
      if (extension === 'docx') {
        assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304', 'Word download must be a ZIP document');
      } else {
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        assert.ok(width >= 700 && height >= 990, 'preview should retain readable page resolution');
        assert.ok(Math.abs(width / height - 210 / 297) < 0.01, 'preview should retain the A4 page ratio');
      }
    }
  }
});
