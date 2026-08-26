import { app, nativeImage, type NativeImage } from 'electron';
import { join } from 'node:path';

export function resolveAppIconPath(
  isPackaged = app.isPackaged,
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
): string {
  return isPackaged
    ? join(resourcesPath, 'brand', 'mineclaw-mark.png')
    : join(cwd, 'build', 'icon.png');
}

export async function loadAppIcon(): Promise<NativeImage | null> {
  const path = resolveAppIconPath();
  const icon = nativeImage.createFromPath(path);
  if (!icon.isEmpty()) return icon;

  console.warn(`[Electron] 品牌图标不可用，将回退到当前可执行文件图标：${path}`);
  try {
    const fallback = await app.getFileIcon(process.execPath, { size: 'large' });
    return fallback.isEmpty() ? null : fallback;
  } catch (error) {
    console.warn('[Electron] 读取可执行文件回退图标失败（应用继续运行）:', error);
    return null;
  }
}
