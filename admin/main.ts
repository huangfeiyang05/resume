import type { AdminOrder, AdminOrderQuery, AdminOverview, AdminPage, AdminPricingState, AdminRefund, AdminRefundPreview, AdminTask, AdminTaskQuery, AdminUser, AdminUserQuery, ApiResponse, CareerContentSummary, CompanyBatchState } from '../shared/types.js';
import { adminTaskStatuses, adminUsageStatuses } from '../shared/admin.js';
import { paymentChannels, paymentOrderStatuses } from '../shared/payment.js';
import { workbenchFeatureNames, workbenchFeatures } from '../shared/workbench.js';
import { button, element, formatTime } from './dom.js';
import { renderCareerContent } from './career-content.js';
import { renderCompanyBatches } from './company-batches.js';
import { renderMembershipPricing } from './membership-pricing.js';
import './style.css';

const titles = { overview: '运营概览', users: '用户与会员', orders: '用户与会员', pricing: '会员价格', tasks: '诊断与用量', content: '求职内容', companies: '企业资料' } as const;
type Section = keyof typeof titles;
const planNames = { free: '免费', basic: '初级', premium: '高级' };
const eventNames = { purchase: '购买', renewal: '续费', upgrade: '升级' };
const statusNames = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const usageNames = { reserved: '已预占', dispatched: '已派发', pending: '待核对', settled: '已结算', released: '已释放' };
const orderStatuses = { pending: '待支付确认', paid: '已支付', closed: '已关闭', failed: '失败' };
const channelNames = { jsapi: '微信小程序', native: '微信扫码', 'alipay-page': '支付宝电脑网页', 'alipay-wap': '支付宝手机网页' };
const refundNames: Record<AdminRefund['status'], string> = { requested: '退款待提交', processing: '退款处理中',
  unknown: '退款待核对', succeeded: '退款成功', closed: '退款已关闭', abnormal: '渠道退款异常' };

const login = document.querySelector<HTMLElement>('#login')!;
const loginForm = document.querySelector<HTMLFormElement>('#login-form')!;
const loginMessage = document.querySelector<HTMLElement>('#login-message')!;
const initialStatus = document.querySelector<HTMLElement>('#initial-status')!;
const app = document.querySelector<HTMLElement>('#app')!;
const filters = document.querySelector<HTMLElement>('#filters')!;
const search = document.querySelector<HTMLFormElement>('#search-form')!;
const queryInput = search.querySelector<HTMLInputElement>('[name=query]')!;
const statusSelect = search.querySelector<HTMLSelectElement>('[name=status]')!;
const usageSelect = search.querySelector<HTMLSelectElement>('[name=usageStatus]')!;
const orderStatusSelect = search.querySelector<HTMLSelectElement>('[name=orderStatus]')!;
const orderChannelSelect = search.querySelector<HTMLSelectElement>('[name=orderChannel]')!;
const userViews = document.querySelector<HTMLElement>('#user-views')!;
const viewButtons = userViews.querySelectorAll<HTMLButtonElement>('[data-user-view]');
const orderScope = document.querySelector<HTMLElement>('#order-scope')!;
const nav = document.querySelectorAll<HTMLButtonElement>('nav [data-section]');
const notice = document.querySelector<HTMLElement>('#notice')!;
const result = document.querySelector<HTMLElement>('#result')!;

let section: Section = 'overview';
let userQuery: AdminUserQuery = {};
let orderQuery: AdminOrderQuery = {};
let taskQuery: AdminTaskQuery = {};
let generation = 0;
let refundBusy = false;
let contentEditor: ReturnType<typeof renderCareerContent> | undefined;

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

