import type { SeekApi } from './index'

declare global {
  interface Window {
    seek: SeekApi
  }
}

export {}
