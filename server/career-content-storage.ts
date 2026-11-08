import { careerContentKinds, type CareerContentAction, type CareerContentKind, type CareerContentValue } from '../shared/career-content.js';
import { careerId, careerObject, validateCatalogMaterial, validateRecruitmentPortal } from './career-validation.js';
import { invalid } from './errors.js';
import { quotaIdentifier, quotaInstant } from './quota-storage.js';

interface Operation { operationId: string; requestHash: string; actorId: string; at: string }
export type CareerContentChange = Operation & (
  { action: 'draft'; content: CareerContentValue }
  | { action: Exclude<CareerContentAction, 'restore'> }
  | { action: 'restore'; sourceVersion: number }
);

export interface StoredCareerContent {
  kind: CareerContentKind;
  id: string;
  baseline: CareerContentValue | null;
  changes: CareerContentChange[];
}

export const careerHistoryMaxBytes = 16 * 1024 * 1024;
export const careerContentHashPattern = /^[a-f0-9]{64}$/;
export const careerContentNewId = /^admin-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const careerContentKey = (kind: CareerContentKind, id: string) => `${kind}/${id}`;

export function careerContentKind(value: unknown): CareerContentKind {
  const kind = careerContentKinds.find(kind => kind === value);
  if (!kind) invalid('资料类型无效。');
  return kind;
}

export function careerContentVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('历史版本无效。');
  return value;
}

export function careerContentValue(kind: CareerContentKind, id: string, value: unknown): CareerContentValue {
  const item = kind === 'material' ? validateCatalogMaterial(value) : validateRecruitmentPortal(value);
  if (item.id !== id) invalid('内容标识不一致。');
  return item;
}

export function projectCareerContent(entry?: StoredCareerContent) {
  let draft: CareerContentValue | null = null;
  let activeVersion: number | null = null;
  const versions = new Map<number, CareerContentValue | null>([[0, entry?.baseline ?? null]]);
  entry?.changes.forEach((change, index) => {
    switch (change.action) {
      case 'draft':
        draft = change.content;
        return;
      case 'publish':
        if (!draft) throw new Error('Missing career content draft.');
        versions.set(index + 1, draft);
        draft = null;
        break;
      case 'withdraw':
        versions.set(index + 1, null);
        break;
      case 'restore': {
        const source = versions.get(change.sourceVersion);
        if (activeVersion === null || change.sourceVersion === activeVersion || !source) {
          throw new Error('Invalid career content restoration.');
        }
        versions.set(index + 1, source);
        break;
      }
    }
    activeVersion = index + 1;
  });
  return { draft, activeVersion, versions, published: activeVersion === null ? undefined : versions.get(activeVersion) ?? null };
}

export function normalizeCareerContent(value: unknown): StoredCareerContent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > careerHistoryMaxBytes) throw new Error('Invalid career content history.');
  const keys = new Set<string>();
  const operations = new Set<string>();
  return value.map(raw => {
    const item = careerObject(raw, ['kind', 'id', 'baseline', 'changes']);
    const kind = careerContentKind(item.kind), id = careerId(item.id);
    const key = careerContentKey(kind, id);
    if (keys.has(key) || !Array.isArray(item.changes) || !item.changes.length) throw new Error('Invalid career content history.');
    keys.add(key);
    const baseline = item.baseline === null ? null : careerContentValue(kind, id, item.baseline);
    const changes = item.changes.map((raw): CareerContentChange => {
      const change = careerObject(raw, ['action', 'operationId', 'requestHash', 'actorId', 'at', 'content', 'sourceVersion']);
      if (!quotaIdentifier(change.operationId) || operations.has(change.operationId)
        || typeof change.requestHash !== 'string' || !careerContentHashPattern.test(change.requestHash)
        || !quotaIdentifier(change.actorId) || !quotaInstant(change.at)) throw new Error('Invalid career content audit record.');
      operations.add(change.operationId);
      const common = { operationId: change.operationId, requestHash: change.requestHash, actorId: change.actorId, at: change.at };
      if (change.action === 'draft' && !Object.hasOwn(change, 'sourceVersion')) {
        return { ...common, action: 'draft', content: careerContentValue(kind, id, change.content) };
      }
      if (change.action === 'restore' && !Object.hasOwn(change, 'content')) {
        return { ...common, action: 'restore', sourceVersion: careerContentVersion(change.sourceVersion) };
      }
      if ((change.action === 'publish' || change.action === 'withdraw') && !Object.hasOwn(change, 'content') && !Object.hasOwn(change, 'sourceVersion')) {
        return { ...common, action: change.action };
      }
      throw new Error('Invalid career content action.');
    });
    const entry = { kind, id, baseline, changes };
    projectCareerContent(entry);
    return entry;
  });
}
