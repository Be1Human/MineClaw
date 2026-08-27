import { app, BrowserWindow, Tray, Menu, ipcMain, shell, type NativeImage } from 'electron'
import { join } from 'node:path'
import dotenv from 'dotenv'
import { DesktopPetController } from './desktopPetController.js'
import { loadAppIcon } from './appIcon.js'

// ── dotenv ────────────────────────────────────────────────────────────────────
dotenv.config({
  path: app.isPackaged
    ? join(app.getPath('userData'), '.env')
    : join(process.cwd(), '.env'),
})

// ── 全局错误兜底（与 src/index.ts 保持一致）──────────────────────────────────
let lastFatalAt = 0, fatalCount = 0
function handleFatal(kind: string, err: unknown): void {
  const now = Date.now()
  if (now - lastFatalAt < 1000) fatalCount++; else fatalCount = 1
  lastFatalAt = now
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  console.error(`\n🛡 [全局兜底·${kind}] 第 ${fatalCount} 次：\n${msg}`)
  if (fatalCount > 50) { app.quit() }
}
process.on('uncaughtException', err => handleFatal('uncaughtException', err))
process.on('unhandledRejection', reason => handleFatal('unhandledRejection', reason))

// ── 后端（Express + Socket.IO）────────────────────────────────────────────────
import { createHubServer } from '../src/hub/server.js'

async function startBackend(): Promise<void> {
  const dataDir = app.isPackaged
    ? join(app.getPath('userData'), 'data')
    : join(process.cwd(), 'data')

  // 生产包：用 Express 托管前端 dist，前端与 API/Socket.IO 同源
  if (app.isPackaged || !process.env['ELECTRON_RENDERER_URL']) {
    process.env['SERVE_STATIC'] = join(__dirname, '../renderer')
  }

  const hub = createHubServer(
    {
      port: parseInt(process.env['HUB_PORT'] ?? '3000', 10),
      host: '127.0.0.1',
      dataDir,
    },
    {
      apiKey: process.env['LLM_API_KEY'] ?? '',
      baseUrl: process.env['LLM_BASE_URL'] ?? 'https://api.openai.com/v1',
      model: process.env['LLM_MODEL'] ?? 'gpt-4o-mini',
    },
  )
  await hub.listen()
  console.log('[Electron] Backend ready on :' + (process.env['HUB_PORT'] ?? '3000'))
}

// ── 窗口 ──────────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let desktopPetController: DesktopPetController | null = null
let isQuitting = false

function createWindow(icon: NativeImage | null): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'MineClaw',
    ...(icon ? { icon } : {}),
    frame: false, // 无边框：去系统标题栏/边框，顶栏由前端自定义可拖拽标题栏接管
    backgroundColor: '#15170f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    // 开发模式：Vite dev server（保留 HMR + proxy）
    mainWindow.loadURL(devUrl)
    // mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // 生产模式：从后端 HTTP 加载（前端 dist 由 Express 托管，确保同源）
    mainWindow.loadURL('http://127.0.0.1:' + (process.env['HUB_PORT'] ?? '3000'))
  }

  // 外链一律交给系统浏览器，绝不在应用内开新窗口（window.open / target=_blank 全拦）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // 防止主窗口被导航到外部 URL（点链接误把应用页面替换掉）→ 拦下转系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isAppPage = url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') || (devUrl && url.startsWith(devUrl))
    if (!isAppPage && /^https?:\/\//i.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // 关窗口 → 缩到托盘，不退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

// ── 托盘 ──────────────────────────────────────────────────────────────────────
function createTray(icon: NativeImage | null): void {
  try {
    if (!icon) {
      console.warn('[Electron] 无可用应用图标，跳过系统托盘创建（主窗口仍可运行）')
      return
    }
    const tray = new Tray(icon.resize({ width: 32, height: 32, quality: 'best' }))
    tray.setToolTip('MineClaw')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示界面', click: () => mainWindow?.show() },
      { label: '显示/隐藏桌面角色', click: () => desktopPetController?.toggleVisible() },
      { label: '重置桌面角色位置', click: () => desktopPetController?.resetPosition() },
      { type: 'separator' },
      { label: '退出 MineClaw', click: () => { isQuitting = true; app.quit() } },
    ]))
    tray.on('double-click', () => mainWindow?.show())
  } catch (e) {
    console.warn('[Electron] 托盘创建失败（可继续运行）:', e)
  }
}

// ── 单实例锁（防重复启动）────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在跑，把它的窗口拉到前台然后退出
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// ── 生命周期 ──────────────────────────────────────────────────────────────────
// ── 无边框窗口控制 IPC（前端自定义标题栏调用）─────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})
ipcMain.on('window:close', () => mainWindow?.hide()) // 关闭=缩托盘，与原关窗行为一致
// 用系统浏览器打开外链（仅放行 http/https，防协议注入）
ipcMain.on('shell:openExternal', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
})

app.whenReady().then(async () => {
  await startBackend()
  const icon = await loadAppIcon()
  createWindow(icon)
  const hubUrl = 'http://127.0.0.1:' + (process.env['HUB_PORT'] ?? '3000')
  desktopPetController = new DesktopPetController(
    hubUrl,
    join(__dirname, '../preload/index.cjs'),
    process.env['ELECTRON_RENDERER_URL'],
  )
  desktopPetController.start()
  createTray(icon)
})

app.on('window-all-closed', () => { /* 托盘保活，不退出 */ })
app.on('before-quit', () => {
  isQuitting = true
  desktopPetController?.stop()
})
