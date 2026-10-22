import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// 데이터 생성기가 CSV를 쓰는 저장소의 data/ 디렉터리. LB_DATA_DIR로 바꿀 수 있다.
const dataDir = path.resolve(process.env.LB_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url)));
// 시뮬레이션 엔진이 결과를 쓰는 results/<데이터셋>/<전략>/ 디렉터리. LB_RESULTS_DIR로 바꿀 수 있다.
const resultsDir = path.resolve(
  process.env.LB_RESULTS_DIR ?? fileURLToPath(new URL('../results', import.meta.url)),
);

const RESULT_FILES = new Set(['summary.csv', 'servers.csv', 'timeline.csv', 'assignments.csv', 'violations.csv']);

type Handler = (url: URL, res: ServerResponse) => Promise<void>;

function sendJson(res: ServerResponse, value: unknown) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

async function sendCsv(res: ServerResponse, file: string) {
  await stat(file);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(file).pipe(res);
}

function badRequest(res: ServerResponse) {
  res.statusCode = 400;
  res.end('invalid path');
}

// 경로 조각 하나가 디렉터리를 벗어나지 않는지 확인한다.
const isPlainName = (name: string) => name !== '' && name === path.basename(name) && name !== '..';

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// GET /api/datasets        → [{ name, size, modified }]
// GET /api/datasets/<name> → CSV 본문
const handleDatasets: Handler = async (url, res) => {
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
    return sendJson(res, files);
  }
  const name = decodeURIComponent(url.pathname.slice('/api/datasets/'.length));
  if (!isPlainName(name) || !name.endsWith('.csv')) return badRequest(res);
  await sendCsv(res, path.join(dataDir, name));
};

// GET /api/results                              → [{ dataset, strategy, modified }]
// GET /api/results/<dataset>/<strategy>/<file>  → CSV 본문
const handleResults: Handler = async (url, res) => {
  if (url.pathname === '/api/results') {
    const runs: { dataset: string; strategy: string; modified: number }[] = [];
    for (const dataset of await subdirectories(resultsDir)) {
      for (const strategy of await subdirectories(path.join(resultsDir, dataset))) {
        const summary = await stat(path.join(resultsDir, dataset, strategy, 'summary.csv')).catch(() => null);
        if (summary) runs.push({ dataset, strategy, modified: summary.mtimeMs });
      }
    }
    runs.sort((a, b) => a.dataset.localeCompare(b.dataset) || a.strategy.localeCompare(b.strategy));
    return sendJson(res, runs);
  }
  const parts = url.pathname.slice('/api/results/'.length).split('/').map(decodeURIComponent);
  if (parts.length !== 3 || !parts.every(isPlainName) || !RESULT_FILES.has(parts[2])) return badRequest(res);
  await sendCsv(res, path.join(resultsDir, ...parts));
};

const routes: [string, Handler][] = [
  ['/api/datasets', handleDatasets],
  ['/api/results', handleResults],
];

async function handleApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = routes.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'));
  if (req.method !== 'GET' || !route) return next();
  try {
    await route[1](url, res);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

function localDataServer(): Plugin {
  return {
    name: 'lb-local-data',
    configureServer(server) {
      server.middlewares.use(handleApi);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleApi);
    },
  };
}

export default defineConfig({
  plugins: [localDataServer()],
  server: { port: 5173 },
});
