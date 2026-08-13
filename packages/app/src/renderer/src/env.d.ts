/// <reference types="vite/client" />

import type { YouyiBridgeApi } from '@youyi/shared'

declare global {
  interface Window {
    youyi: YouyiBridgeApi
  }
}

export {}
