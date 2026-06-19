import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createWorker, type Worker } from 'tesseract.js'
import { dataRoot } from './dataroot'

// 本地 OCR：截图文字识别。
// DeepSeek 的 /chat/completions 不接受图片字段（实测 400 unknown variant `image_url`），
// 因此识图通过"本地 OCR 提取文字 → 拼进 prompt"实现，完全离线、不依赖任何视觉接口。
// 字库（chi_sim + eng，tessdata_fast 未压缩版）随包内置，见 resources/tessdata。

let workerPromise: Promise<Worker> | null = null

/** 定位内置字库目录：开发期取工程内 resources/tessdata，打包后取 extraResources。 */
function tessdataDir(): string {
  const candidates = [
    join(__dirname, '../../resources/tessdata'), // dev：out/main → 工程根 resources/
    join(process.resourcesPath || '', 'tessdata') // 打包后（electron-builder extraResources）
  ]
  return candidates.find((p) => p && existsSync(join(p, 'eng.traineddata'))) ?? candidates[0]
}

/** 懒加载共享 worker（初始化较重，全进程复用一个）。初始化失败则置空以便下次重试。 */
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(['chi_sim', 'eng'], 1, {
      langPath: tessdataDir(),
      cachePath: join(dataRoot(), 'ocr-cache'),
      gzip: false, // 内置字库为未压缩 .traineddata
      cacheMethod: 'none', // 直接从 langPath 读取，不额外落盘缓存
      logger: () => {},
      errorHandler: () => {}
    }).catch((e) => {
      workerPromise = null
      throw e
    })
  }
  return workerPromise
}

/** data URI 或裸 Base64 → 图片字节 Buffer */
function toBuffer(src: string): Buffer {
  const m = /^data:[^;]+;base64,(.*)$/is.exec(src.trim())
  return Buffer.from(m ? m[1] : src, 'base64')
}

/**
 * 对一组图片（data URI）做 OCR，返回各自识别出的文本（去首尾空白）。
 * 单张失败不影响其它，对应位置返回空串。
 */
export async function recognizeImages(dataUrls: string[]): Promise<string[]> {
  if (!dataUrls.length) return []
  const worker = await getWorker()
  const out: string[] = []
  for (const url of dataUrls) {
    try {
      const { data } = await worker.recognize(toBuffer(url))
      out.push((data.text || '').trim())
    } catch {
      out.push('')
    }
  }
  return out
}
