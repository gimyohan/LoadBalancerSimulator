import './style.css';

import { EventsPage } from './events/page';
import type { Page, PageContext } from './page';
import { ResultsPage } from './results/page';

// 앱 셸: 상단 탭, 주소(#/<page>/<route>)에 따른 페이지 전환, 파일 드롭, 테마 변경.

const tabs = document.querySelector<HTMLElement>('#tabs')!;
const controls = document.querySelector<HTMLElement>('#page-controls')!;
const status = document.querySelector<HTMLElement>('#load-status')!;
const content = document.querySelector<HTMLElement>('#content')!;
const dropOverlay = document.querySelector<HTMLElement>('#drop-overlay')!;

const pages: Page[] = [new EventsPage(), new ResultsPage()];
let active: Page | undefined;

tabs.innerHTML = pages
  .map((p) => `<a href="#/${p.id}" data-page="${p.id}" role="tab">${p.title}</a>`)
  .join('');

function parseHash(): { page: Page; route: string } {
  const hash = location.hash.slice(1);
  const match = /^\/([^/]+)\/?(.*)$/.exec(hash);
  const page = match && pages.find((p) => p.id === match[1]);
  if (page) return { page, route: match[2] };
  // 탭이 생기기 전 주소(#server%3Apeak.csv)는 이벤트 데이터셋 키로 본다.
  return { page: pages[0], route: hash };
}

function show() {
  const { page, route } = parseHash();
  if (page === active) {
    page.navigate(route);
    return;
  }
  active?.unmount();
  active = page;
  for (const tab of tabs.querySelectorAll<HTMLElement>('[data-page]')) {
    const selected = tab.dataset.page === page.id;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  document.title = `${page.title} · 로드 밸런싱 대시보드`;
  status.textContent = '';
  content.innerHTML = '';
  const context: PageContext = {
    controls,
    content,
    status,
    setRoute: (route) => history.replaceState(null, '', `#/${page.id}${route ? `/${route}` : ''}`),
  };
  page.mount(context, route);
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!active?.acceptsDrop || !e.dataTransfer?.types.includes('Files')) return;
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
  if (active?.acceptsDrop && e.dataTransfer?.files.length) active.dropFiles(e.dataTransfer.files);
});

window.addEventListener('hashchange', show);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => active?.refreshTheme());

show();
