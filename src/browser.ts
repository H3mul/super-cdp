/* eslint-disable @typescript-eslint/no-explicit-any */
// Runs INSIDE the page. Must stay fully self-contained (serialized by Playwright): no imports,
// no references to outer scope. Defines window.__scx once per document.
export function install() {
  const w = window as any;
  if (w.__scx) return;

  const descr = (n: Element) =>
    n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + [...n.classList].slice(0, 2).map((c) => '.' + c).join('');
  const box = (r: DOMRect) => [r.x, r.y, r.width, r.height].map(Math.round);
  const vis = (el: Element, cs: CSSStyleDeclaration = getComputedStyle(el), r: DOMRect = el.getBoundingClientRect()) =>
    cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0 && r.width > 0 && r.height > 0;
  const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)];
  const text = (s: string | null, n = 40) => (s || '').trim().replace(/\s+/g, ' ').slice(0, n);

  const state = (sel: string) => {
    const els = all(sel);
    return {
      count: els.length,
      items: els.slice(0, 5).map((el: any) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          el: descr(el),
          text: text(el.textContent, 60),
          box: box(r),
          visible: vis(el, cs, r),
          inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
          occludedBy: top && top !== el && !el.contains(top) && !top.contains(el) ? descr(top) : null,
          disabled: !!el.disabled,
          overflowX: el.scrollWidth > el.clientWidth,
          overflowY: el.scrollHeight > el.clientHeight,
        };
      }),
    };
  };

  const meta = () => ({
    url: location.href,
    title: document.title,
    vw: innerWidth,
    vh: innerHeight,
    bad: performance.getEntriesByType('resource').filter((e: any) => e.responseStatus >= 400).length,
  });

  const trim = (sel: string, o?: { maxNodes?: number; maxDepth?: number }) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const maxN = o?.maxNodes ?? 150;
    const maxD = o?.maxDepth ?? 8;
    let n = 0;
    let truncated = false;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD']);
    const ATTRS = ['role', 'type', 'name', 'href', 'placeholder', 'alt', 'for', 'data-testid'];
    const walk = (el: Element, d: number): any => {
      if (SKIP.has(el.tagName.toUpperCase()) || getComputedStyle(el).display === 'none') return null;
      if (n >= maxN) {
        truncated = true;
        return null;
      }
      n++;
      const kids: any[] = [];
      let own = '';
      for (const c of el.childNodes) {
        if (c.nodeType === 3) own += c.textContent;
        else if (c.nodeType === 1) {
          if (d >= maxD) truncated = true;
          else {
            const k = walk(c as Element, d + 1);
            if (k) kids.push(k);
          }
        }
      }
      const a: Record<string, string> = {};
      for (const at of el.attributes)
        if (ATTRS.includes(at.name) || at.name.startsWith('aria-')) a[at.name] = text(at.value, 40);
      const x = text(own);
      const plain = !el.id && !Object.keys(a).length && !x && /^(DIV|SPAN)$/.test(el.tagName);
      if (plain && kids.length === 1) return kids[0]; // collapse wrapper
      const out: any = { t: descr(el) };
      if (Object.keys(a).length) out.a = a;
      if (x) out.x = x;
      if (kids.length) out.k = kids;
      return out;
    };
    const tree = walk(root, 0);
    return truncated ? { tree, truncated: true } : { tree };
  };

  // Compact map of significant visible elements, for diffing between edits.
  const snapshot = () => {
    const SEL =
      'a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,img,label,nav,main,header,footer,aside,section,form,dialog,[role],[id],[data-testid]';
    const path = (el: Element): string => {
      if (el.id) return '#' + el.id;
      const p = el.parentElement;
      const base = p && p !== document.documentElement ? path(p) + '>' : '';
      const same = p ? [...p.children].filter((c) => c.tagName === el.tagName) : [];
      return base + el.tagName.toLowerCase() + (same.length > 1 ? ':' + (same.indexOf(el) + 1) : '');
    };
    const out: Record<string, any> = {};
    for (const el of all(SEL).slice(0, 500)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!vis(el, cs, r)) continue;
      out[path(el)] = { b: box(r), x: text(el.textContent), c: [...el.classList].slice(0, 3).join(' ') };
    }
    return out;
  };

  const problems = (scope?: string) => {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return null;
    const out: string[] = [];
    const counts: Record<string, number> = {};
    const CAP = 8;
    const add = (kind: string, el: Element, d = '') => {
      counts[kind] = (counts[kind] || 0) + 1;
      if (counts[kind] <= CAP) out.push(`${kind} ${descr(el)}${d ? ' ' + d : ''}`);
    };
    const els = all('*', root).filter((e) => vis(e));
    const INTERACTIVE =
      'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[tabindex]:not([tabindex="-1"])';

    if (document.documentElement.scrollWidth > innerWidth + 1) {
      add('page-hscroll', document.documentElement, `${document.documentElement.scrollWidth}>${innerWidth}`);
      for (const e of els) {
        const r = e.getBoundingClientRect();
        if (r.right > innerWidth + 1) add('beyond-viewport-x', e, `right=${Math.round(r.right)}`);
      }
    }
    for (const e of els as any[]) {
      const cs = getComputedStyle(e);
      if (/hidden|clip/.test(cs.overflowX) && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
        add('clipped-x', e, `${e.scrollWidth}>${e.clientWidth}`);
    }

    const inter = els.filter((e) => e.matches(INTERACTIVE)) as any[];
    for (const e of inter) {
      const r = e.getBoundingClientRect();
      const grouped = e.matches('input[type=checkbox],input[type=radio]') && e.closest('label');
      if ((r.width < 24 || r.height < 24) && !grouped) add('small-target', e, `${Math.round(r.width)}x${Math.round(r.height)}`);
      if (e.matches('input,select,textarea') && !e.matches('[type=submit],[type=button],[type=reset],[type=image]')) {
        if (!(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.labels?.length || e.closest('label')))
          add('unlabeled-input', e);
      } else if (
        e.matches('button,a[href]') &&
        !(text(e.textContent, 1) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title ||
          e.querySelector('img[alt]:not([alt=""])') || e.querySelector('svg title'))
      )
        add('no-accessible-name', e);
    }
    const small = inter.slice(0, 150);
    for (let i = 0; i < small.length; i++)
      for (let j = i + 1; j < small.length; j++) {
        const a = small[i], b = small[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const iw = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const ih = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (iw > 0 && ih > 0 && (iw * ih) / Math.min(ra.width * ra.height, rb.width * rb.height) > 0.2)
          add('overlap', a, 'with ' + descr(b));
      }

    for (const img of all('img', root) as HTMLImageElement[]) {
      if (img.complete && !img.naturalWidth) add('broken-img', img);
      if (!img.hasAttribute('alt')) add('img-no-alt', img);
    }

    const rgb = (s: string) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    for (const e of els as HTMLElement[]) {
      if (![...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim())) continue;
      const cs = getComputedStyle(e);
      let bg: number[] | null = null;
      for (let p: Element | null = e; p; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.backgroundImage !== 'none') break; // gradients/images: can't know, skip
        const c = rgb(pcs.backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0) { bg = c; break; }
        if (!p.parentElement) bg = [255, 255, 255];
      }
      if (!bg) continue;
      const fg = rgb(cs.color);
      const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
      if (ratio < (large ? 3 : 4.5)) add('low-contrast', e, ratio.toFixed(2) + ':1');
    }

    for (const [k, n] of Object.entries(counts)) if (n > CAP) out.push(`${k} +${n - CAP} more`);
    return out;
  };

  w.__scx = { state, trim, meta, snapshot, problems };
}
