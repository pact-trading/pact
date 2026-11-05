import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const landingSrc = fileURLToPath(new URL('./src', import.meta.url))
const webSrc = fileURLToPath(new URL('../web/src', import.meta.url))
const exts = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']

/** '@/x' resolves to the landing's src first, then to apps/web/src, so the app's real
 * components (which import '@/lib/cn' and friends) render here unchanged. */
function sharedAlias() {
  return {
    name: 'pact-shared-alias',
    enforce: 'pre',
    resolveId(id) {
      if (!id.startsWith('@/')) return null
      for (const root of [landingSrc, webSrc]) {
        for (const ext of exts) {
          const file = root + '/' + id.slice(2) + ext
          if (existsSync(file) && (ext !== '' || /\.\w+$/.test(id))) return file
        }
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [sharedAlias(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@web': webSrc,
      'next/link': fileURLToPath(new URL('./src/shims/next-link.tsx', import.meta.url)),
    },
    dedupe: ['react', 'react-dom', 'clsx', 'tailwind-merge', 'class-variance-authority', '@tabler/icons-react', '@radix-ui/react-slot'],
  },
  server: { fs: { allow: ['..', '../../packages'] } },
})
