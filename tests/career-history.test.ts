import assert from 'node:assert/strict';
import test from 'node:test';
import type { CareerAssistantResult, CareerJob, CompanySearchHit, Resume } from '../shared/types.js';
import { useCareerAssistant, type CareerChatMessage } from '../src/services/careerAssistant.js';
import { createCareerHistory, MAX_CAREER_HISTORY_CONVERSATIONS, MAX_CAREER_HISTORY_MESSAGES, type CareerConversationRecord, type CareerHistoryStorage } from '../src/services/careerAssistantHistory.js';

const resume: Resume = { id: 'synthetic-resume', title: '合成测试简历', targetRole: '后端开发', text: '合成测试项目使用 Java 完成接口开发。', revision: 3, createdAt: '2026-10-30T00:00:00+08:00', updatedAt: '2026-10-30T00:00:00+08:00' };
const company: CompanySearchHit = {
  id: 'synthetic-company', name: '合成测试企业', aliases: ['合成别名'], industries: ['合成测试行业'], nature: '合成测试性质', locations: ['合成测试城市'], directions: ['软件'],
  educationLevels: ['本科'], recruitmentTypes: ['校园招聘'], cohorts: ['2026届'], summary: '合成历史资料，不代表真实招聘。', verification: 'source-provided', updatedAt: resume.updatedAt,
  sources: [{ title: '合成测试来源', url: 'https://example.test/source', sheet: '测试表', rows: [5], snapshotHash: 'a'.repeat(64), importedAt: resume.updatedAt }], matchedFields: ['directions'],
};
const job: CareerJob = {
  id: 'synthetic-job', origin: 'personal', company: '合成测试企业', title: '合成测试岗位', major: '计算机', location: '合成测试城市',
  description: '合成测试岗位说明。', companyOverview: '', sourceLabel: '自行录入', availability: 'open', updatedAt: resume.updatedAt,
};
function result(): CareerAssistantResult {
  return {
    engine: 'local-rules', reply: '按文本查询到相关历史资料，请核对最新公告。',
    resume: { id: resume.id, title: resume.title, revision: resume.revision, inputHash: 'b'.repeat(64) },
    criteria: { query: '软件', filters: { locations: ['合成测试城市'] }, unverifiedRequirements: ['请核对当前是否在招'] },
    companies: [{ ...company }], companyTotal: 1, personalJobs: [{ ...job }], evidence: [{ term: 'Java', excerpt: '使用 Java 完成接口开发' }], catalogState: 'ready',
  };
}
function memoryStorage(): CareerHistoryStorage & { data: Map<string, string>; removed: string[] } {
  const data = new Map<string, string>(), removed: string[] = [];
  return {
    data, removed,
    get: key => data.get(key),
    set: (key, value) => { data.set(key, value); },
    remove: key => { removed.push(key); data.delete(key); },
  };
}
const message = (id: number, role: 'user' | 'assistant', content: string, withResult = false): CareerChatMessage =>
  ({ id, role, content, ...(withResult ? { result: result() } : {}) });
const record = (id: string, updatedAt: number, messages = [message(1, 'user', '帮我找合适的企业方向'), message(2, 'assistant', '按文本查询到相关历史资料。', true)]): CareerConversationRecord =>
  ({ id, title: '合成测试对话', updatedAt, messageCount: messages.length, requirements: '2027届 后端开发 合成测试城市', resumeId: resume.id, resumeRevision: resume.revision, messages });

