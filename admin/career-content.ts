import type {
  ApplyCareerContent, CareerAttachment, CareerContentAction, CareerContentDetail, CareerContentDraft, CareerContentKind,
  CareerContentReceipt, CareerContentReview, CareerContentSummary, CareerContentValue, ReviewCareerContent, SaveCareerContentDraft,
} from '../shared/types.js';
import { inputLimits } from '../shared/limits.js';
import { careerFileFallbackText, careerFileFormat, careerFileLimits, careerFileMaxBytes, isCareerAttachment } from '../shared/career-attachment.js';
import { careerJobAudienceLabels } from '../shared/career.js';
import { button, element, formatTime } from './dom.js';

const kindNames = { material: '复习资料', portal: '招聘入口', job: '招聘岗位' };
const availabilityLabels = { open: '保留投递入口', closed: '已关闭' };
const actionNames = { draft: '保存草稿', publish: '发布', withdraw: '下架', restore: '回滚' };
type Target = Pick<CareerContentSummary, 'kind' | 'id'>;
type Request = <T>(path: string, payload?: object) => Promise<T>;

interface Field { name: string; label: string; max?: number; optional?: boolean; multiline?: boolean; type?: string; options?: Record<string, string> }
const fields: Record<CareerContentKind, Field[]> = {
  material: [
    { name: 'title', label: '资料标题', max: 160 }, { name: 'major', label: '专业', max: 100 },
    { name: 'role', label: '对应岗位', max: 120, optional: true }, { name: 'summary', label: '摘要', max: 1000, optional: true, multiline: true },
    { name: 'content', label: '正文（纯文本）', max: 100000, multiline: true },
    { name: 'sourceLabel', label: '资料来源', max: 200 }, { name: 'sourceUrl', label: '来源链接', max: 2000, optional: true, type: 'url' },
  ],
  portal: [
    { name: 'organization', label: '机构名称', max: 160 },
    { name: 'majors', label: '适用专业（每行一个，最多 30 个）', max: 3030, multiline: true },
    { name: 'audience', label: '适用人群', max: 120 },
    { name: 'description', label: '入口说明（纯文本）', max: 2000, multiline: true },
    { name: 'sourceUrl', label: '官方 HTTPS 入口', max: 2000, type: 'url' }, { name: 'checkedAt', label: '入口核查日期', type: 'date' },
  ],
  job: [
    { name: 'company', label: '招聘单位', max: 120 }, { name: 'title', label: '岗位名称', max: 120 },
    { name: 'major', label: '专业方向', max: 100 }, { name: 'location', label: '工作城市', max: 100 },
    { name: 'audience', label: '招聘类型', options: careerJobAudienceLabels },
    { name: 'description', label: '职责、任职条件与加分项', max: inputLimits.jobDescription, multiline: true },
    { name: 'companyOverview', label: '单位简介', max: 5000, optional: true, multiline: true },
    { name: 'sourceLabel', label: '来源名称', max: 200 }, { name: 'sourceUrl', label: '官方 HTTPS 岗位详情', type: 'url', max: 2000 },
    { name: 'checkedAt', label: '来源核对日期', type: 'date' }, { name: 'deadline', label: '报名截止日期', type: 'date', optional: true },
    { name: 'availability', label: '岗位状态', options: availabilityLabels },
  ],
};

function fieldValue(value: CareerContentValue | null, key: string) {
  if (!value || !Object.hasOwn(value, key)) return '';
  const field = (value as unknown as Record<string, string | string[]>)[key];
  return Array.isArray(field) ? field.join('\n') : field;
}

