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
    for (const [url, extension] of [[template.downloadUrl, 'docx'], [template.previewUrl, 'jpg']] as const) {
      assert.match(url, new RegExp(`^/static/resume-templates/[a-z-]+\\.${extension}$`));
      const file = fileURLToPath(new URL(`../src${url}`, import.meta.url));
      const bytes = await readFile(file);
      if (extension === 'docx') {
        assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304', 'Word download must be a ZIP document');
      } else {
        assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', 'preview must be a JPEG image');
        const { width, height } = jpegDimensions(bytes);
        assert.ok(width >= 350 && height >= 500, 'preview should retain readable page resolution');
        assert.ok(Math.abs(width / height - 210 / 297) < 0.01, 'preview should retain the A4 page ratio');
        assert.ok(bytes.byteLength <= 200 * 1024, 'preview must stay under the 200KB mini program asset limit');
      }
    }
  }
});


function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = bytes.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error('JPEG dimensions not found');
}
