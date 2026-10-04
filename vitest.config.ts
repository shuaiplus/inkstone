import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('./src/client'),
      '@shared': resolve('./src/shared'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['src/worker/lib/request.test.ts', 'src/client/demo/backend.test.ts', 'src/worker/lib/obsidian-import.test.ts', 'tests/backup-retention.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/worker/lib/request.test.ts', 'src/client/demo/backend.test.ts', 'src/worker/lib/obsidian-import.test.ts', 'tests/backup-retention.test.ts'],
        },
      },
    ],
  },
})
