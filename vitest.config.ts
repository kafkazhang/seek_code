import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 单测聚焦「纯逻辑」模块（不依赖 Electron 运行时）：命令安全分类、网关重试判定等。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node'
  },
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  }
})
