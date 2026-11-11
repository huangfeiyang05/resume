import { accountAvatarMaxBytes, accountAvatarMaxSide } from '../../shared/auth';

const avatarError = '请选用 JPG 或 PNG 头像，或换一张较小的图片。';

// #ifdef MP-WEIXIN
function readWechatAvatar(path: string) {
  const files = uni.getFileSystemManager();
  return new Promise<string>((resolve, reject) => files.getFileInfo({
    filePath: path,
    success: ({ size }) => {
      if (size < 32 || size > accountAvatarMaxBytes) { reject(new Error(avatarError)); return; }
      files.readFile({
        filePath: path, encoding: 'base64',
        success: result => typeof result.data === 'string' ? resolve(result.data) : reject(new Error(avatarError)),
        fail: () => reject(new Error(avatarError)),
      });
    },
    fail: () => reject(new Error(avatarError)),
  }));
}

export async function prepareWechatAvatar(path: string) {
  const image = await new Promise<UniApp.GetImageInfoSuccessData>((resolve, reject) => uni.getImageInfo({
    src: path, success: resolve, fail: () => reject(new Error(avatarError)),
  }));
  if (image.width <= accountAvatarMaxSide && image.height <= accountAvatarMaxSide) {
    try { return await readWechatAvatar(path); } catch { /* Re-encode oversized selections below. */ }
  }
  const scale = Math.min(1, 256 / Math.max(image.width, image.height));
  const result = await new Promise<{ tempFilePath: string }>((resolve, reject) => uni.compressImage({
    src: path, quality: 82, compressedWidth: Math.max(1, Math.round(image.width * scale)),
    compressedHeight: Math.max(1, Math.round(image.height * scale)), success: resolve, fail: () => reject(new Error(avatarError)),
  }));
  return readWechatAvatar(result.tempFilePath);
}
// #endif

// #ifdef H5
export async function prepareBrowserAvatar(path: string) {
  const response = await fetch(path);
  const blob = await response.blob();
  if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size > 10 * 1024 * 1024) throw new Error(avatarError);
  const url = URL.createObjectURL(blob);
  try {
    const picture = new Image();
    await new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve();
      picture.onerror = () => reject(new Error(avatarError));
      picture.src = url;
    });
    const scale = Math.min(1, 256 / Math.max(picture.naturalWidth, picture.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(avatarError);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}
// #endif