async function api<T>(path: string, payload?: object): Promise<T> {
  const response = await fetch(`/api/v1/admin/${path}`, {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const json = await response.json().catch(() => undefined) as ApiResponse<T> | { error?: { code: string; message: string } } | undefined;
  if (response.ok && json && 'data' in json) return json.data;
  const error = json && 'error' in json ? json.error : undefined;
  throw new RequestError(response.status, error?.code, error?.message ?? '管理接口暂时不可用，请稍后重试。');
}

function errorMessage(error: unknown) {
  return error instanceof RequestError ? error.message : '连接失败，请重试。';
}
function editorError(error: unknown) {
  if (error instanceof RequestError && error.status === 401) showLogin('管理会话已失效，请重新登录。');
  else if (error instanceof RequestError && error.code === 'ADMIN_FORBIDDEN') showLogin(error.message);
  return errorMessage(error);
}

function showLogin(message: string, disabled = false) {
  generation++;
  initialStatus.hidden = true;
  app.hidden = true;
  result.replaceChildren();
  contentEditor = undefined;
  login.hidden = false;
  loginForm.hidden = disabled;
  loginForm.reset();
  loginMessage.textContent = message;
}

function open(next: Section) {
  if (contentEditor && !contentEditor.canLeave()) return;
  contentEditor = undefined;
  section = next;
  const menu = section === 'orders' ? 'users' : section;
  for (const item of nav) {
    if (item.dataset.section === menu) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  userViews.hidden = menu !== 'users';
  for (const item of viewButtons) {
    const active = item.dataset.userView === section;
    item.classList.toggle('primary', active);
    item.setAttribute('aria-pressed', String(active));
  }
  document.querySelector('#section-title')!.textContent = titles[section];
  filters.hidden = menu !== 'users' && section !== 'tasks';
  orderScope.replaceChildren();
  orderScope.hidden = true;
  const scope = section === 'orders' ? orderQuery.userId : undefined;
  if (scope) {
    orderScope.hidden = false;
    orderScope.append(element('span', `仅查询用户 ${scope} 的订单`, 'help'), button('查看全部订单', () => {
      orderQuery = {};
      open('orders');
    }));
  }
  document.querySelector('#search-label')!.textContent = section === 'tasks' ? '任务 ID、用户 ID 或错误码'
    : section === 'orders' ? scope ? '订单 ID 或商户订单号' : '订单 ID、用户 ID 或商户订单号'
    : '用户 ID、完整邮箱或手机号';
  document.querySelector<HTMLElement>('#task-status-label')!.hidden = section !== 'tasks';
  document.querySelector<HTMLElement>('#usage-status-label')!.hidden = section !== 'tasks';
  document.querySelector<HTMLElement>('#order-status-label')!.hidden = section !== 'orders';
  document.querySelector<HTMLElement>('#order-channel-label')!.hidden = section !== 'orders';
  queryInput.value = (section === 'tasks' ? taskQuery.query : section === 'orders' ? orderQuery.query : userQuery.query) ?? '';
  statusSelect.value = taskQuery.status ?? '';
  usageSelect.value = taskQuery.usageStatus ?? '';
  orderStatusSelect.value = orderQuery.status ?? '';
  orderChannelSelect.value = orderQuery.channel ?? '';
  void refresh();
}

async function refresh() {
  const current = ++generation;
  notice.textContent = '正在加载…';
  result.replaceChildren();
  try {
    if (section === 'overview') {
      const overview = await api<AdminOverview>('overview');
      if (current !== generation) return;
      renderOverview(overview);
    } else if (section === 'users') {
      const users = await api<AdminPage<AdminUser>>('users/search', userQuery);
      if (current !== generation) return;
      renderUsers(users);
    } else if (section === 'orders') {
      const orders = await api<AdminPage<AdminOrder>>('orders/search', orderQuery);
      if (current !== generation) return;
      renderOrders(orders);
    } else if (section === 'pricing') {
      const pricing = await api<AdminPricingState>('pricing');
      if (current !== generation) return;
      contentEditor = renderMembershipPricing(result, pricing, api, editorError);
    } else if (section === 'tasks') {
      const tasks = await api<AdminPage<AdminTask>>('tasks/search', taskQuery);
      if (current !== generation) return;
      renderTasks(tasks);
    } else if (section === 'content') {
      const content = await api<CareerContentSummary[]>('career-content');
      if (current !== generation) return;
      contentEditor = renderCareerContent(result, content, api, editorError);
    } else {
      const companies = await api<CompanyBatchState>('company-batches');
      if (current !== generation) return;
      contentEditor = renderCompanyBatches(result, companies, api, editorError);
    }
    login.hidden = true;
    initialStatus.hidden = true;
    app.hidden = false;
    notice.textContent = '';
  } catch (error) {
    if (current !== generation) return;
    if (error instanceof RequestError && [401, 403].includes(error.status)) {
      showLogin(error.status === 401 ? '' : error.message);
    } else if (error instanceof RequestError && error.code === 'ADMIN_NOT_CONFIGURED') {
      showLogin(error.message, true);
    } else if (app.hidden) {
      showLogin(errorMessage(error));
    } else {
      notice.textContent = errorMessage(error);
    }
  }
}

function renderOverview(data: AdminOverview) {
  const cards = element('div', undefined, 'metrics');
  const add = (label: string, value: number, action?: () => void) => {
    const card = action ? button('', action, 'metric') : element('div', undefined, 'metric');
    card.append(element('span', label), element('strong', value.toLocaleString('zh-CN')));
    cards.append(card);
  };
  add('注册用户', data.users, () => { userQuery = {}; open('users'); });
  add('近 7 天新增', data.newUsers7Days);
  add('有效会员', data.activeMembers);
  add('失败诊断任务', data.failedTasks, () => { taskQuery = { status: 'failed' }; open('tasks'); });
  add('用量待核对', data.pendingUsage, () => { taskQuery = { usageStatus: 'pending' }; open('tasks'); });
  result.append(cards, element('p', '统计来自当前服务已保存的记录。时间按北京时间显示。', 'help'));
}

function table<T>(page: AdminPage<T>, columns: string[], render: (row: T) => (Node | string)[]) {
  const scroll = element('div', undefined, 'table-scroll');
  if (page.items.length) {
    const view = element('table');
    const heading = view.createTHead().insertRow();
    for (const column of columns) {
      const cell = element('th', column);
      cell.scope = 'col';
      heading.append(cell);
    }
    const body = view.createTBody();
    for (const row of page.items) {
      const line = body.insertRow();
      for (const value of render(row)) line.insertCell().append(value);
    }
    scroll.append(view);
  } else {
    scroll.append(element('p', '没有符合条件的记录。', 'empty'));
  }
  const pagination = element('div', undefined, 'pagination');
  const last = Math.max(1, Math.ceil(page.total / page.pageSize));
  const go = (number: number) => {
    if (section === 'users') userQuery = { ...userQuery, page: number };
    else if (section === 'orders') orderQuery = { ...orderQuery, page: number };
    else taskQuery = { ...taskQuery, page: number };
    void refresh();
  };
  const previous = button('上一页', () => go(page.page - 1));
  previous.disabled = page.page <= 1;
  const next = button('下一页', () => go(page.page + 1));
  next.disabled = page.page >= last;
  pagination.append(element('span', `共 ${page.total} 条 · 第 ${page.page} 页`), previous, next);
  result.append(scroll, pagination);
}

function lines(...values: (Node | string)[]) {
  const group = element('div', undefined, 'lines');
  group.append(...values.map(value => typeof value === 'string' ? element('span', value) : value));
  return group;
}

function renderUsers(page: AdminPage<AdminUser>) {
  table(page, ['用户', '绑定邮箱', '绑定手机号', '会员记录', '工作台权限', 'AI 周额度'], user => {
    const details = element('details');
    details.append(element('summary', `当前生效：${planNames[user.workbench.planId]}`), lines(...workbenchFeatures.map(key =>
      `${workbenchFeatureNames[key]}：${user.workbench.features[key] ? '已解锁' : '未解锁'}`)));
    const remaining = user.quota.remainingPercent;
    return [
      lines(element('code', user.id), `注册：${formatTime(user.createdAt)}`,
        ...(user.wechat ? ['已绑定微信'] : []),
        button('查看订单', () => { orderQuery = { userId: user.id }; open('orders'); }, 'link'),
        button('查看诊断', () => { taskQuery = { query: user.id }; open('tasks'); }, 'link')),
      user.email ? lines(user.email.address, user.email.verified ? '已验证' : '待验证') : '未绑定',
      user.phone ?? '未绑定',
      user.membership ? lines(`${planNames[user.membership.planId]} · ${eventNames[user.membership.latestEvent]}`,
        `生效：${formatTime(user.membership.startsAt)}`, `到期：${formatTime(user.membership.expiresAt)}`) : '无会员记录',
      details,
      lines(remaining === null ? (user.quota.status === 'inactive' ? '当前无有效会员' : '尚未启用') : `剩余 ${remaining}%`,
        ...(user.quota.resetsAt ? [`${user.quota.resetsAt === user.quota.expiresAt ? '本期有效至' : '刷新'}：${formatTime(user.quota.resetsAt)}`] : []),
        ...(user.quota.pending ? ['有处理中或待核对用量'] : [])),
    ];
  });
}

function renderOrders(page: AdminPage<AdminOrder>) {
  result.append(element('p', '显示本站保存的订单和对应的会员开通记录。已支付但找不到对应开通记录时显示「待核对」。', 'help'));
  table(page, ['订单', '套餐与金额', '渠道与状态', '会员到账', '订单时间', '退款'], order => {
    const activation = order.membershipActivation;
    return [
      lines(element('code', order.id), button(order.userId, () => { userQuery = { query: order.userId }; open('users'); }, 'link')),
      lines(`${planNames[order.planId]}会员`, formatAmount(order.amountCents)),
      lines(channelNames[order.channel], orderStatuses[order.status]),
      order.refund?.status === 'succeeded' ? '本单权益已撤销'
        : activation ? lines(`已记录 · ${eventNames[activation.kind]}`, `周期开始 ${formatTime(activation.startsAt)}`,
          `周期结束 ${formatTime(activation.expiresAt)}`) : order.status === 'paid' ? '待核对' : '—',
      lines(`创建 ${formatTime(order.createdAt)}`, ...(order.paidAt ? [`支付 ${formatTime(order.paidAt)}`] : []),
        ...(order.status === 'pending' ? [`支付截止 ${formatTime(order.expiresAt)}`] : [])),
      renderRefund(order),
    ];
  });
}

function formatAmount(cents: number) {
  const whole = Math.floor(cents / 100).toLocaleString('zh-CN');
  return `¥${whole}.${String(cents % 100).padStart(2, '0')}`;
}

function renderRefund(order: AdminOrder): Node | string {
  const refund = order.refund;
  if (!refund) return order.refundable ? button('退款', () => void reviewRefund(order.id))
    : order.status === 'paid' ? '暂不可退款' : '—';
  const view = lines(refundNames[refund.status], `申请 ${formatTime(refund.createdAt)}`,
    ...(refund.confirmedAt ? [`确认成功 ${formatTime(refund.confirmedAt)}`] : []));
  if (order.refundable && !['succeeded', 'closed'].includes(refund.status)) {
    view.append(button('查询退款结果', () => void refreshRefund(order.id), 'link'));
    if (['requested', 'unknown'].includes(refund.status)) {
      view.append(button('重试同一退款', () => void refreshRefund(order.id, true), 'link'));
    }
  }
  return view;
}

async function refreshRefund(orderId: string, retry?: true) {
  if (refundBusy) return;
  refundBusy = true;
  const current = generation;
  notice.textContent = '正在核对支付渠道…';
  try {
    const refund = await api<AdminRefund>('orders/refund-refresh', { orderId, retry });
    if (current === generation) {
      await refresh();
      if (generation === current + 1 && section === 'orders') notice.textContent = refundNames[refund.status];
    }
  } catch (error) {
    if (current === generation) notice.textContent = editorError(error);
  } finally { refundBusy = false; }
}

async function reviewRefund(orderId: string) {
  if (refundBusy) return;
  refundBusy = true;
  const current = generation;
  notice.textContent = '正在生成退款预览…';
  let preview: AdminRefundPreview;
  try { preview = await api<AdminRefundPreview>('orders/refund-preview', { orderId }); }
  catch (error) {
    if (current === generation) notice.textContent = editorError(error);
    return;
  } finally { refundBusy = false; }
  if (current !== generation) return;
  notice.textContent = '';
  const dialog = element('dialog', undefined, 'content-panel refund-dialog');
  const heading = element('h2', '核对全额退款');
  heading.id = 'refund-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  const plan = ({ planId, expiresAt }: AdminRefundPreview['before']) =>
    `${planNames[planId]}会员${expiresAt ? ` · 到期 ${formatTime(expiresAt)}` : ''}`;
  const remaining = element('ul');
  for (const period of preview.remaining) remaining.append(element('li',
    `${planNames[period.planId]}会员 · ${formatTime(period.startsAt)} 至 ${formatTime(period.expiresAt)}`));
  const feedback = element('p', '', 'help');
  feedback.setAttribute('role', 'status');
  const checked = element('input');
  checked.type = 'checkbox';
  const acknowledgement = element('label', undefined, 'content-confirmation');
  acknowledgement.append(checked, element('span', '我已核对退款金额和会员变化。'));
  const cancel = button('返回', () => dialog.close());
  const confirm = button('确认原路退款', () => void apply(), 'primary');
  confirm.disabled = true;
  checked.addEventListener('change', () => { confirm.disabled = !checked.checked; });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('cancel', event => { if (refundBusy) event.preventDefault(); });
  const actions = element('div', undefined, 'content-actions');
  actions.append(cancel, confirm);
  dialog.append(heading, element('p', `订单 ${preview.orderId} · 用户 ${preview.userId}`),
    element('p', `${channelNames[preview.channel]}原路退回 ${formatAmount(preview.amountCents)}`),
    element('p', `当前 ${plan(preview.before)} → 退款成功后 ${plan(preview.after)}`),
    ...(preview.remaining.length ? [element('h3', '保留的已付周期'), remaining] : []),
    acknowledgement, feedback, actions);
  result.append(dialog);
  dialog.showModal();

  async function apply() {
    if (!checked.checked || refundBusy) return;
    refundBusy = true;
    checked.disabled = cancel.disabled = confirm.disabled = true;
    feedback.textContent = '正在提交退款…';
    try {
      const refund = await api<AdminRefund>('orders/refund-apply', { orderId, previewId: preview.id, confirmed: true });
      dialog.close();
      if (current === generation) {
        await refresh();
        if (generation === current + 1 && section === 'orders') notice.textContent = refundNames[refund.status];
      }
    } catch (error) {
      if (current === generation) feedback.textContent = editorError(error);
    } finally {
      refundBusy = false;
      checked.disabled = cancel.disabled = confirm.disabled = false;
    }
  }
}

function renderTasks(page: AdminPage<AdminTask>) {
  table(page, ['任务与用户', '诊断方式', '任务状态', '用量状态', '时间'], task => [
    lines(element('code', task.id),
      button(task.userId, () => { userQuery = { query: task.userId }; open('users'); }, 'link'),
      ...(task.resumeRevision === null ? [] : [`简历修订 ${task.resumeRevision}`])),
    task.engine === 'rules' ? '本地规则' : '百炼模型',
    lines(task.status ? statusNames[task.status] : '仅保留用量记录',
      ...(task.errorCode ? [element('code', task.errorCode)] : [])),
    task.usageStatus ? usageNames[task.usageStatus] : '—',
    lines(`创建：${formatTime(task.createdAt)}`, `更新：${formatTime(task.updatedAt)}`),
  ]);
}

function setupSelect<T extends string>(select: HTMLSelectElement, values: readonly T[], names: Record<T, string>) {
  select.add(new Option('全部', ''));
  for (const value of values) select.add(new Option(names[value], value));
}
setupSelect(statusSelect, adminTaskStatuses, statusNames);
setupSelect(usageSelect, adminUsageStatuses, usageNames);
setupSelect(orderStatusSelect, paymentOrderStatuses, orderStatuses);
setupSelect(orderChannelSelect, paymentChannels, channelNames);

for (const item of nav) item.addEventListener('click', () => open(item.dataset.section as Section));
for (const item of viewButtons) item.addEventListener('click', () => {
  const next = item.dataset.userView as 'users' | 'orders';
  if (section === next) return;
  if (next === 'orders') orderQuery = {};
  open(next);
});
document.querySelector('#refresh')!.addEventListener('click', () => open(section));
window.addEventListener('beforeunload', event => {
  if (contentEditor?.hasChanges()) { event.preventDefault(); event.returnValue = ''; }
});
search.addEventListener('submit', event => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (section === 'users') userQuery = { query };
  else if (section === 'orders') orderQuery = { userId: orderQuery.userId, query,
    status: paymentOrderStatuses.find(value => value === orderStatusSelect.value),
    channel: paymentChannels.find(value => value === orderChannelSelect.value) };
  else taskQuery = { query, status: adminTaskStatuses.find(value => value === statusSelect.value),
    usageStatus: adminUsageStatuses.find(value => value === usageSelect.value) };
  void refresh();
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = loginForm.querySelector('button')!;
  submit.disabled = true;
  loginMessage.textContent = '正在登录…';
  const fields = new FormData(loginForm);
  try {
    await api('login', { email: fields.get('email'), password: fields.get('password') });
    loginForm.reset();
    open('overview');
  } catch (error) {
    loginMessage.textContent = errorMessage(error);
    loginForm.querySelector<HTMLInputElement>('[name=password]')!.value = '';
  } finally {
    submit.disabled = false;
  }
});

const logout = document.querySelector<HTMLButtonElement>('#logout')!;
logout.addEventListener('click', async () => {
  if (contentEditor && !contentEditor.canLeave()) return;
  logout.disabled = true;
  try {
    await api('logout', {});
    userQuery = {};
    orderQuery = {};
    taskQuery = {};
    queryInput.value = '';
    showLogin('已退出管理员会话。');
  } catch (error) {
    notice.textContent = errorMessage(error);
  } finally {
    logout.disabled = false;
  }
});

void fetch('/api/v1/environment', { cache: 'no-store' }).then(async response => {
  if (!response.ok) return;
  const { data } = await response.json() as ApiResponse<{ environment: 'test' | 'public' }>;
  if (data?.environment !== 'test' && data?.environment !== 'public') return;
  const environment = data.environment === 'test' ? '测试环境' : '公开环境';
  document.querySelector('.brand small')!.textContent = `${environment} · 管理后台`;
  document.title = `简历有方 · ${environment}管理后台`;
}).catch(() => undefined);
open('overview');
