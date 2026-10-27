import { computed, ref } from 'vue';
import type { Resume, ResumeVersion, ResumeVersionSummary, RestoreResumeInput, RestoreResumeResult } from '../../shared/types';
import { api, ApiError } from './api';

export function useResumeHistory() {
  const current = ref<Resume>();
  const versions = ref<ResumeVersionSummary[]>([]);
  const selected = ref<ResumeVersion>();
  const loading = ref(false), detailLoading = ref(false), busy = ref(false), reviewed = ref(false);
  const error = ref('');
  const sameContent = computed(() => !!current.value && !!selected.value && current.value.title === selected.value.snapshot.title && current.value.targetRole === selected.value.snapshot.targetRole && current.value.text === selected.value.snapshot.text);
  const incomplete = computed(() => !!selected.value && /\[请填写真实[^\]]*\]/.test(selected.value.snapshot.text));
  let loadRequest = 0, detailRequest = 0, disposed = false;
  let submission: { resumeId: string; sourceRevision: number; input: RestoreResumeInput } | undefined;
  function clearReview() { reviewed.value = false; submission = undefined; }
  async function choose(revision: number) {
    const owner = current.value;
    if (!owner || busy.value) return;
    const request = ++detailRequest;
    clearReview(); selected.value = undefined; detailLoading.value = true; error.value = '';
    try {
      const version = await api.version(owner.id, revision);
      if (!disposed && request === detailRequest && current.value?.id === owner.id) selected.value = version;
    } catch (cause) { if (!disposed && request === detailRequest) error.value = cause instanceof Error ? cause.message : '无法读取历史版本，请重试。'; }
    finally { if (!disposed && request === detailRequest) detailLoading.value = false; }
  }
  async function load(resumeId: string) {
    if (busy.value) return;
    const request = ++loadRequest;
    ++detailRequest; clearReview(); current.value = undefined; selected.value = undefined; versions.value = [];
    loading.value = true; detailLoading.value = false; error.value = '';
    try {
      const [resume, list] = await Promise.all([api.resume(resumeId), api.versions(resumeId)]);
      if (disposed || request !== loadRequest) return;
      current.value = resume; versions.value = list;
      const initial = list.find(item => item.revision !== resume.revision) ?? list[0];
      if (initial) await choose(initial.revision);
    } catch (cause) { if (!disposed && request === loadRequest) error.value = cause instanceof Error ? cause.message : '无法读取版本记录，请重试。'; }
    finally { if (!disposed && request === loadRequest) loading.value = false; }
  }
  async function restore(): Promise<RestoreResumeResult | undefined> {
    if (busy.value || loading.value || detailLoading.value || !current.value || !selected.value || !reviewed.value || sameContent.value || incomplete.value) return;
    if (!submission) submission = {
      resumeId: current.value.id, sourceRevision: selected.value.revision,
      input: { revision: current.value.revision, confirmed: true, idempotencyKey: `restore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}` },
    };
    busy.value = true; error.value = '';
    try {
      const result = await api.restoreVersion(submission.resumeId, submission.sourceRevision, submission.input);
      if (disposed) return;
      clearReview();
      return result;
    } catch (cause) {
      if (disposed) return;
      error.value = cause instanceof Error ? cause.message : '恢复未完成，请重试。';
      // A transport failure may have committed: retain the same request for a safe retry.
      if (cause instanceof ApiError && cause.status !== 0 && cause.status < 500) clearReview();
    } finally { if (!disposed) busy.value = false; }
  }
  function dispose() { disposed = true; ++loadRequest; ++detailRequest; }
  return { current, versions, selected, loading, detailLoading, busy, reviewed, error, sameContent, incomplete, load, choose, restore, dispose };
}
