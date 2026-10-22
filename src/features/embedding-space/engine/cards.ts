import * as THREE from 'three';

/** Per-card cache stashed on the element (avoids layout reads and redundant style writes). */
interface CardEl extends HTMLElement {
  __t?: string; __o?: string; __v?: string; __vis?: number;
  __w?: number; __h?: number;
  __nx?: number; __ny?: number; __nz?: number;
  __above?: boolean; __offX?: number; __offY?: number; __side?: string;
}

interface HostEl extends HTMLElement {
  __mo?: MutationObserver | null;
  __dirty?: boolean;
  __cards?: CardEl[];
  __order?: CardEl[];
  __orderSrc?: CardEl[];
}

interface Rect { x0: number; x1: number; y0: number; y1: number }

const CULL_MARGIN = 40;

/**
 * Projects floating DOM cards (elements carrying data-nx/ny/nz) onto their
 * stars every frame. Two host modes:
 *  - default: selected/focused/neighbour cards — above-or-beside placement with
 *    hysteresis, fixed mini footprints for collision, eased visibility;
 *  - data-declutter="1": Path anchor cards — priority-ordered, stacked to avoid
 *    each other and every [data-avoid] HUD element.
 * Perf: no layout reads in the hot path; sizes and HUD rects are re-sampled
 * every ~20 frames; style writes are skipped when unchanged; off-screen cards
 * are culled.
 */
export class CardProjector {
  containers: Array<HTMLElement | null> = [];
  private frame = 0;
  private avoidRects: Rect[] | null = null;
  private projVec = new THREE.Vector3();

