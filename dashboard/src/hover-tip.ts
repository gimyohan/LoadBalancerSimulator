// 요소에 마우스를 올리거나 키보드로 포커스하면 띄우는 설명 상자.
// 상자 하나를 화면 고정 위치로 띄우고 화면 안으로 맞추므로, 화면 가장자리의 요소에서도 잘리지 않는다.

const GAP = 8;
const MARGIN = 8;

export class HoverTip {
  private readonly box: HTMLDivElement;
  private current?: HTMLElement;

  constructor() {
    this.box = document.createElement('div');
    this.box.className = 'hover-tip';
    this.box.id = `hover-tip-${Math.random().toString(36).slice(2)}`;
    this.box.setAttribute('role', 'tooltip');
    this.box.hidden = true;
    document.body.append(this.box);
    document.addEventListener('keydown', this.onKeyDown);
  }

  // trigger에 설명을 붙인다. html은 호출하는 쪽에서 이스케이프한다.
  attach(trigger: HTMLElement, html: string) {
    const show = () => this.show(trigger, html);
    const hide = () => this.hide(trigger);
    trigger.addEventListener('pointerenter', show);
    trigger.addEventListener('focus', show);
    trigger.addEventListener('pointerleave', hide);
    trigger.addEventListener('blur', hide);
  }

  dispose() {
    document.removeEventListener('keydown', this.onKeyDown);
    this.box.remove();
  }

  private show(trigger: HTMLElement, html: string) {
    this.current = trigger;
    this.box.innerHTML = html;
    this.box.hidden = false;
    trigger.setAttribute('aria-describedby', this.box.id);

    // 아래쪽에 두되 자리가 없으면 위로, 좌우는 화면 안으로 맞춘다.
    const anchor = trigger.getBoundingClientRect();
    const { width, height } = this.box.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const top = below + height + MARGIN > window.innerHeight ? Math.max(MARGIN, anchor.top - GAP - height) : below;
    const left = Math.min(Math.max(MARGIN, anchor.left), window.innerWidth - width - MARGIN);
    this.box.style.top = `${top}px`;
    this.box.style.left = `${Math.max(MARGIN, left)}px`;
  }

  private hide(trigger: HTMLElement) {
    if (this.current !== trigger) return;
    this.current = undefined;
    this.box.hidden = true;
    trigger.removeAttribute('aria-describedby');
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.current) this.hide(this.current);
  };
}
