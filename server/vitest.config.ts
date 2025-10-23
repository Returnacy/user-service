import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const typesSrc = path.resolve(repoRoot, 'types/src/index.ts');

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@user-service/types': typesSrc,
      '@types': typesSrc,
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
