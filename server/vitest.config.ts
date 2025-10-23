import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const typesEntry = path.resolve(repoRoot, 'types/index.ts');
const dbEntry = path.resolve(repoRoot, 'db/src/index.ts');

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@user-service/types': typesEntry,
      '@types': typesEntry,
      '@user-service/db': dbEntry,
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
