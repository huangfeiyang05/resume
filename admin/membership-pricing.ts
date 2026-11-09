import type { AdminPricingPreview, AdminPricingState, MembershipPrices } from '../shared/types.js';
import { button, element, formatTime } from './dom.js';

type Request = <T>(path: string, payload?: object) => Promise<T>;
const fields = [
  ['basicMonthlyCents', '初级会员月价'],
  ['premiumMonthlyCents', '高级会员月价'],
  ['premiumFirstPurchaseCents', '高级会员首充价'],
] as const satisfies readonly (readonly [keyof MembershipPrices, string])[];
const decimal = (amount: number | null) => amount === null ? '' : (amount / 100).toFixed(2);
const display = (amount: number | null) => amount === null ? '关闭首充优惠' : `¥${decimal(amount)}`;

export function renderMembershipPricing(root: HTMLElement, initial: AdminPricingState, request: Request, reportError: (error: unknown) => string) {
  let state = initial;
  let busy = false;
  let current: AdminPricingPreview | undefined;
  const editor = element('section', undefined, 'content-panel');
  const feedback = element('p', undefined, 'help');
  feedback.setAttribute('role', 'status');
  const form = element('form', undefined, 'content-form');
  form.method = 'post';
  const inputs = fields.map(([key, label]) => {
    const input = element('input');
    input.inputMode = 'decimal';
    input.maxLength = 9;
    input.required = key !== 'premiumFirstPurchaseCents';
    input.autocomplete = 'off';
    const row = element('label');
    row.append(element('span', `${label}（元）${input.required ? '' : '，留空关闭'}`), input);
    form.append(row);
    return { key, input };
  });
  const review = element('div', undefined, 'content-actions');
  const previewButton = element('button', '预览价格差异', 'primary');
  previewButton.type = 'submit';
  review.append(previewButton);
  form.append(review);
  const details = element('section', undefined, 'content-panel');
  details.hidden = true;
  const history = element('section', undefined, 'content-panel');
  const version = element('p', undefined, 'help');
  const scope = state.environment === 'test' ? '测试版' : '公开版';
  editor.append(element('h2', `${scope}会员价格`), version,
    element('p', state.environment === 'test' ? '测试版价格只用于本环境的模拟订单。'
      : '确认发布后，新报价和新订单使用该价格。已创建订单沿用原金额。', 'help'),
    form);
  if (state.environment === 'public') editor.insertBefore(element('p', '首次发布公开价格前，请确认小程序已更新至支持报价校验的版本。', 'help'), form);
  const workspace = element('div', undefined, 'company-batch-workspace');
  workspace.append(editor, details, history);
  root.append(feedback, workspace);

  function clearPreview() {
    current = undefined;
    details.replaceChildren();
    details.hidden = true;
  }
  function fill(prices: MembershipPrices) {
    for (const { key, input } of inputs) input.value = decimal(prices[key]);
    clearPreview();
  }
  function renderState() {
    fill(state.prices);
    version.textContent = state.revision ? `当前价格版本 ${state.revision}` : '当前使用服务端初始价格。';
    const list = element('ol');
    for (const entry of state.history.slice(0, 20)) {
      const row = element('li');
      row.append(element('strong', `版本 ${entry.revision} · ${formatTime(entry.publishedAt)}`),
        element('p', fields.map(([key, label]) => `${label} ${display(entry.prices[key])}`).join(' · '), 'help'),
        element('p', `管理员 ${entry.actorId}`, 'help'));
      if (entry.revision !== state.revision) row.append(button('填入此版本', () => fill(entry.prices)));
      list.append(row);
    }
    history.replaceChildren(element('h2', '最近发布历史'), list.childElementCount ? list : element('p', '暂无发布记录。', 'help'));
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    workspace.inert = true;
    feedback.textContent = '正在处理…';
    try { await action(); }
    catch (error) { feedback.textContent = reportError(error); }
    finally { workspace.inert = false; busy = false; }
  }
  function showPreview(value: AdminPricingPreview) {
    current = value;
    const diff = element('dl', undefined, 'company-manual-preview');
    for (const [key, label] of fields) diff.append(element('dt', label), element('dd', `${display(value.before[key])} → ${display(value.after[key])}`));
    const checked = element('input');
    checked.type = 'checkbox';
    const confirmation = element('label', undefined, 'content-confirmation');
    confirmation.append(checked, element('span', `我已核对价格，确认发布到${scope}。`));
    const confirm = button(`确认发布到${scope}`, () => {
      if (!checked.checked || current?.id !== value.id) return;
      void run(async () => {
        const applied = await request<AdminPricingState['history'][number]>('pricing/apply', { id: value.id, confirmed: true });
        state = { ...state, revision: applied.revision, prices: applied.prices, history: [applied, ...state.history] };
        renderState();
        feedback.textContent = `${scope}价格已发布，版本 ${applied.revision}。`;
      });
    }, 'primary');
    confirm.disabled = true;
    checked.addEventListener('change', () => { confirm.disabled = !checked.checked; });
    const actions = element('div', undefined, 'content-actions');
    actions.append(confirm, button('返回编辑', clearPreview));
    details.replaceChildren(element('h2', `${scope}价格对照`), diff, confirmation, actions);
    details.hidden = false;
    feedback.textContent = '请核对金额及发布环境。';
  }
  form.addEventListener('input', clearPreview);
  form.addEventListener('submit', event => {
    event.preventDefault();
    clearPreview();
    const prices: Record<string, number | null> = {};
    for (const { key, input } of inputs) {
      const raw = input.value.trim();
      if (key === 'premiumFirstPurchaseCents' && !raw) { prices[key] = null; continue; }
      const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(raw);
      if (!match) { feedback.textContent = '请填写有效的金额，最多保留两位小数。'; return; }
      prices[key] = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    }
    void run(async () => showPreview(await request<AdminPricingPreview>('pricing/preview', { revision: state.revision, prices })));
  });
  renderState();
  return { canLeave: () => !busy, hasChanges: () => busy || inputs.some(({ key, input }) => input.value !== decimal(state.prices[key])) };
}
