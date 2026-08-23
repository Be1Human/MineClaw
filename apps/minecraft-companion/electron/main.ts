import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import dotenv from 'dotenv'
import { DesktopPetController } from './desktopPetController.js'

// ── dotenv ────────────────────────────────────────────────────────────────────
dotenv.config({
  path: app.isPackaged
    ? join(app.getPath('userData'), '.env')
    : join(process.cwd(), '.env'),
})

// ── 生成托盘图标 PNG（Node.js 内置 zlib，无额外依赖）────────────────────────
function makeIconPng(r: number, g: number, b: number, size = 32): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * (1 + size * 3) + 1 + x * 3
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b
    }
  }
  const compressed = deflateSync(raw)
  const crc32 = (buf: Buffer): number => {
    let c = 0xFFFFFFFF
    for (const byte of buf) {
      let n = ((c ^ byte) & 0xFF) >>> 0
      for (let k = 0; k < 8; k++) n = (n & 1) ? 0xEDB88320 ^ (n >>> 1) : n >>> 1
      c = (n ^ (c >>> 8)) >>> 0
    }
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  const chunk = (name: string, data: Buffer): Buffer => {
    const nb = Buffer.from(name, 'ascii')
    const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length)
    const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([nb, data])))
    return Buffer.concat([lb, nb, data, cb])
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'MineClaw',
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
function createTray(): void {
  try {
    const icon = nativeImage.createFromBuffer(makeIconPng(76, 175, 80))
    const tray = new Tray(icon)
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
ipcMain.on('window:close', () => mainWindow?.hide()) // 关闭=缩托盘，与原关窗行为一致
// 用系统浏览器打开外链（仅放行 http/https，防协议注入）
ipcMain.on('shell:openExternal', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
})

app.whenReady().then(async () => {
  await startBackend()
  createWindow()
  const hubUrl = 'http://127.0.0.1:' + (process.env['HUB_PORT'] ?? '3000')
  desktopPetController = new DesktopPetController(
    hubUrl,
    join(__dirname, '../preload/index.cjs'),
    process.env['ELECTRON_RENDERER_URL'],
  )
  desktopPetController.start()
  createTray()
})

app.on('window-all-closed', () => { /* 托盘保活，不退出 */ })
app.on('before-quit', () => {
  isQuitting = true
  desktopPetController?.stop()
})
