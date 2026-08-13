import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // better-sqlite3 / @wechatbot 等含原生模块或依赖 Node 运行时的包不打包，走 require
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@youyi/shared': resolve(__dirname, '../shared/src/index.ts'),
        '@main': resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@youyi/shared': resolve(__dirname, '../shared/src/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      // root 指向 src/renderer 后，相对 outDir 会算到包外面去，这里必须写绝对路径
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@youyi/shared': resolve(__dirname, '../shared/src/index.ts'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    }
  }
})
