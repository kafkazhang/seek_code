import { app, dialog, BrowserWindow } from 'electron'
import updater from 'electron-updater'
import { IPC } from '@shared/ipc'
import { UpdateStatus } from '@shared/types'

// 自动更新（electron-updater + GitHub Release）：
//  - 打包后从 GitHub Release 的 latest*.yml 检查新版本（发布流水线已上传这些清单文件）；
//  - 启动后延迟检查一次，并每 6 小时复查；发现新版自动下载，下载完成弹窗询问是否立即重启安装；
//  - 状态实时推送渲染层（设置页/底栏展示），并提供手动「检查更新」与「立即安装」入口。
//  - 开发环境（未打包，无 app-update.yml）跳过，避免报错。
//
// macOS 提示：未签名的 mac 安装包无法自动更新（electron-updater 限制），Windows(NSIS)/Linux(AppImage) 可用。

const { autoUpdater } = updater

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 每 6 小时复查
const FIRST_CHECK_DELAY_MS = 8000 // 启动后延迟首检，避开冷启动高峰

let getWin: () => BrowserWindow | null = () => null
let lastStatus: UpdateStatus = { state: 'idle' }

function emit(status: UpdateStatus): void {
  lastStatus = status
  getWin()?.webContents.send(IPC.updateEvent, status)
}

export function getUpdateStatus(): UpdateStatus {
  return lastStatus
}

export function setupAutoUpdate(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  if (!app.isPackaged) {
    lastStatus = { state: 'dev' }
    return // 开发环境没有 app-update.yml，调用会抛错
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => emit({ state: 'up-to-date', version: app.getVersion() }))
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', version: info.version })
    const win = getWindow() ?? undefined
    const opts = {
      type: 'info' as const,
      title: '发现新版本',
      message: `SeekCode ${info.version} 已下载完成`,
      detail: '是否立即重启并安装更新？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1
    }
    const handle = (r: { response: number }): void => {
      if (r.response === 0) autoUpdater.quitAndInstall()
    }
    if (win) void dialog.showMessageBox(win, opts).then(handle)
    else void dialog.showMessageBox(opts).then(handle)
  })
  autoUpdater.on('error', (err) => emit({ state: 'error', error: err?.message ?? String(err) }))

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

/** 手动/定时检查更新；返回最新状态。开发环境直接返回 dev。 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return { state: 'dev' }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    emit({ state: 'error', error: (e as Error)?.message ?? String(e) })
  }
  return lastStatus
}

/** 退出并安装已下载的更新（下载完成后调用）。 */
export function quitAndInstall(): boolean {
  if (!app.isPackaged || lastStatus.state !== 'downloaded') return false
  autoUpdater.quitAndInstall()
  return true
}
