import { createHash } from 'node:crypto';
import type {
  CareerAttachment, CareerContentAction, CareerContentDetail, CareerContentKind, CareerContentReceipt, CareerContentReview,
  CareerContentSummary, CareerContentValue, ReviewCareerContent,
} from '../shared/types.js';
import { careerCatalogFits, careerCatalogLocation, loadCareerCatalog, publishedCareerCatalog, type CareerCatalog } from './career-catalog.js';
import {
  careerContentHashPattern, careerContentKey, careerContentNewId, careerContentValue, careerContentVersion,
  careerHistoryMaxBytes, careerMedia, projectCareerContent, type CareerAttachmentIndex, type CareerContentChange, type StoredCareerContent,
} from './career-content-storage.js';
import { careerObject } from './career-validation.js';
import { CareerFiles, validateCareerAttachment } from './career-files.js';
import { careerFileFallbackText } from '../shared/career-attachment.js';
import { HttpError, invalid, notFound } from './errors.js';
import type { JsonStore } from './store.js';

type Target = { kind: CareerContentKind; id: string };
type Context = ReturnType<typeof inspect>;
type ChangeInput = { action: 'draft'; content: CareerContentValue; attachment?: CareerAttachment } | { action: 'restore'; sourceVersion: number }
  | { action: 'publish' | 'withdraw' };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const title = (value: CareerContentValue) => 'title' in value ? value.title : value.organization;

function revision(value: unknown): string {
  if (typeof value !== 'string' || !careerContentHashPattern.test(value)) invalid('资料修订标识无效。');
  return value;
}

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) invalid('操作标识无效。');
  return value;
}

function inspect(base: CareerCatalog, entries: StoredCareerContent[], target: Target, attachments: CareerAttachmentIndex) {
  const { kind, id } = target;
  const entry = entries.find(item => item.kind === kind && item.id === id);
  const original = (kind === 'material' ? base.materials : base.portals).find(item => item.id === id) ?? null;
  const projected = projectCareerContent(entry, attachments);
  const live = projected.published === undefined ? original : projected.published;
  const stamp = hash([kind, id, entry?.changes.length ?? 0, live, projected.draft]);
  return { ...projected, entry, original, live, stamp };
}

function checkRevision(context: Context, expected: string | null, id: string) {
  const current = context.entry || context.original ? context.stamp : null;
  if (current !== expected) throw new HttpError(409, 'CAREER_CONTENT_CONFLICT', '资料已变化，请重新打开并核对最新版本。');
  if (current === null && !careerContentNewId.test(id)) invalid('新建资料的标识无效。');
}

function reviewInput(input: Record<string, unknown>): ReviewCareerContent {
  const action = input.action;
  if (action !== 'publish' && action !== 'withdraw' && action !== 'restore') invalid('发布操作无效。');
  if (action === 'restore') return { revision: revision(input.revision), action, sourceVersion: careerContentVersion(input.sourceVersion) };
  if (Object.hasOwn(input, 'sourceVersion')) invalid('只有回滚操作可以指定历史版本。');
  return { revision: revision(input.revision), action };
}

function proposedContent(context: Context, action: CareerContentAction, sourceVersion?: number): CareerContentValue | null {
  if (action === 'publish' && context.draft) return context.draft;
  if (action === 'withdraw' && context.live) return null;
  if (action === 'restore' && context.activeVersion !== null && sourceVersion !== undefined && sourceVersion !== context.activeVersion) {
    const version = context.versions.get(sourceVersion);
    if (version) return version;
  }
  throw new HttpError(409, 'CAREER_CONTENT_ACTION_UNAVAILABLE', '当前没有可发布的草稿、可下架的内容或指定的历史版本。');
}

