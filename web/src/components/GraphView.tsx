import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Icon from './Icon';
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
} from 'd3-force';

interface GNode {
  id: string;
  label: string;
  deg: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}
interface GLink {
  source: GNode | string;
  target: GNode | string;
}

/**
 * Graph view — canvas-rendered, d3-force (Barnes-Hut) layout. Scales to many
 * thousands of notes: nodes draw on a single canvas, labels appear only when
 * zoomed in or hovered, and isolated (orphan) notes are hidden by default.
 */
export default function GraphView() {
  const open = useStore((s) => s.graphOpen);
  const setOpen = useStore((s) => s.setGraph);
  const openFile = useStore((s) => s.openFile);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<GNode, GLink> | null>(null);
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const view = useRef({ k: 1, x: 0, y: 0 });
  const hover = useRef<GNode | null>(null);
  const drag = useRef<{ panning: boolean; px: number; py: number; moved: number } | null>(null);
  const rafRef = useRef<number>();

  const [showOrphans, setShowOrphans] = useState(false);
  const [stats, setStats] = useState({ total: 0, shown: 0, orphans: 0 });

  // (re)load + run the simulation whenever opened or the orphan toggle changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      const g = await api.graph().catch(() => ({ nodes: [], edges: [] }));
      if (cancelled) return;

      const deg = new Map<string, number>();
      for (const e of g.edges) {
        deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
      }
      const orphans = g.nodes.filter((n) => !deg.has(n.id)).length;
      const nodeList: GNode[] = g.nodes
        .filter((n) => showOrphans || deg.has(n.id))
        .map((n) => ({ id: n.id, label: n.label, deg: deg.get(n.id) ?? 0 }));
      const ids = new Set(nodeList.map((n) => n.id));
      const linkList: GLink[] = g.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ source: e.source, target: e.target }));

      nodesRef.current = nodeList;
      linksRef.current = linkList;
      setStats({ total: g.nodes.length, shown: nodeList.length, orphans });

      const wrap = wrapRef.current!;
      const W = wrap.clientWidth || 900;
      const H = wrap.clientHeight || 600;
      view.current = { k: 1, x: 0, y: 0 };

      // seed positions in a circle to avoid a degenerate start
      nodeList.forEach((n, i) => {
        const a = (i / nodeList.length) * Math.PI * 2;
        n.x = W / 2 + Math.cos(a) * 250;
        n.y = H / 2 + Math.sin(a) * 250;
      });

      simRef.current?.stop();
      const sim = forceSimulation<GNode>(nodeList)
        .force('charge', forceManyBody<GNode>().strength(-34).theta(0.9).distanceMax(420))
        .force('link', forceLink<GNode, GLink>(linkList).id((d) => d.id).distance(46).strength(0.5))
        .force('center', forceCenter(W / 2, H / 2).strength(0.06))
        .force('collide', forceCollide<GNode>(5))
        .alpha(1)
        .alphaDecay(0.03);
      sim.on('tick', () => scheduleDraw());
      simRef.current = sim;
      scheduleDraw();
    })();

    return () => {
      cancelled = true;
      simRef.current?.stop();
      cancelAnimationFrame(rafRef.current!);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showOrphans]);

  const scheduleDraw = () => {
    cancelAnimationFrame(rafRef.current!);
    rafRef.current = requestAnimationFrame(draw);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cs = getComputedStyle(document.querySelector('.theme-light, .theme-dark') || document.body);
    const accent = cs.getPropertyValue('--interactive-accent').trim() || '#7852ee';
    const accentHover = cs.getPropertyValue('--text-accent-hover').trim() || '#a98bff';
    const edgeCol = cs.getPropertyValue('--bg-modifier-border').trim() || '#ddd';
    const textCol = cs.getPropertyValue('--text-muted').trim() || '#666';

    const { k, x: tx, y: ty } = view.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const sx = (n: GNode) => (n.x ?? 0) * k + tx;
    const sy = (n: GNode) => (n.y ?? 0) * k + ty;

    // edges
    ctx.strokeStyle = edgeCol;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const l of links) {
      const s = l.source as GNode;
      const t = l.target as GNode;
      ctx.moveTo(sx(s), sy(s));
      ctx.lineTo(sx(t), sy(t));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // nodes
    const h = hover.current;
    for (const n of nodes) {
      const px = sx(n);
      const py = sy(n);
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      const r = 3 + Math.min(n.deg, 12) * 0.7;
      ctx.beginPath();
      ctx.arc(px, py, n === h ? r + 2 : r, 0, Math.PI * 2);
      ctx.fillStyle = n === h ? accentHover : accent;
      ctx.fill();
    }

    // labels: hovered node always; others only when zoomed in and on-screen
    ctx.fillStyle = textCol;
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const showAll = k > 1.7;
    for (const n of nodes) {
      if (n !== h && !showAll) continue;
      const px = sx(n);
      const py = sy(n);
      if (px < 0 || px > W || py < 0 || py > H) continue;
      const r = 3 + Math.min(n.deg, 12) * 0.7;
      if (n === h) {
        ctx.font = '600 12px -apple-system, sans-serif';
        ctx.fillStyle = accentHover;
      } else {
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillStyle = textCol;
      }
      ctx.fillText(n.label.length > 24 ? n.label.slice(0, 22) + '…' : n.label, px, py + r + 11);
    }
  };

  // --- interactions ---
  const nodeAt = (clientX: number, clientY: number): GNode | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { k, x: tx, y: ty } = view.current;
    let best: GNode | null = null;
    let bestD = 14;
    for (const n of nodesRef.current) {
      const px = (n.x ?? 0) * k + tx;
      const py = (n.y ?? 0) * k + ty;
      const d = Math.hypot(px - mx, py - my);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = view.current;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nk = Math.max(0.15, Math.min(6, v.k * factor));
    // zoom toward cursor
    v.x = mx - ((mx - v.x) * nk) / v.k;
    v.y = my - ((my - v.y) * nk) / v.k;
    v.k = nk;
    scheduleDraw();
  };
  const onDown = (e: React.MouseEvent) => {
    drag.current = { panning: true, px: e.clientX, py: e.clientY, moved: 0 };
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag.current?.panning) {
      const dx = e.clientX - drag.current.px;
      const dy = e.clientY - drag.current.py;
      drag.current.px = e.clientX;
      drag.current.py = e.clientY;
      drag.current.moved += Math.abs(dx) + Math.abs(dy);
      view.current.x += dx;
      view.current.y += dy;
      scheduleDraw();
    } else {
      const n = nodeAt(e.clientX, e.clientY);
      if (n !== hover.current) {
        hover.current = n;
        (canvasRef.current as HTMLCanvasElement).style.cursor = n ? 'pointer' : 'grab';
        scheduleDraw();
      }
    }
  };
  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved < 5) {
      const n = nodeAt(e.clientX, e.clientY);
      if (n) {
        openFile(n.id);
        setOpen(false);
      }
    }
  };

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal graph-modal" onClick={(e) => e.stopPropagation()}>
        <div className="nav-header" style={{ borderBottom: '1px solid var(--bg-modifier-border)' }}>
          <span className="nav-title">Graph view</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 12, marginRight: 'auto', marginLeft: 8 }}>
            {stats.shown} / {stats.total} notes · {stats.orphans} orphans
          </span>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center', marginRight: 8 }}>
            <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} /> Show orphans
          </label>
          <button className="nav-action" title="Close" onClick={() => setOpen(false)}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="graph-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ cursor: 'grab' }}
            onWheel={onWheel}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={() => {
              drag.current = null;
              hover.current = null;
            }}
          />
          <div className="graph-hint">scroll to zoom · drag to pan · click a node to open</div>
        </div>
      </div>
    </div>
  );
}
