import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('electron/main/index.ts')
      }
    },
    resolve: {
      alias: {
        '@main': resolve('electron/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve('.'),          // project root — index.html lives here
    plugins: [react()],
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve('index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve('src'),
        '@services': resolve('src/services'),
        '@components': resolve('src/components'),
        '@hooks': resolve('src/hooks'),
        '@store': resolve('src/store')
      }
    }
  }
})
