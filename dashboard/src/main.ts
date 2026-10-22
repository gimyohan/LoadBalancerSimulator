import './style.css';

import { escapeHtml } from './dom';
import { loadEventDataset, type EventDataset } from './events/dataset';
import { EventDatasetView } from './events/view';
import { formatBytes } from './format';

// 데이터셋 출처: 개발 서버가 제공하는 data/ 디렉터리, 또는 사용자가 연 로컬 파일.
interface DatasetEntry {
  key: string;
  name: string;
  source: string;
  size: number;
  read(): Promise<string>;
  loaded?: EventDataset;
}

interface ServerDataset {
  name: string;
  size: number;
  modified: number;
}

const select = document.querySelector<HTMLSelectElement>('#dataset-select')!;
const binsSelect = document.querySelector<HTMLSelectElement>('#bins-select')!;
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')!;
const openButton = document.querySelector<HTMLButtonElement>('#open-file')!;
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;
const status = document.querySelector<HTMLElement>('#load-status')!;
const content = document.querySelector<HTMLElement>('#content')!;
const dropOverlay = document.querySelector<HTMLElement>('#drop-overlay')!;

const view = new EventDatasetView(content);
const entries = new Map<string, DatasetEntry>();
let activeKey: string | undefined;
let loadToken = 0;

function renderSelect() {
  select.innerHTML = entries.size
    ? [...entries.values()]
        .map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.name)}${e.key.startsWith('local:') ? ' (로컬)' : ''}</option>`)
        .join('')
    : '<option value="">데이터셋 없음</option>';
  select.disabled = entries.size === 0;
  if (activeKey && entries.has(activeKey)) select.value = activeKey;
}

function showEmpty() {
  view.dispose();
  status.textContent = '';
  content.innerHTML = `<section class="empty">
      <h2>표시할 데이터셋이 없다</h2>
      <p>데이터 생성기로 <code>data/</code>에 CSV를 만들고 새로고침하거나,<br />
      <b>CSV 열기</b> 또는 파일을 끌어다 놓아 불러온다.</p>
      <p><code>lb_generator scenario=peak sessions=20000</code></p>
    </section>`;
}

function showError(name: string, error: unknown) {
  view.dispose();
  status.textContent = '';
  const message = error instanceof Error ? error.message : String(error);
  content.innerHTML = `<div class="status status-critical" role="alert">
      <p><span class="status-icon" aria-hidden="true">!</span>
      ${escapeHtml(name)}을(를) 읽지 못했다: ${escapeHtml(message)}</p></div>`;
}

async function activate(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  activeKey = key;
  select.value = key;
  history.replaceState(null, '', `#${encodeURIComponent(key)}`);

  const token = ++loadToken;
  if (!entry.loaded) {
    status.textContent = `${entry.name} 불러오는 중…`;
    try {
      const text = await entry.read();
      if (token !== loadToken) return;
      entry.loaded = loadEventDataset(entry.name, entry.source, text);
    } catch (error) {
      if (token === loadToken) showError(entry.name, error);
      return;
    }
  }
  if (token !== loadToken) return;
  status.textContent = `${entry.source} · ${formatBytes(entry.size)}`;
  view.show(entry.loaded);
}

async function fetchServerDatasets(): Promise<ServerDataset[]> {
  try {
    const response = await fetch('/api/datasets', { cache: 'no-store' });
    if (!response.ok) return [];
    const list: unknown = await response.json();
    return Array.isArray(list) ? (list as ServerDataset[]) : [];
  } catch {
    return []; // 정적 빌드처럼 API가 없으면 로컬 파일만 쓴다
  }
}

async function refreshServerDatasets() {
  // 서버 목록을 앞에 두고, 이미 연 로컬 파일은 뒤에 유지한다.
  const local = [...entries.values()].filter((e) => e.key.startsWith('local:'));
  entries.clear();
  for (const d of await fetchServerDatasets()) {
    entries.set(`server:${d.name}`, {
      key: `server:${d.name}`,
      name: d.name,
      source: 'data/ 디렉터리',
      size: d.size,
      read: async () => {
        const response = await fetch(`/api/datasets/${encodeURIComponent(d.name)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      },
    });
  }
  for (const e of local) entries.set(e.key, e);
  renderSelect();
}

function addLocalFiles(files: Iterable<File>) {
  let last: string | undefined;
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.csv')) continue;
    const key = `local:${file.name}`;
    entries.set(key, { key, name: file.name, source: '로컬 파일', size: file.size, read: () => file.text() });
    last = key;
  }
  renderSelect();
  if (last) void activate(last);
}

async function reload() {
  const previous = activeKey;
  await refreshServerDatasets();
  const hashKey = decodeURIComponent(location.hash.slice(1));
  const next = [previous, hashKey, entries.keys().next().value].find((k) => k && entries.has(k));
  if (next) await activate(next);
  else showEmpty();
}

select.addEventListener('change', () => void activate(select.value));
binsSelect.addEventListener('change', () => view.setBins(Number(binsSelect.value)));
refreshButton.addEventListener('click', () => void reload());
openButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addLocalFiles(fileInput.files ?? []);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  addLocalFiles(e.dataTransfer?.files ?? []);
});

window.addEventListener('hashchange', () => {
  const key = decodeURIComponent(location.hash.slice(1));
  if (key === activeKey) return;
  // 목록에 없는 키면 그사이 생성된 파일일 수 있으니 data/ 목록을 다시 읽는다.
  if (entries.has(key)) void activate(key);
  else
    void refreshServerDatasets().then(() => {
      if (entries.has(key)) void activate(key);
    });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => view.refreshTheme());

void reload();
