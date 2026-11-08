import type { CompanyBatchEvent, CompanyBatchPreview, CompanyBatchState } from '../shared/types.js';
import { companyBatchFileLimit } from '../shared/company-batch.js';
import { careerFileLimits } from '../shared/career-attachment.js';
import { button, element, formatTime } from './dom.js';

type Request = <T>(path: string, payload?: object) => Promise<T>;
const path = 'company-batches';
const companyFields = [
  { key: 'name', label: '企业名称', max: 200 },
  { key: 'industries', label: '行业', max: 1000 },
  { key: 'locations', label: '工作地点', max: 1000 },
  { key: 'recruitmentTypes', label: '招聘批次', max: 500 },
  { key: 'educationLevels', label: '学历要求', max: 500 },
  { key: 'recruitmentUrl', label: '招聘链接', max: 2000 },
  { key: 'aliases', label: '企业别名', max: 1000 },
  { key: 'nature', label: '企业性质', max: 100 },
  { key: 'directions', label: '岗位方向', max: 1000 },
  { key: 'cohorts', label: '招聘对象或届别', max: 500 },
  { key: 'summary', label: '企业简介或招聘说明', max: 20000 },
] as const;
type ManualPreviewRow = Partial<Record<typeof companyFields[number]['key'], string | string[]>>;

