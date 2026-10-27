import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import type { Resume, ResumeExportFormat, ResumeExportTemplate } from '../shared/types.js';
import { parseResumeText, getResumeLayoutColumns } from '../shared/resume-layout.js';

const fontPath = fileURLToPath(new URL('./assets/fonts/SourceHanSansCN-Regular.otf', import.meta.url));
const colors = { minimal: '202326', modern: '285C78', business: '163853' };
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
interface Block { text: string; kind: 'name' | 'heading' | 'body' }
function blocks(resume: Resume, template: ResumeExportTemplate) {
  const parsed = parseResumeText(resume.text, resume.title);
  const columns = getResumeLayoutColumns(parsed.sections, template);
  const sections = (values: typeof columns.main): Block[] => values.flatMap(section => [
    ...(section.title ? [{ text: section.title, kind: 'heading' as const }] : []),
    ...section.body.split('\n').map(text => ({ text, kind: 'body' as const })),
  ]);
  return { main: [...(parsed.name ? [{ text: parsed.name, kind: 'name' as const }] : []), ...sections(columns.main)], sidebar: sections(columns.sidebar) };
}

async function word(resume: Resume, template: ResumeExportTemplate): Promise<Buffer> {
  const columns = blocks(resume, template);
  const paragraph = (block: Block, sidebar = false) => {
    const size = block.kind === 'name' ? 40 : block.kind === 'heading' ? 25 : sidebar ? 21 : 22;
    const color = sidebar && template === 'business' ? 'FFFFFF' : block.kind === 'body' ? '30343A' : colors[template];
    return `<w:p><w:pPr><w:spacing w:before="${block.kind === 'heading' ? 200 : 0}" w:after="80" w:line="320" w:lineRule="auto"/>${block.kind !== 'body' ? '<w:keepNext/>' : ''}${block.kind === 'name' && template === 'minimal' ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/>${block.kind !== 'body' ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(block.text)}</w:t></w:r></w:p>`;
  };
  const main = columns.main.map(block => paragraph(block)).join('');
  const sidebar = columns.sidebar.map(block => paragraph(block, true)).join('');
  const cell = (content: string, width: number, shade?: string) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="top"/><w:tcMar><w:top w:w="180" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="180" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tcMar>${shade ? `<w:shd w:fill="${shade}"/>` : ''}</w:tcPr>${content || '<w:p/>'}</w:tc>`;
  const body = !sidebar ? main : `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${template === 'modern' ? '<w:gridCol w:w="2900"/><w:gridCol w:w="6738"/>' : '<w:gridCol w:w="6738"/><w:gridCol w:w="2900"/>'}</w:tblGrid><w:tr>${template === 'modern' ? cell(sidebar, 2900, 'EAF3F8') + cell(main, 6738) : cell(main, 6738) + cell(sidebar, 2900, '163853')}</w:tr></w:tbl>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1134" w:bottom="850" w:left="1134"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function pdf(resume: Resume, template: ResumeExportTemplate): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, autoFirstPage: false, info: { Title: resume.title, Creator: '简历有方' } });
  const parts: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => { doc.on('data', chunk => parts.push(chunk)); doc.on('end', () => resolve(Buffer.concat(parts))); doc.on('error', reject); });
  doc.registerFont('Resume', fontPath).font('Resume');
  const columns = blocks(resume, template);
  const hasSidebar = columns.sidebar.length > 0;
  const pageWidth = 595.28, pageHeight = 841.89, top = 42, bottom = pageHeight - 42;
  const ensurePage = (index: number) => {
    while (doc.bufferedPageRange().count <= index) {
      doc.addPage();
      if (hasSidebar) doc.save().rect(template === 'modern' ? 26 : 411, 26, 158, pageHeight - 52).fill(template === 'modern' ? '#EAF3F8' : '#163853').restore();
    }
    doc.switchToPage(index);
  };
  const column = (values: Block[], x: number, width: number, sidebar: boolean) => {
    let page = 0, y = top;
    ensurePage(0);
    for (const block of values) {
      const size = block.kind === 'name' ? 22 : block.kind === 'heading' ? 13 : sidebar ? 10 : 11;
      const lineHeight = size * 1.65;
      const color = sidebar && template === 'business' ? '#FFFFFF' : block.kind === 'body' ? '#30343A' : `#${colors[template]}`;
      if (block.kind === 'heading') y += 10;
      doc.font('Resume').fontSize(size);
      const lines: string[] = [];
      let line = '';
      for (const character of block.text.replace(/\t/g, '    ')) {
        if (line && doc.widthOfString(line + character) > width) { lines.push(line); line = ''; }
        line += character;
      }
      lines.push(line);
      for (const text of lines) {
        if (y + lineHeight > bottom) { page++; ensurePage(page); y = top; }
        doc.font('Resume').fontSize(size).fillColor(color).text(text || ' ', x, y, { width, lineBreak: false, align: block.kind === 'name' && template === 'minimal' ? 'center' : 'left' });
        y += lineHeight;
      }
      if (block.kind === 'name') y += 12;
    }
  };
  column(columns.main, hasSidebar && template === 'modern' ? 203 : 43, hasSidebar ? 348 : pageWidth - 86, false);
  if (hasSidebar) column(columns.sidebar, template === 'modern' ? 39 : 424, 132, true);
  doc.end();
  return complete;
}

export async function renderResumeFile(resume: Resume, format: ResumeExportFormat, template: ResumeExportTemplate): Promise<Buffer> {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(resume.text) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(resume.text)) throw new Error('INVALID_EXPORT_TEXT');
  return format === 'docx' ? word(resume, template) : pdf(resume, template);
}
