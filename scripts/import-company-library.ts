import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CompanyImportError, runCompanyImport, type CompanyImportMapping } from '../server/company-import.js';

const booleanOptions = new Set(['dry-run', 'apply', 'replace', 'allow-partial']);
const valueOptions = new Set(['input', 'source-title', 'source-url', 'sheet', 'header-row', 'mapping', 'output', 'report']);
try {
  const options = new Map<string, string | true>();
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i].replace(/^--/, '');
    if (!process.argv[i].startsWith('--') || !booleanOptions.has(name) && !valueOptions.has(name) || options.has(name)) throw new CompanyImportError('INVALID_ARGUMENT', '参数无效或重复。');
    if (booleanOptions.has(name)) options.set(name, true);
    else {
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) throw new CompanyImportError('INVALID_ARGUMENT', '参数缺少值。');
      options.set(name, value);
    }
  }
  if (!options.has('input') || !options.has('source-title')) throw new CompanyImportError('MISSING_ARGUMENT', '必须提供 --input 与 --source-title。');
  if (options.has('apply') && options.has('dry-run')) throw new CompanyImportError('INVALID_ARGUMENT', 'apply 与 dry-run 不能同时设置。');
  if (options.has('replace') && !options.has('apply') || options.has('allow-partial') && !options.has('apply')) throw new CompanyImportError('INVALID_ARGUMENT', 'replace 和 allow-partial 只能配合 apply。');
  let mapping: CompanyImportMapping | undefined;
  if (options.has('mapping')) {
    try { mapping = JSON.parse(await readFile(resolve(options.get('mapping') as string), 'utf8')); }
    catch { throw new CompanyImportError('INVALID_MAPPING', '无法读取 mapping JSON 文件。'); }
  }
  const result = await runCompanyImport({
    inputPath: options.get('input') as string, sourceTitle: options.get('source-title') as string,
    ...(options.has('source-url') ? { sourceUrl: options.get('source-url') as string } : {}),
    ...(options.has('sheet') ? { sheet: options.get('sheet') as string } : {}),
    ...(options.has('header-row') ? { headerRow: Number(options.get('header-row')) } : {}),
    ...(options.has('mapping') ? { mapping } : {}),
    ...(options.has('output') ? { outputPath: options.get('output') as string } : {}),
    ...(options.has('report') ? { reportPath: options.get('report') as string } : {}),
    apply: options.has('apply'), replace: options.has('replace'), allowPartial: options.has('allow-partial'),
  });
  console.log(JSON.stringify({
    applied: result.applied, alreadyImported: result.alreadyImported, inputRows: result.report.totalRows,
    acceptedRows: result.report.acceptedRows, records: result.report.records, duplicateRowsMerged: result.report.duplicateRowsMerged,
    reviewRows: result.report.reviewRows.length, sameNameCandidateGroups: result.report.sameNameCandidates.length,
    unmappedColumns: result.report.unmappedColumns.length, excludedContactColumns: result.report.excludedContactColumns.length,
    reportPath: result.reportPath, ...(result.backupDirectory ? { backupDirectory: result.backupDirectory } : {}),
  }));
} catch (error) {
  // Do not print raw parser errors, input rows, contact values or local credentials.
  console.error(JSON.stringify(error instanceof CompanyImportError
    ? { code: error.code, message: error.message }
    : { code: 'IMPORT_FAILED', message: '导入未完成，请检查文件路径、权限和受限报告；当前目录未被静默覆盖。' }));
  process.exitCode = 1;
}
