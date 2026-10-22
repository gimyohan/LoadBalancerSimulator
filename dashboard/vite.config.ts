import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// 데이터 생성기가 CSV를 쓰는 저장소의 data/ 디렉터리. LB_DATA_DIR로 바꿀 수 있다.
const dataDir = path.resolve(process.env.LB_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url)));

// GET /api/datasets        → [{ name, size, modified }]
// GET /api/datasets/<name> → CSV 본문
async function handleDatasets(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/datasets')) return next();

  try {
    if (url.pathname === '/api/datasets') {
      const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile() && e.name.endsWith('.csv'))
          .map(async (e) => {
            const info = await stat(path.join(dataDir, e.name));
            return { name: e.name, size: info.size, modified: info.mtimeMs };
          }),
      );
      files.sort((a, b) => a.name.localeCompare(b.name));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(files));
      return;
    }

    const name = decodeURIComponent(url.pathname.slice('/api/datasets/'.length));
    if (name !== path.basename(name) || !name.endsWith('.csv')) {
      res.statusCode = 400;
      res.end('invalid dataset name');
      return;
    }
    const file = path.join(dataDir, name);
    await stat(file);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(file).pipe(res);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

function datasetServer(): Plugin {
  return {
    name: 'lb-datasets',
    configureServer(server) {
      server.middlewares.use(handleDatasets);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleDatasets);
    },
  };
}

export default defineConfig({
  plugins: [datasetServer()],
  server: { port: 5173 },
});