function draftInput(kind: CareerContentKind, form: HTMLFormElement, source: CareerContentValue | null, attachment?: CareerAttachment): CareerContentDraft {
  const input = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const sourceUrl = input.sourceUrl.trim();
  if (kind === 'material') {
    const { title, major, role, summary, content, sourceLabel } = input;
    return { title, major, role, summary, content, sourceLabel, ...(sourceUrl ? { sourceUrl } : {}), ...(attachment ? { attachment } : {}) };
  }
  const originalDate = fieldValue(source, 'checkedAt');
  const checkedAt = originalDate.slice(0, 10) === input.checkedAt ? originalDate : `${input.checkedAt}T00:00:00+08:00`;
  if (kind === 'job') {
    const { company, title, major, location, description, companyOverview, sourceLabel, deadline, audience, availability } = input;
    return { company, title, major, location, description, companyOverview, sourceLabel, sourceUrl, ...(deadline ? { deadline } : {}),
      audience: audience as keyof typeof careerJobAudienceLabels, availability: availability as keyof typeof availabilityLabels, checkedAt };
  }
  const { organization, audience, description, majors } = input;
  return { organization, audience, description, sourceUrl, majors: majors.split('\n').map(value => value.trim()).filter(Boolean),
    checkedAt };
}

function attachmentLink(file: CareerAttachment) {
  const src = `/api/v1/admin/career-files/${file.id}.${file.format}`;
  const link = element('a', `${file.fileName}（${Math.ceil(file.bytes / 1024)} KB）`);
  link.href = src;
  link.download = file.fileName;
  const preview = element('div', undefined, 'content-media');
  preview.append(link);
  if (file.format === 'mp4') {
    const player = element('video');
    player.src = src;
    player.preload = 'none';
    player.controls = true;
    player.playsInline = true;
    player.setAttribute('aria-label', `预览视频 ${file.fileName}`);
    const message = element('p', '', 'help');
    message.setAttribute('role', 'status');
    player.addEventListener('error', () => { message.textContent = '视频无法播放，请重新登录或核对上传的原文件。'; });
    preview.append(player, message);
  }
  return preview;
}

class AttachmentUploadError extends Error {}