function releaseReview(base: CareerCatalog, entries: StoredCareerContent[], target: Target, context: Context,
  input: ReviewCareerContent, attachments: CareerAttachmentIndex): CareerContentReview {
  checkRevision(context, input.revision, target.id);
  const proposed = proposedContent(context, input.action, input.sourceVersion);
  const current = publishedCareerCatalog(base, entries, attachments);
  const next = {
    ...current,
    materials: target.kind === 'material'
      ? [...current.materials.filter(item => item.id !== target.id), ...(proposed && 'title' in proposed ? [proposed] : [])] : current.materials,
    portals: target.kind === 'portal'
      ? [...current.portals.filter(item => item.id !== target.id), ...(proposed && 'organization' in proposed ? [proposed] : [])] : current.portals,
  };
  if (!careerCatalogFits(next)) invalid('发布后的目录超出容量限制，请缩短正文或先下架不再使用的内容。');
  return { live: context.live, proposed, token: hash([input, proposed]) };
}

export class AdminCareerContent {
  private readonly location: ReturnType<typeof careerCatalogLocation>;
  constructor(private readonly store: JsonStore, catalogPath?: string, private readonly files = new CareerFiles(store.path)) {
    this.location = careerCatalogLocation(store.path, catalogPath);
  }

  private async base() {
    const catalog = await loadCareerCatalog(this.location.path, this.location.fallback);
    if (catalog.state === 'unavailable') throw new HttpError(503, 'CAREER_CATALOG_UNAVAILABLE', '当前底稿目录无法读取，请先修复目录。');
    return catalog;
  }

  async list(): Promise<CareerContentSummary[]> {
    const [database, base] = await Promise.all([this.store.read(), this.base()]);
    const attachments = careerMedia(database);
    const rows = new Map<string, CareerContentSummary>();
    const add = (kind: CareerContentKind, item: CareerContentValue) => rows.set(careerContentKey(kind, item.id),
      { kind, id: item.id, title: title(item), live: true, hasDraft: false });
    for (const item of base.materials) add('material', item);
    for (const item of base.portals) add('portal', item);
    for (const entry of database.careerContent) {
      const { kind, id } = entry;
      const key = careerContentKey(kind, id);
      const { draft, published, versions } = projectCareerContent(entry, attachments);
      const previous = rows.get(key);
      const latest = draft ?? published ?? [...versions.values()].reverse().find(value => value !== null);
      rows.set(key, { kind, id, title: latest ? title(latest) : previous?.title ?? id,
        live: published === undefined ? previous !== undefined : published !== null, hasDraft: draft !== null });
    }
    return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  }

  async detail(target: Target): Promise<CareerContentDetail> {
    const [database, base] = await Promise.all([this.store.read(), this.base()]);
    const { entry, original, stamp, live, draft, activeVersion } = inspect(base, database.careerContent, target, careerMedia(database));
    if (!entry && !original) notFound('求职内容');
    return { ...target, revision: stamp, live, draft, activeVersion, baselineAvailable: !!entry?.baseline,
      history: (entry?.changes ?? []).map(({ action, actorId, at, ...change }, index) => ({
        version: index + 1, action, actorId, at,
        ...('sourceVersion' in change ? { sourceVersion: change.sourceVersion } : {}),
      })).reverse() };
  }

  async saveDraft(target: Target, body: unknown, actorId: string): Promise<CareerContentReceipt> {
    const input = careerObject(body, ['revision', 'operationId', 'content']);
    const expected = input.revision === null ? null : revision(input.revision);
    const key = operationId(input.operationId);
    const { attachment: rawAttachment, ...raw } = careerObject(input.content, target.kind === 'material'
      ? ['title', 'major', 'role', 'summary', 'content', 'sourceLabel', 'sourceUrl', 'attachment']
      : ['organization', 'majors', 'audience', 'description', 'sourceUrl', 'checkedAt']);
    const attachment = rawAttachment === undefined ? undefined : validateCareerAttachment(rawAttachment);
    const now = new Date();
    const fallback = attachment && (raw.content === undefined || (typeof raw.content === 'string' && !raw.content.trim()));
    const content = careerContentValue(target.kind, target.id, { ...raw, id: target.id, ...(fallback ? { content: careerFileFallbackText } : {}),
      ...(target.kind === 'material' ? { updatedAt: now.toISOString() } : {}) });
    if ('checkedAt' in content && Date.parse(content.checkedAt) > now.getTime()) invalid('入口核查时间不能晚于当前时间。');
    const comparable = 'updatedAt' in content ? { ...content, updatedAt: undefined } : content;
    return this.commit(target, actorId, key, hash(['draft', target, expected, comparable, ...(attachment ? [attachment] : [])]), async (_base, _entries, context) => {
      checkRevision(context, expected, target.id);
      if (attachment) await this.files.verify(attachment);
      return { action: 'draft', content, attachment };
    });
  }