  project(camera: THREE.Camera, dt: number, cw: number, ch: number, hostRect: DOMRect, flying: boolean) {
    this.frame++;
    const resample = this.frame % 20 === 1;
    if (resample || !this.avoidRects) {
      const rects: Rect[] = [];
      for (const av of document.querySelectorAll('[data-avoid]')) {
        const r = av.getBoundingClientRect();
        if (r.width && r.height) rects.push({ x0: r.left - hostRect.left, x1: r.right - hostRect.left, y0: r.top - hostRect.top, y1: r.bottom - hostRect.top });
      }
      this.avoidRects = rects;
    }
    const setT = (card: CardEl, t: string) => { if (card.__t !== t) { card.__t = t; card.style.transform = t; } };
    const setO = (card: CardEl, o: string) => {
      if (card.__o === o) return;
      card.__o = o; card.style.opacity = o;
      card.style.transformOrigin = '50% 100%';
      const vis = o === '0' ? 'hidden' : 'visible';
      if (card.__v !== vis) { card.__v = vis; card.style.visibility = vis; }
    };
    const size = (card: CardEl) => {
      if (resample || card.__w === undefined) { card.__w = card.offsetWidth; card.__h = card.offsetHeight; }
    };
    const pv = this.projVec;
    for (const raw of this.containers) {
      if (!raw) continue;
      const el = raw as HostEl;
      if (!el.__mo) {
        el.__dirty = true;
        el.__mo = new MutationObserver(() => { el.__dirty = true; });
        el.__mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-nx', 'data-ny', 'data-nz', 'data-prio'] });
      }
      if (el.__dirty || !el.__cards) {
        el.__dirty = false;
        el.__cards = [...el.querySelectorAll<CardEl>('[data-nx]')];
        for (const c of el.__cards) { c.__nx = undefined; c.__w = undefined; }
      }
      const cards = el.__cards;
      if (cards.length === 0) continue;
      const declutter = el.dataset.declutter === '1';
      const rankOf = (c: CardEl) => c.dataset.reveal !== '1' ? 3 : c.dataset.focus === '1' ? 2 : 1;
      if (!el.__order || el.__orderSrc !== cards || resample) {
        el.__orderSrc = cards;
        el.__order = declutter
          ? [...cards].sort((x, y) => parseFloat(y.dataset.prio || '0') - parseFloat(x.dataset.prio || '0'))
          : [...cards].sort((x, y) => rankOf(y) - rankOf(x));
      }
      const order = el.__order;
      const placedN: Rect[] = [];
      const placed: Rect[] = [];
      let maxY = Infinity, floorY = ch - 16;
      for (const r of this.avoidRects!) {
        if (declutter) placed.push({ x0: r.x0 - 6, x1: r.x1 + 6, y0: r.y0 - 6, y1: r.y1 + 6 });
        if (r.y0 > ch * 0.5) { maxY = Math.min(maxY, r.y0 - 6); floorY = Math.min(floorY, r.y0 - 8); }
      }
      for (const card of order) {
        if (card.__nx === undefined) {
          card.__nx = parseFloat(card.dataset.nx || '0'); card.__ny = parseFloat(card.dataset.ny || '0'); card.__nz = parseFloat(card.dataset.nz || '0');
        }
        pv.set(card.__nx, card.__ny!, card.__nz!).project(camera);
        const sx = (pv.x * 0.5 + 0.5) * cw;
        const sy = (-pv.y * 0.5 + 0.5) * ch;
        // Cull: behind camera, or the star's screen point is outside the viewport
        if (pv.z > 1 || sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN) {
          setO(card, '0'); card.__vis = 0; if (declutter) card.style.pointerEvents = 'none'; continue;
        }
        size(card);
        const w = card.__w || 180, h = card.__h || 46;
        if (declutter) {
          let top = Math.min(sy - 20 - h, maxY - h), ok = false;
          for (let tries = 0; tries < 4; tries++) {
            const hit = placed.find(r => sx - w / 2 < r.x1 && sx + w / 2 > r.x0 && top < r.y1 && top + h > r.y0);
            if (!hit) { ok = true; break; }
            top = hit.y0 - h - 6;
          }
          if (!ok || top < 8) { setO(card, '0'); card.style.pointerEvents = 'none'; continue; }
          placed.push({ x0: sx - w / 2 - 4, x1: sx + w / 2 + 4, y0: top, y1: top + h });
          card.style.pointerEvents = 'auto';
          setT(card, `translate(${sx | 0}px, ${top | 0}px) translate(-50%, 0)`);
          setO(card, '1');
          continue;
        }
        // Neighbour cards appear as the camera closes on their star
        let target = 1;
        if (card.dataset.reveal === '1') {
          const dx = card.__nx - camera.position.x, dy = card.__ny! - camera.position.y, dz = card.__nz! - camera.position.z;
          const cd = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const t = Math.max(0, Math.min(1, (480 - cd) / 220));
          target = t * t * (3 - 2 * t);
        }
        // Placement mode is locked while the camera flies, with hysteresis otherwise — no above/side flip mid-move
        const roomAbove = sy - 48 - h;
        let above = card.__above;
        if (above === undefined) above = roomAbove >= 56;
        else if (!flying) { if (above && roomAbove < 46) above = false; else if (!above && roomAbove >= 72) above = true; }
        card.__above = above;
        // Overlap: minis use a fixed nominal box so hover growth never re-shuffles
        const isMini = card.dataset.reveal === '1' && card.dataset.focus !== '1';
        {
          const fw = isMini ? 116 : w, fh = isMini ? 88 : h;
          const fx0 = above ? sx - fw / 2 : sx + 44, fy0 = above ? sy - 48 - fh : sy - fh / 2;
          const hit = placedN.some(r => fx0 < r.x1 && fx0 + fw > r.x0 && fy0 < r.y1 && fy0 + fh > r.y0);
          if (hit && isMini) target = 0;
          else placedN.push({ x0: fx0 - 4, x1: fx0 + fw + 4, y0: fy0 - 4, y1: fy0 + fh + 4 });
        }
        // Eased, time-based visibility — fades instead of popping, incl. entering the viewport
        const prevVis = card.__vis || 0;
        const kV = 1 - Math.exp(-(target > prevVis ? 3.2 : 6.0) * dt);
        card.__vis = prevVis + (target - prevVis) * kV;
        const rv = card.__vis;
        if (rv < 0.015 && target === 0) { setO(card, '0'); continue; }
        // Placement offset from the star; the offset itself eases so mode changes glide
        let offX: number, offY: number;
        if (above) {
          offX = -w / 2; offY = -48 - h + (1 - rv) * 14;
        } else {
          const cy = Math.max(56 + h / 2, Math.min(floorY - h / 2, sy));
          let left: number;
          if (sx + 44 + w <= cw - 16) left = sx + 44;
          else if (sx - 44 - w >= 16) left = sx - 44 - w;
          else {
            left = (sx > cw / 2) ? Math.max(16, sx - 44 - w) : Math.min(cw - 16 - w, sx + 44);
            if (left < sx + 24 && left + w > sx - 24) left = sx > cw / 2 ? 16 : cw - 16 - w;
          }
          offX = left - sx; offY = cy - h / 2 - sy;
        }
        if (card.__offX === undefined) { card.__offX = offX; card.__offY = offY; }
        const kO = 1 - Math.exp(-7 * dt);
        card.__offX += (offX - card.__offX) * kO;
        card.__offY! += (offY - card.__offY!) * kO;
        const side = above ? '0' : '1';
        if (card.__side !== side) { card.__side = side; card.dataset.side = side; }
        const sc = (0.9 + 0.1 * rv).toFixed(3);
        setT(card, `translate(${(sx + card.__offX) | 0}px, ${(sy + card.__offY!) | 0}px) scale(${sc})`);
        setO(card, rv >= 0.995 ? '1' : rv.toFixed(3));
      }
    }
  }

  /** Apply the node-exit fade to every card host. */
  setHostOpacity(f: number) {
    for (const el of this.containers) if (el) el.style.opacity = String(f);
  }

  dispose() {
    for (const raw of this.containers) {
      const el = raw as HostEl | null;
      if (el && el.__mo) { el.__mo.disconnect(); el.__mo = null; el.__cards = undefined; el.__order = undefined; }
    }
    this.containers = [];
  }
}