async function uploadAttachment(file: File, request: Request, progress: (sent: number) => void) {
  const format = careerFileFormat(file.name);
  if (!format || !file.name.includes('.') || file.size < 1 || file.size > careerFileMaxBytes(format)) {
    throw new AttachmentUploadError('请选择 10 MB 以内的 PDF／Word（.docx），或 30 MB 以内的 MP4。');
  }
  const uploadId = crypto.randomUUID();
  try {
    for (let offset = 0, index = 0; offset < file.size; offset += careerFileLimits.chunkBytes, index++) {
      const bytes = new Uint8Array(await file.slice(offset, offset + careerFileLimits.chunkBytes).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await request<{ receivedBytes: number }>('career-files/chunk', { uploadId, index, format, data: btoa(binary) });
      if (result.receivedBytes !== offset + bytes.length) throw new AttachmentUploadError('文件分片未完整保存，请重新上传。');
      progress(result.receivedBytes);
    }
    const attachment = await request<unknown>('career-files/finish', { uploadId, fileName: file.name, bytes: file.size });
    if (!isCareerAttachment(attachment) || attachment.bytes !== file.size) throw new AttachmentUploadError('文件校验结果无效，请重新上传。');
    return attachment;
  } catch (error) {
    await request('career-files/cancel', { uploadId }).catch(() => undefined);
    throw error;
  }
}

function contentPreview(label: string, kind: CareerContentKind, value: CareerContentValue | null) {
  const panel = element('section', undefined, 'content-preview');
  panel.append(element('h3', label));
  if (!value) panel.append(element('p', '工作台不展示此条目。', 'help'));
  else {
    const entries = element('dl');
    if ('attachment' in value && value.attachment) {
      const file = element('dd');
      file.append(attachmentLink(value.attachment));
      entries.append(element('dt', '资料文件'), file);
    }
    for (const field of fields[kind]) {
      if (field.name === 'content' && 'attachment' in value && value.attachment && value.content === careerFileFallbackText) continue;
      const raw = fieldValue(value, field.name);
      entries.append(element('dt', field.label), element('dd', (field.options?.[raw] ?? raw) || '—'));
    }
    panel.append(entries);
  }
  return panel;
}

export function renderCareerContent(root: HTMLElement, initial: CareerContentSummary[], request: Request, reportError: (error: unknown) => string) {
  let rows = initial;
  let kind: CareerContentKind = 'material';
  let current: Target | null = null;
  let dirty = false;
  let busy = false;

  const wrapper = element('div', undefined, 'content-workspace');
  const library = element('aside', undefined, 'content-panel');
  const editor = element('section', undefined, 'content-panel');
  const feedback = element('p', '', 'help');
  feedback.setAttribute('role', 'status');
  const query = element('input');
  query.type = 'search';
  query.placeholder = '搜索标题、机构或编号';
  query.setAttribute('aria-label', '搜索求职内容');
  const selector = element('select');
  selector.setAttribute('aria-label', '求职内容类型');
  for (const [key, label] of Object.entries(kindNames)) selector.add(new Option(label, key));
  const catalog = element('div', undefined, 'content-list');
  const recheck = element('label', undefined, 'content-confirmation');
  const recheckOnly = element('input');
  recheckOnly.type = 'checkbox';
  recheck.append(recheckOnly, element('span', '只看待复核岗位'));
  const controls = element('div', undefined, 'content-actions');
  const add = button('新建草稿', () => {
    if (!canLeave()) return;
    if (!globalThis.crypto?.randomUUID) {
      feedback.textContent = '请通过 HTTPS 打开后台后新建草稿。';
      return;
    }
    current = { kind, id: `admin-${crypto.randomUUID()}` };
    renderList();
    showEditor(current);
  }, 'primary');
  controls.append(selector, add);
  library.append(controls, query, recheck, catalog);
  wrapper.append(library, editor);
  root.append(feedback, wrapper);

  const canLeave = () => !busy && (!dirty || window.confirm('当前编辑尚未保存，是否放弃这些修改？'));

  function renderList() {
    const needle = query.value.trim().toLowerCase();
    recheck.hidden = kind !== 'job';
    const matching = rows.filter(row => row.kind === kind && (kind !== 'job' || !recheckOnly.checked || row.needsRecheck)
      && (!needle || row.title.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)));
    catalog.replaceChildren();
    for (const row of matching) {
      const item = button('', () => void select(row), 'content-list-item');
      item.append(element('strong', row.title), element('small', [row.live ? '已展示' : '未展示', ...(row.hasDraft ? ['有草稿'] : []), ...(row.needsRecheck ? ['来源待复核'] : [])].join(' · ')));
      if (current?.id === row.id && current.kind === row.kind) item.setAttribute('aria-current', 'true');
      catalog.append(item);
    }
    if (!matching.length) catalog.append(element('p', '没有符合条件的内容。', 'help'));
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    // Block interactive changes while a request is in flight, while retaining form state.
    wrapper.inert = true;
    feedback.textContent = '处理中…';
    try { await action(); }
    catch (error) { feedback.textContent = reportError(error); }
    finally { busy = false; wrapper.inert = false; }
  }

  async function select(target: Target) {
    if (!canLeave()) return;
    await run(async () => {
      const detail = await request<CareerContentDetail>(route(target));
      current = target;
      renderList();
      showEditor(target, detail);
      feedback.textContent = '';
    });
  }

  const route = ({ kind, id }: Target) => `career-content/${kind}/${id}`;

  async function reload(target: Target) {
    const [items, detail] = await Promise.all([
      request<CareerContentSummary[]>('career-content'), request<CareerContentDetail>(route(target)),
    ]);
    rows = items;
    renderList();
    showEditor(target, detail);
  }

  async function afterWrite(target: Target, message: string) {
    try {
      await reload(target);
      feedback.textContent = message;
    } catch (error) {
      feedback.textContent = `${message} 刷新失败。${reportError(error)}`;
    }
  }

  function showEditor(target: Target, detail?: CareerContentDetail) {
    dirty = false;
    feedback.textContent = '';
    const source = detail?.draft ?? detail?.live ?? null;
    let attachment = source && 'attachment' in source ? source.attachment : undefined;
    const form = element('form', undefined, 'content-form');
    form.method = 'post';
    const preview = element('div', undefined, 'content-review');
    const history = element('div', undefined, 'content-history');
    const formActions = element('div', undefined, 'content-actions');
    const reviewActions = element('div', undefined, 'content-actions');
    const path = route(target);
    let pendingSave: { fingerprint: string; id: string } | undefined;
    for (const field of fields[target.kind]) {
      const label = element('label');
      const control = field.options ? element('select') : field.multiline ? element('textarea') : element('input');
      label.append(element('span', field.label), control);
      control.name = field.name;
      control.required = !field.optional && !(field.name === 'content' && attachment);
      if (field.max && !(control instanceof HTMLSelectElement)) control.maxLength = field.max;
      if (control instanceof HTMLSelectElement) {
        control.add(new Option('请选择', ''));
        for (const [key, label] of Object.entries(field.options ?? {})) control.add(new Option(label, key));
      }
      if (control instanceof HTMLInputElement) control.type = field.type ?? 'text';
      if (control instanceof HTMLTextAreaElement) control.rows = field.name === 'content' ? 9 : 3;
      const value = fieldValue(source, field.name);
      control.value = field.type === 'date' ? value.slice(0, 10)
        : field.name === 'content' && attachment && value === careerFileFallbackText ? '' : value;
      form.append(label);
    }
    if (target.kind === 'material') {
      const label = element('label');
      const picker = element('input');
      picker.type = 'file';
      picker.accept = '.pdf,.docx,.mp4';
      label.append(element('span', '上传 PDF／Word（10 MB 内）或 MP4 视频（30 MB 内，H.264）'), picker);
      const fileInfo = element('div', undefined, 'content-actions');
      const textBody = form.querySelector<HTMLTextAreaElement>('[name=content]')!;
      function showAttachment() {
        textBody.required = !attachment;
        fileInfo.replaceChildren();
        if (attachment) fileInfo.append(attachmentLink(attachment), button('移除附件', () => {
          attachment = undefined;
          dirty = true;
          preview.replaceChildren();
          showAttachment();
        }));
        else fileInfo.append(element('span', '纯文本资料可直接填写正文。', 'help'));
      }
      picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        picker.value = '';
        if (!file) return;
        void run(async () => {
          try {
            attachment = await uploadAttachment(file, request, sent => {
              feedback.textContent = `上传中 ${Math.floor(sent / file.size * 100)}%`;
            });
          } catch (error) {
            if (error instanceof AttachmentUploadError) {
              feedback.textContent = error.message;
              return;
            }
            throw error;
          }
          dirty = true;
          preview.replaceChildren();
          showAttachment();
          feedback.textContent = '文件已上传，保存草稿后可预览发布。';
        });
      });
      showAttachment();
      form.prepend(label, fileInfo);
    }
    const save = element('button', '保存草稿', 'primary');
    save.type = 'submit';
    formActions.append(save);
    form.append(formActions);
    form.addEventListener('input', event => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'file') return;
      dirty = true;
      preview.replaceChildren();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const content = draftInput(target.kind, form, source, attachment);
      const fingerprint = JSON.stringify(content);
      if (pendingSave?.fingerprint !== fingerprint) pendingSave = { fingerprint, id: crypto.randomUUID() };
      const payload: SaveCareerContentDraft = { revision: detail?.revision ?? null, content, operationId: pendingSave.id };
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > inputLimits.bodyBytes) {
        feedback.textContent = '请求内容超过 256 KB，请缩短正文后再保存。';
        return;
      }
      void run(async () => {
        const receipt = await request<CareerContentReceipt>(`${path}/draft`, payload);
        dirty = false;
        await afterWrite(target, `草稿已保存，操作版本 ${receipt.version}。可继续预览发布。`);
      });
    });

    function review(action: CareerContentAction, sourceVersion?: number) {
      if (!detail) return;
      if (dirty) { feedback.textContent = '请先保存当前编辑，再预览已保存的版本。'; return; }
      const payload: ReviewCareerContent = { revision: detail.revision, action, ...(sourceVersion === undefined ? {} : { sourceVersion }) };
      void run(async () => {
        const result = await request<CareerContentReview>(`${path}/preview`, payload);
        const comparison = element('div', undefined, 'content-comparison');
        comparison.append(contentPreview('当前对会员展示', target.kind, result.live), contentPreview('本次操作后', target.kind, result.proposed));
        const confirmation = element('label', undefined, 'content-confirmation');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        confirmation.append(checkbox, element('span', action === 'withdraw' ? '我已核对当前内容，确认从工作台下架。'
          : '我已核对来源与对照内容，确认在工作台展示。'));
        const operationId = crypto.randomUUID();
        const confirm = button(`确认${actionNames[action]}`, () => {
          if (!checkbox.checked) return;
          const apply: ApplyCareerContent = { ...payload, token: result.token, operationId, confirmed: true };
          void run(async () => {
            const receipt = await request<CareerContentReceipt>(`${path}/apply`, apply);
            await afterWrite(target, `${actionNames[action]}成功，操作版本 ${receipt.version}。`);
          });
        }, 'primary');
        confirm.disabled = true;
        checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked; });
        const actions = element('div', undefined, 'content-actions');
        actions.append(confirm, button('取消预览', () => preview.replaceChildren()));
        preview.replaceChildren(element('h3', `${actionNames[action]}预览`), comparison, confirmation, actions);
        feedback.textContent = '校验通过，请核对对照内容。';
        preview.scrollIntoView({ block: 'nearest' });
      });
    }

    if (detail?.draft) reviewActions.append(button('预览发布', () => review('publish'), 'primary'));
    if (detail?.live) reviewActions.append(button('预览下架', () => review('withdraw')));
    if (detail?.baselineAvailable && detail.activeVersion !== null) reviewActions.append(button('预览恢复原目录版本', () => review('restore', 0)));
    history.append(element('h3', '操作历史'));
    if (!detail?.history.length) history.append(element('p', '暂无后台操作记录。', 'help'));
    else {
      const log = element('ol');
      for (const entry of detail.history) {
        const row = element('li');
        row.append(element('strong', `版本 ${entry.version} · ${actionNames[entry.action]}`),
          element('small', `${formatTime(entry.at)} · 管理员 ${entry.actorId}${entry.sourceVersion === undefined ? '' : ` · 恢复来源 ${entry.sourceVersion}`}`));
        if ((entry.action === 'publish' || entry.action === 'restore') && entry.version !== detail.activeVersion) {
          row.append(button('预览回滚至此版本', () => review('restore', entry.version), 'link'));
        }
        log.append(row);
      }
      history.append(log);
    }
    const label = detail?.live ? '已在工作台展示' : '当前未展示';
    const advice = target.kind === 'job' ? '打开官方岗位详情，核对城市、任职条件、申请状态与截止日期。官网未给出截止日期时可留空。'
      : target.kind === 'portal' ? '请核实入口归属、链接和核查日期。入口只供查阅招聘渠道。' : '填写资料来源与正文，保存后可在发布预览中与当前版本对照。';
    editor.replaceChildren(element('h2', `${detail ? '编辑' : '新建'}${kindNames[target.kind]}`),
      element('p', `${label}${detail?.draft ? ' · 有已保存草稿' : ''}`, 'help'), element('p', advice, 'help'),
      form, reviewActions, preview, history);
  }

  query.addEventListener('input', renderList);
  recheckOnly.addEventListener('change', renderList);
  selector.addEventListener('change', () => { kind = selector.value as CareerContentKind; renderList(); });
  renderList();
  editor.append(element('h2', '选择资料或新建草稿'), element('p', '保存草稿后可预览发布。确认后，新版本会显示在高级会员工作台。', 'help'));
  return { canLeave, hasChanges: () => dirty || busy };
}
