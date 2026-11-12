import {
  awaitImport, checkImportSignal, RESUME_IMPORT_CHUNK_BYTES, ResumeImportError, validateWechatResumeFile,
  type ImportedResume, type ImportSignal,
} from '../../shared/resume-import';
import { api, ApiError } from '../services/api';

// #ifdef MP-WEIXIN
declare const wx: {
  chooseMessageFile(options: UniNamespace.ChooseMessageFileOption): void;
  getFileSystemManager(): UniNamespace.FileSystemManager;
};

function chooseChatFile() {
  return new Promise<UniNamespace.ChooseFile | undefined>((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: result => resolve(result.tempFiles[0]),
      fail: ({ errMsg }) => {
        if (/cancel/i.test(errMsg)) resolve(undefined);
        else if (/not declared|privacy api banned/i.test(errMsg)) reject(new Error('微信暂未开放聊天文件选择，可在网页版导入手机文件。'));
        else if (/privacy|deny/i.test(errMsg)) reject(new Error('微信未授权选取文件，请同意隐私授权后重试。'));
        else reject(new Error('无法打开聊天文件，请重试或在网页版导入手机文件。'));
      },
    });
  });
}

function confirmUpload() {
  return new Promise<boolean>((resolve, reject) => {
    uni.showModal({
      title: '导入简历文件',
      content: '所选文件会临时上传以提取正文，解析结束后清理。',
      confirmText: '同意导入',
      success: result => resolve(result.confirm),
      fail: () => reject(new Error('暂时无法确认导入，请重试。')),
    });
  });
}

function readChunk(files: ReturnType<typeof wx.getFileSystemManager>, filePath: string, position: number, length: number) {
  return new Promise<string>((resolve, reject) => {
    const unreadable = () => reject(new Error('读取失败，请确认文件仍在微信聊天中或改用网页版。'));
    files.readFile({
      filePath, position, length, encoding: 'base64',
      success: result => typeof result.data === 'string' ? resolve(result.data) : unreadable(),
      fail: unreadable,
    });
  });
}

export async function selectWechatResumeFile({ signal, onParsing }: {
  signal: ImportSignal;
  onParsing: () => void;
}): Promise<ImportedResume | undefined> {
  checkImportSignal(signal);
  if (typeof wx === 'undefined' || !wx.chooseMessageFile || !wx.getFileSystemManager) {
    throw new ResumeImportError('unsupported-platform', '当前微信版本无法选取聊天文件，请更新微信或在网页版导入。');
  }
  const file = await awaitImport(chooseChatFile(), signal);
  if (!file) return;
  validateWechatResumeFile(file.name, file.size);
  if (!await awaitImport(confirmUpload(), signal)) return;
  onParsing();
  const { id } = await api.startResumeImport({ fileName: file.name, size: file.size }, signal);
  try {
    const files = wx.getFileSystemManager();
    for (let offset = 0; offset < file.size; offset += RESUME_IMPORT_CHUNK_BYTES) {
      checkImportSignal(signal);
      const length = Math.min(RESUME_IMPORT_CHUNK_BYTES, file.size - offset);
      const contentBase64 = await awaitImport(readChunk(files, file.path, offset, length), signal);
      const part = { offset, contentBase64 };
      try {
        await api.uploadResumeChunk(id, part, signal);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'NETWORK_ERROR') || signal.aborted) throw error;
        // A single retry is safe because the server compares duplicate chunks byte-for-byte.
        await api.uploadResumeChunk(id, part, signal);
      }
    }
    return await api.parseResumeImport(id, signal);
  } catch (error) {
    void api.cancelResumeImport(id).catch(() => undefined);
    throw error;
  }
}
// #endif
