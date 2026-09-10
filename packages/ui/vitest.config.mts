import { svelte } from '@sveltejs/vite-plugin-svelte'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, type Plugin } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// Workspace packages point `main` at raw TypeScript, which vite refuses as a package entry.
function workspaceSources (): Plugin {
  return {
    name: 'workspace-ts-entry',
    enforce: 'pre',
    resolveId (id: string) {
      if (!id.startsWith('@hcengineering/')) return null
      const pkgJson = join(here, 'node_modules', id, 'package.json')
      if (!existsSync(pkgJson)) return null
      const main = JSON.parse(readFileSync(pkgJson, 'utf-8')).main
      if (typeof main !== 'string' || !main.endsWith('.ts')) return null
      const entry = join(dirname(realpathSync(pkgJson)), main)
      return existsSync(entry) ? entry : null
    }
  }
}

export default defineConfig({
  plugins: [workspaceSources(), svelte({ hot: false })],
  // Without the browser condition svelte resolves to its SSR runtime, where onMount never fires.
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/__test__/setup.ts'],
    include: ['src/**/*.{test,spec}.ts']
  }
})
