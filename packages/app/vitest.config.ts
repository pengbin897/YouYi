import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@youyi/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
