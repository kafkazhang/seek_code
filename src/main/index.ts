import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { registerIpc } from './ipc'
import { installEgressGuard } from './net'
import { setupAutoUpdate } from './updater'

let mainWindow: BrowserWindow | null = null

/** 窗口/任务栏图标：开发期取工程内 build/icon.png，打包后取 resources/build。文件缺失则用 Electron 默认图标。 */
function resolveAppIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.png'), // dev：out/main → 工程根 build/
    join(process.resourcesPath || '', 'build', 'icon.png'), // 打包后
    join(process.resourcesPath || '', 'icon.png')
  ]
  return candidates.find((p) => p && existsSync(p))
}

function createWindow(): void {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#05080f',
    ...(icon ? { icon } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全最佳实践：隔离上下文、关闭 node 集成、开启沙箱
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 外链用系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.seekcode.app')
  installEgressGuard() // 网络出口白名单：仅放行 DeepSeek 接口
  registerIpc(() => mainWindow)
  createWindow()
  setupAutoUpdate(() => mainWindow) // 自动检查更新（打包后生效）

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