export function renderCompanyBatches(root: HTMLElement, initial: CompanyBatchState, request: Request, reportError: (error: unknown) => string) {
  let busy = false;
  let current = initial;
  let reviewed: CompanyBatchPreview | undefined;
  const feedback = element('p', '', 'help');
  feedback.setAttribute('role', 'status');
  const controls = element('section', undefined, 'content-panel');
  const form = element('form', undefined, 'content-form');
  form.method = 'post';
  const preview = element('section', undefined, 'content-panel');
  const history = element('section', undefined, 'content-panel');
  const workspace = element('div', undefined, 'company-batch-workspace');
  const count = element('p', '', 'help');
  const file = element('input');
  file.type = 'file';
  file.accept = '.csv,.json';
  file.required = true;
  const title = element('input'), sheet = element('input'), mapping = element('textarea'), headerRow = element('input');
  title.required = true;
  title.maxLength = 200;
  sheet.maxLength = 160;
  mapping.rows = 3;
  mapping.maxLength = 8000;
  mapping.placeholder = '{"name":"单位名称"}';
  headerRow.type = 'number';
  headerRow.min = '1';
  headerRow.max = '1000';
  headerRow.value = '1';
  const label = (text: string, control: HTMLElement) => {
    const node = element('label');
    node.append(element('span', text), control);
    return node;
  };
  const options = element('details');
  options.append(element('summary', '表头和字段映射（可选）'), label('CSV 表头行号', headerRow), label('字段映射 JSON', mapping));
  const mode = element('select');
  mode.add(new Option('上传表格', 'file'));
  mode.add(new Option('直接填写', 'manual'));
  const uploadFields = element('fieldset', undefined, 'company-batch-fields');
  uploadFields.append(label('UTF-8 CSV 或 JSON（最大 10 MB）', file), label('工作表名称（可选）', sheet), options);
  const manualFields = element('fieldset', undefined, 'company-batch-fields');
  const manualInputs = companyFields.map(field => {
    const input = field.key === 'summary' ? element('textarea') : element('input');
    if (input instanceof HTMLTextAreaElement) input.rows = 4;
    else input.type = field.key === 'recruitmentUrl' ? 'url' : 'text';
    input.maxLength = field.max;
    input.required = field.key === 'name';
    return { ...field, input };
  });
  const manualGrid = element('div', undefined, 'company-manual-grid');
  manualFields.append(element('p', '一次录入一条企业招聘记录。多个值可用顿号或逗号分隔。', 'help'), manualGrid);
  for (const field of manualInputs) {
    const group = field.key === 'summary' ? manualFields : manualGrid;
    group.append(label(field.key === 'name' ? '企业名称（必填）' : field.label, field.input));
  }
  const submit = element('button', '上传并预览', 'primary');
  submit.type = 'submit';
  const rollback = button('预览回滚最新批次', () => void run(async () => {
    clearPreview();
    showPreview(await request<CompanyBatchPreview>(`${path}/rollback-preview`, {}));
  }));
  const actions = element('div', undefined, 'content-actions');
  actions.append(submit, rollback);
  form.append(label('录入方式', mode), label('通用来源名称（必填）', title), uploadFields, manualFields, actions);
  controls.append(element('h2', '企业资料录入'), count,
    element('p', '先核对预览再发布。完全相同的记录会跳过，同名不同内容会作为独立记录保留。', 'help'), form);
  workspace.append(controls, preview, history);
  root.append(feedback, workspace);

  function clearPreview() {
    reviewed = undefined;
    preview.replaceChildren();
    preview.hidden = true;
  }

  function showState() {
    count.textContent = `当前企业目录共有 ${current.count.toLocaleString('zh-CN')} 条记录。`;
    rollback.disabled = !current.canRollback;
    history.replaceChildren(element('h2', '发布与回滚历史'));
    const log = element('ol');
    for (const event of current.history) {
      const row = element('li');
      row.append(element('strong', `${event.action === 'publish' ? '发布' : '回滚'} · ${event.sourceTitle}`),
        element('div', `${event.beforeCount} → ${event.afterCount} 条 · ${formatTime(event.at)} · 管理员 ${event.actorId}`, 'help'));
      log.append(row);
    }
    history.append(current.history.length ? log : element('p', '暂无后台发布记录。', 'help'));
  }

  function showPreview(value: CompanyBatchPreview, manualRow?: ManualPreviewRow) {
    reviewed = value;
    const action = value.action === 'publish' ? '发布' : '回滚';
    preview.hidden = false;
    preview.replaceChildren(element('h2', `${action}预览`), element('p', value.sourceTitle),
      element('p', `目录记录数：${value.beforeCount.toLocaleString('zh-CN')} → ${value.afterCount.toLocaleString('zh-CN')}`));
    if (value.action === 'publish') {
      const added = value.afterCount - value.beforeCount;
      preview.append(element('p', `输入 ${value.inputRows} 行，新增 ${added} 条，库内重复 ${value.existingRecords} 条，批内合并 ${value.duplicateRows} 行。`),
        element('p', `同名差异 ${value.sameNameRecords} 条，待处理 ${value.reviewCount} 行。忽略未映射列 ${value.unmappedColumns} 个，排除联系方式列 ${value.excludedContactColumns} 个。`, 'help'));
      if (manualRow) {
        const detail = element('dl', undefined, 'company-manual-preview');
        for (const { key, label } of companyFields) {
          const field = manualRow[key];
          const text = Array.isArray(field) ? field.join('、') : field;
          if (text) detail.append(element('dt', label), element('dd', text));
        }
        preview.append(element('h3', '将发布的企业资料'), detail);
      } else if (value.sample.length) {
        const sample = element('ul');
        for (const row of value.sample) sample.append(element('li',
          `${row.name} · 行 ${row.rows.join('、')}${row.recruitmentTypes.length ? ` · ${row.recruitmentTypes.join('、')}` : ''}${row.sameName ? ' · 同名差异' : ''}`));
        preview.append(element('h3', `新增样例（${value.sample.length} / ${added}）`), sample);
      }
      if (value.reviewRows.length) {
        const issues = element('ul');
        for (const row of value.reviewRows) issues.append(element('li', `行 ${row.row} · ${row.code} · ${row.fields.join('、')}`));
        preview.append(element('h3', '待处理行（最多 30 行）'), issues);
      }
      if (value.reportId) preview.append(button('下载完整审核报告', () => void run(async () => {
        const report = await request<unknown>(`${path}/report`, { id: value.reportId });
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const link = element('a');
        link.href = url;
        link.download = '企业资料批次审核报告.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        feedback.textContent = '审核报告下载已开始。';
      })));
    }
    if (!value.id) {
      feedback.textContent = value.reviewCount ? '请修正待处理字段后重新生成预览。' : '本批没有可新增的记录。';
      return;
    }
    const id = value.id;
    const checked = element('input');
    checked.type = 'checkbox';
    const confirmation = element('label', undefined, 'content-confirmation');
    confirmation.append(checked, element('span', `我已核对目录差异，确认${action}。`));
    const confirm = button(`确认${action}`, () => {
      if (!checked.checked || reviewed?.id !== id) return;
      void run(async () => {
        const applied = await request<CompanyBatchEvent>(`${path}/apply`, { id, confirmed: true });
        if (manualRow && mode.value === 'manual') {
          for (const field of manualInputs) field.input.value = '';
        }
        clearPreview();
        const message = `${action}已完成，当前目录 ${applied.afterCount} 条。`;
        try {
          current = await request<CompanyBatchState>(path);
          showState();
          feedback.textContent = message;
        } catch (error) { feedback.textContent = `${message} 刷新失败。${reportError(error)}`; }
      });
    }, 'primary');
    confirm.disabled = true;
    checked.addEventListener('change', () => { confirm.disabled = !checked.checked; });
    const row = element('div', undefined, 'content-actions');
    row.append(confirm, button('关闭预览', () => { clearPreview(); feedback.textContent = ''; }));
    preview.append(confirmation, row);
    feedback.textContent = '预览已生成。核对来源、同名差异和忽略列后再确认。';
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    workspace.inert = true;
    feedback.textContent = '正在处理…';
    try { await action(); }
    catch (error) { feedback.textContent = reportError(error); }
    finally { busy = false; workspace.inert = false; }
  }

  function updateMode() {
    const manual = mode.value === 'manual';
    uploadFields.disabled = uploadFields.hidden = manual;
    manualFields.disabled = manualFields.hidden = !manual;
    submit.textContent = manual ? '预览填写内容' : '上传并预览';
    clearPreview();
    feedback.textContent = '';
  }
  mode.addEventListener('change', updateMode);
  form.addEventListener('input', clearPreview);
  form.addEventListener('submit', event => {
    event.preventDefault();
    clearPreview();
    const manual = mode.value === 'manual';
    const values = manual ? Object.fromEntries(manualInputs.map(field => [field.key, field.input.value.trim()])) : undefined;
    if (values && !values.name) {
      feedback.textContent = '请填写企业名称。';
      return;
    }
    const selected = values ? new Blob([JSON.stringify([values])], { type: 'application/json' }) : file.files?.[0];
    const format = manual ? 'json' : file.files?.[0]?.name.split('.').at(-1)?.toLowerCase();
    if (!selected || !selected.size || selected.size > companyBatchFileLimit || (format !== 'csv' && format !== 'json')) {
      feedback.textContent = '请选择 10 MB 以内的 UTF-8 CSV 或 JSON。';
      return;
    }
    if (!globalThis.crypto?.randomUUID) { feedback.textContent = '请通过 HTTPS 打开后台后上传。'; return; }
    let fieldMapping: unknown;
    if (!manual && mapping.value.trim()) {
      try { fieldMapping = JSON.parse(mapping.value); }
      catch { feedback.textContent = '字段映射须为有效的 JSON 对象。'; return; }
    }
    const id = crypto.randomUUID();
    const fields = { id, bytes: selected.size, format, sourceTitle: title.value.trim(),
      sheet: manual ? '后台手工录入' : sheet.value.trim(), headerRow: manual ? 1 : Number(headerRow.value),
      ...(fieldMapping === undefined ? {} : { mapping: fieldMapping }) };
    void run(async () => {
      for (let offset = 0, index = 0; offset < selected.size; offset += careerFileLimits.chunkBytes, index++) {
        const bytes = new Uint8Array(await selected.slice(offset, offset + careerFileLimits.chunkBytes).arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const receipt = await request<{ receivedBytes: number }>(`${path}/chunk`, { id, index, data: btoa(binary) });
        if (receipt.receivedBytes !== offset + bytes.length) throw new Error('上传未完成');
        if (!manual) feedback.textContent = `正在上传 ${Math.floor(receipt.receivedBytes / selected.size * 100)}%`;
      }
      const result = await request<CompanyBatchPreview>(`${path}/preview`, fields);
      const report = manual && result.id && result.reportId
        ? await request<{ added: ManualPreviewRow[] }>(`${path}/report`, { id: result.reportId }) : undefined;
      showPreview(result, report?.added[0]);
    });
  });
  updateMode();
  showState();
  return { canLeave: () => !busy, hasChanges: () => busy };
}