  async preview(target: Target, body: unknown): Promise<CareerContentReview> {
    const input = reviewInput(careerObject(body, ['revision', 'action', 'sourceVersion']));
    const [database, base] = await Promise.all([this.store.read(), this.base()]);
    const { careerContent } = database;
    const attachments = careerMedia(database);
    const review = releaseReview(base, careerContent, target, inspect(base, careerContent, target, attachments), input, attachments);
    await this.verifyReview(review);
    return review;
  }

  private async verifyReview({ proposed }: CareerContentReview) {
    if (proposed && 'title' in proposed && proposed.attachment) await this.files.verify(proposed.attachment);
  }

  async apply(target: Target, body: unknown, actorId: string): Promise<CareerContentReceipt> {
    const raw = careerObject(body, ['revision', 'action', 'sourceVersion', 'token', 'operationId', 'confirmed']);
    const input = reviewInput(raw);
    const key = operationId(raw.operationId);
    const token = revision(raw.token);
    if (raw.confirmed !== true) invalid('请核对对照预览并确认本次操作。');
    return this.commit(target, actorId, key, hash([target, input, token]), async (base, entries, context, attachments) => {
      const review = releaseReview(base, entries, target, context, input, attachments);
      if (review.token !== token) throw new HttpError(409, 'CAREER_CONTENT_REVIEW_CHANGED', '预览已失效，请重新核对后提交。');
      await this.verifyReview(review);
      return input.action === 'restore' ? { action: 'restore', sourceVersion: input.sourceVersion! } : { action: input.action };
    });
  }

  private async commit(target: Target, actorId: string, key: string, requestHash: string,
    changeFor: (base: CareerCatalog, entries: StoredCareerContent[], context: Context, attachments: CareerAttachmentIndex) => Promise<ChangeInput>): Promise<CareerContentReceipt> {
    const replay = (entries: StoredCareerContent[]) => {
      for (const entry of entries) {
        const index = entry.changes.findIndex(change => change.operationId === key);
        if (index === -1) continue;
        const previous = entry.changes[index];
        if (previous.actorId !== actorId || previous.requestHash !== requestHash) {
          throw new HttpError(409, 'CAREER_CONTENT_OPERATION_CONFLICT', '操作标识已用于其他请求。');
        }
        return { version: index + 1 };
      }
    };
    const previous = replay((await this.store.read()).careerContent);
    if (previous) return previous;
    return this.store.mutate(async database => {
      const { careerContent, careerAttachments, careerVideos } = database;
      const repeated = replay(careerContent);
      if (repeated) return repeated;
      const base = await this.base();
      const attachments = careerMedia(database);
      const context = inspect(base, careerContent, target, attachments);
      const requested = await changeFor(base, careerContent, context, attachments);
      if (requested.action === 'draft' && requested.attachment) {
        const index = requested.attachment.format === 'mp4' ? careerVideos : careerAttachments;
        index[key] = requested.attachment;
      }
      const change: CareerContentChange = { ...(requested.action === 'draft' ? { action: requested.action, content: requested.content } : requested),
        actorId, operationId: key, requestHash, at: new Date().toISOString() };
      const entry = context.entry ?? { ...target, baseline: context.original, changes: [] };
      if (!context.entry) careerContent.push(entry);
      entry.changes.push(change);
      if (Buffer.byteLength(JSON.stringify([careerContent, careerAttachments, careerVideos])) > careerHistoryMaxBytes) {
        throw new HttpError(409, 'CAREER_CONTENT_HISTORY_FULL', '操作历史已达存储上限，暂时无法保存新版本。');
      }
      return { version: entry.changes.length };
    });
  }
}