test('history roundtrip compacts result cards, drops resume text and restores required fields', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  assert.equal(history.save(record('conversation-a', 1_000)), true);
  const listed = history.list();
  assert.equal(listed.length, 1);
  assert.deepEqual({ id: listed[0]?.id, title: listed[0]?.title, messageCount: listed[0]?.messageCount }, { id: 'conversation-a', title: '合成测试对话', messageCount: 2 });
  const raw = storage.data.get(`resume-youfang:career-assistant:v1:owner-a:chat:conversation-a`) ?? '';
  assert.equal(raw.includes(resume.text), false);
  assert.equal(raw.includes('合成测试来源'), false);
  const loaded = history.load('conversation-a');
  assert.equal(loaded?.requirements, '2027届 后端开发 合成测试城市');
  assert.deepEqual({ resumeId: loaded?.resumeId, resumeRevision: loaded?.resumeRevision }, { resumeId: resume.id, resumeRevision: resume.revision });
  assert.deepEqual(loaded?.messages.map(item => item.id), [1, 2]);
  const stored = loaded?.messages[1]?.result;
  assert.equal(stored?.reply, result().reply);
  assert.equal(stored?.companies[0]?.summary, company.summary);
  assert.equal(stored?.companies[0]?.recruitmentUrl, undefined);
  assert.deepEqual(stored?.companies[0]?.aliases, []);
  assert.deepEqual(stored?.companies[0]?.educationLevels, []);
  assert.deepEqual(stored?.companies[0]?.matchedFields, []);
  assert.deepEqual(stored?.companies[0]?.sources, []);
  assert.equal(stored?.personalJobs[0]?.origin, 'personal');
  assert.equal(stored?.personalJobs[0]?.title, job.title);
  assert.deepEqual(stored?.criteria.filters, { locations: ['合成测试城市'] });
  assert.equal(stored?.resume?.revision, resume.revision);
});

test('history isolates owners stored on the same device', () => {
  const storage = memoryStorage();
  const first = createCareerHistory('owner-a', storage), second = createCareerHistory('owner-b', storage);
  assert.equal(first.save(record('conversation-a', 1_000)), true);
  assert.equal(second.list().length, 0);
  assert.equal(second.load('conversation-a'), undefined);
  assert.equal([...storage.data.keys()].some(key => key.includes('owner-b')), false);
});

test('history keeps at most twelve conversations and removes the oldest record', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  for (let index = 1; index <= MAX_CAREER_HISTORY_CONVERSATIONS + 1; index += 1) {
    assert.equal(history.save(record(`conversation-${index}`, 1_000 + index)), true);
  }
  const listed = history.list();
  assert.equal(listed.length, MAX_CAREER_HISTORY_CONVERSATIONS);
  assert.equal(listed[0]?.id, `conversation-${MAX_CAREER_HISTORY_CONVERSATIONS + 1}`);
  assert.equal(listed.some(item => item.id === 'conversation-1'), false);
  assert.equal(history.load('conversation-1'), undefined);
  assert.equal(storage.removed.includes('resume-youfang:career-assistant:v1:owner-a:chat:conversation-1'), true);
});

test('history keeps only the latest thirty messages of a long conversation', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  const messages = Array.from({ length: MAX_CAREER_HISTORY_MESSAGES + 10 }, (_, index) => message(index + 1, index % 2 ? 'assistant' : 'user', `第 ${index + 1} 条消息`));
  assert.equal(history.save(record('conversation-long', 1_000, messages)), true);
  const loaded = history.load('conversation-long');
  assert.equal(loaded?.messages.length, MAX_CAREER_HISTORY_MESSAGES);
  assert.equal(loaded?.messages[0]?.content, '第 11 条消息');
  assert.equal(loaded?.messages.at(-1)?.content, `第 ${MAX_CAREER_HISTORY_MESSAGES + 10} 条消息`);
  assert.deepEqual(loaded?.messages.map(item => item.id), Array.from({ length: MAX_CAREER_HISTORY_MESSAGES }, (_, index) => index + 1));
});

