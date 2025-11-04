import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templateDirCandidates = () => {
  const cwd = process.cwd();
  const candidates: string[] = [];
  // Runtime working dir is typically /app/server
  candidates.push(path.resolve(cwd, 'templates'));
  // Also support running from compiled dist code: dist/src/utils -> ../../templates
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    candidates.push(path.resolve(__dirname, '../../templates'));
    candidates.push(path.resolve(__dirname, '../templates'));
  } catch {}
  return candidates;
};

async function readTemplate(fileName: string): Promise<string> {
  const dirs = templateDirCandidates();
  for (const dir of dirs) {
    try {
      const full = path.join(dir, fileName);
      const data = await fs.readFile(full, 'utf-8');
      if (data) return data;
    } catch {}
  }
  throw new Error(`EMAIL_TEMPLATE_NOT_FOUND: ${fileName}`);
}

function render(text: string, vars: Record<string, string | number | null | undefined>) {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

export async function renderEmailTemplate(
  fileName: string,
  vars: Record<string, string | number | null | undefined>
): Promise<string> {
  const tpl = await readTemplate(fileName);
  return render(tpl, vars);
}
