import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { accountAvatarIdPattern, accountAvatarMaxBytes, accountAvatarMaxSide, isAccountNickname } from '../shared/auth.js';
import { HttpError, invalid } from './errors.js';
import type { JsonStore } from './store.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const validSize = (width: number, height: number) => width > 0 && height > 0 && width <= accountAvatarMaxSide && height <= accountAvatarMaxSide;

function avatarType(bytes: Buffer): 'image/png' | 'image/jpeg' | undefined {
  if (bytes.length < 32 || bytes.length > accountAvatarMaxBytes) return;
  if (bytes.subarray(0, 8).equals(pngSignature)) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || !validSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return;
    let data = false;
    for (let offset = 33; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const chunk = bytes.toString('ascii', offset + 4, offset + 8);
      offset += size + 12;
      if (offset > bytes.length) return;
      if (chunk === 'IDAT' && size) data = true;
      if (chunk === 'IEND') return data && size === 0 && offset === bytes.length ? 'image/png' : undefined;
    }
    return;
  }
  if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  let frame = false;
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 >= bytes.length) return;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length - 2) return;
    if (marker === 0xda) return frame ? 'image/jpeg' : undefined;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8 || frame || !validSize(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return;
      frame = true;
    }
    offset += size;
  }
}

function avatarBytes(value: unknown) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(accountAvatarMaxBytes / 3)
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid('头像文件超过限制或格式无效。');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || !avatarType(bytes)) invalid('请选择 512 像素以内、128 KB 以下的 JPG 或 PNG 头像。');
  return bytes;
}

/** Store one current avatar per user. Only that user's session can read it. */
export class AccountProfiles {
  private readonly directory: string;

  constructor(private readonly store: JsonStore) {
    this.directory = join(dirname(store.path), 'account-avatars');
  }

  private file(id: string) { return join(this.directory, id + '.img'); }

  async update(userId: string, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求体必须是 JSON 对象。');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['nickname', 'avatar'].includes(key)) || !Object.hasOwn(input, 'nickname')) {
      invalid('个人资料含不支持的字段。');
    }
    const nickname = typeof input.nickname === 'string' ? input.nickname.trim().normalize('NFC') : input.nickname;
    if (nickname !== null && !isAccountNickname(nickname)) invalid('昵称需为 1 至 24 个字符。');
    const avatar = input.avatar == null ? input.avatar : avatarBytes(input.avatar);
    const id = avatar ? randomUUID() : undefined;
    let created = false;
    try {
      const { user, replaced } = await this.store.mutate(async database => {
        const current = database.users.find(candidate => candidate.id === userId);
        if (!current) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录。');
        const replaced = avatar !== undefined ? current.avatarId : undefined;
        if (avatar && id) {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await writeFile(this.file(id), avatar, { flag: 'wx', mode: 0o600 });
          created = true;
          current.avatarId = id;
        } else if (avatar === null) delete current.avatarId;
        if (nickname === null) delete current.nickname;
        else current.nickname = nickname;
        return { user: current, replaced };
      });
      if (replaced) await unlink(this.file(replaced)).catch(() => undefined);
      return user;
    } catch (error) {
      if (id && created) await unlink(this.file(id)).catch(() => undefined);
      throw error;
    }
  }

  async read(userId: string, id: string) {
    const missing = () => new HttpError(404, 'AVATAR_NOT_FOUND', '头像不存在或已更新。');
    if (!accountAvatarIdPattern.test(id) || !(await this.store.read()).users.some(user => user.id === userId && user.avatarId === id)) {
      throw missing();
    }
    const bytes = await readFile(this.file(id)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
      throw error;
    });
    const mime = avatarType(bytes);
    if (!mime) throw missing();
    return { bytes, mime };
  }
}