test('history trims oversized payloads below the local storage guard', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  const heavyResult = result();
  heavyResult.companies = Array.from({ length: 5 }, (_, index) => ({ ...company, id: `synthetic-company-${index}`, summary: 'x'.repeat(1200) }));
  heavyResult.companyTotal = 5;
  heavyResult.personalJobs = Array.from({ length: 5 }, (_, index) => ({ ...job, id: `synthetic-job-${index}`, description: 'x'.repeat(1200) }));
  const heavy = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, role: 'assistant' as const, content: 'x'.repeat(200), result: heavyResult }));
  assert.equal(history.save(record('conversation-heavy', 1_000, heavy)), true);
  const key = [...storage.data.keys()].find(value => value.includes('chat:conversation-heavy'));
  assert.ok(key);
  assert.ok((storage.data.get(key!) ?? '').length <= 300_000);
  const loaded = history.load('conversation-heavy');
  assert.ok(loaded && loaded.messages.length <= MAX_CAREER_HISTORY_MESSAGES);
});

test('history ignores damaged index and record data instead of throwing', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  storage.set('resume-youfang:career-assistant:v1:owner-a:index', 'not json');
  assert.deepEqual(history.list(), []);
  storage.set('resume-youfang:career-assistant:v1:owner-a:chat:bad-record', '');
  storage.set('resume-youfang:career-assistant:v1:owner-a:index', JSON.stringify([{ id: 'bad-record' }, { id: 'missing-record', title: '合成测试', updatedAt: 1, messageCount: 2 }]));
  assert.deepEqual(history.list().map(item => item.id), ['missing-record']);
  assert.equal(history.load('bad-record'), undefined);
  assert.equal(history.load('missing-record'), undefined);
  storage.set('resume-youfang:career-assistant:v1:owner-a:chat:missing-record', JSON.stringify({ id: 'missing-record', title: '合成测试', updatedAt: 1, requirements: '', messages: [{ role: 'user', content: '' }] }));
  assert.equal(history.load('missing-record'), undefined);
});

test('history remove and clear delete both records and index entries', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  assert.equal(history.save(record('conversation-a', 1_000)), true);
  assert.equal(history.save(record('conversation-b', 2_000)), true);
  history.remove('conversation-a');
  assert.deepEqual(history.list().map(item => item.id), ['conversation-b']);
  assert.equal(history.load('conversation-a'), undefined);
  history.clear();
  assert.deepEqual(history.list(), []);
  assert.equal(history.load('conversation-b'), undefined);
  assert.equal(storage.data.has('resume-youfang:career-assistant:v1:owner-a:index'), false);
});

test('history save reports failure when local storage rejects the write', () => {
  const storage = memoryStorage(), history = createCareerHistory('owner-a', storage);
  storage.set = () => { throw new Error('quota exceeded'); };
  assert.equal(history.save(record('conversation-a', 1_000)), false);
  assert.deepEqual(history.list(), []);
  const indexOnly = memoryStorage();
  const indexFailure = createCareerHistory('owner-b', indexOnly);
  indexOnly.set = (key, value) => { if (key.endsWith(':index')) throw new Error('quota exceeded'); storage.set(key, value); };
  assert.equal(indexFailure.save(record('conversation-a', 1_000)), false);
  assert.equal(indexOnly.data.has('resume-youfang:career-assistant:v1:owner-b:chat:conversation-a'), false);
  assert.equal(indexOnly.data.has('resume-youfang:career-assistant:v1:owner-b:index'), false);
});

test('restoreConversation replaces the in-memory chat without a network request', () => {
  const assistant = useCareerAssistant();
  assistant.restoreConversation({ messages: [message(9, 'user', '历史问题'), message(9, 'assistant', '历史回答')], requirements: '历史要求', resume });
  assert.deepEqual(assistant.messages.value.map(item => item.id), [1, 2]);
  assert.equal(assistant.messages.value[0]?.content, '历史问题');
  assert.equal(assistant.requirements.value, '历史要求');
  assert.equal(assistant.selectedResume.value?.id, resume.id);
  assert.equal(assistant.loading.value, false);
  assert.equal(assistant.error.value, '');
  assistant.restoreConversation({ messages: [], requirements: '' });
  assert.equal(assistant.messages.value.length, 0);
  assert.equal(assistant.selectedResume.value, undefined);
});
