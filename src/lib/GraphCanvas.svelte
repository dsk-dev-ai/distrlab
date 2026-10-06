<script lang="ts">
  import { onMount } from "svelte";
  import type {
    GlobalSettings,
    LinkDef,
    LinkStats,
    NodeDef,
    NodeStats,
  } from "../sim/types";

  interface Props {
    defs: NodeDef[];
    links: LinkDef[];
    stats: Record<string, NodeStats>;
    linkStats: Record<string, LinkStats>;
    settings: GlobalSettings;
    positions: Record<string, { x: number; y: number }>;
    selected: string | null;
    viewKey: string;
    onselect: (id: string | null) => void;
    onmove: (id: string, x: number, y: number) => void;
  }

  let {
    defs,
    links,
    stats,
    linkStats,
    settings,
    positions,
    selected,
    viewKey,
    onselect,
    onmove,
  }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let hover: string | null = $state(null);
  const cam = { x: 40, y: 20, scale: 1 };
  const size = { w: 800, h: 500 };
  let touched = false;
  let lastIds = "";

  let drag = $state<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  let pan = $state<{ sx: number; sy: number; cx: number; cy: number } | null>(null);

  const posOf = (d: NodeDef) => positions[d.id] ?? { x: d.x, y: d.y };

  function toWorld(e: PointerEvent | WheelEvent) {
    const r = canvas!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - cam.x) / cam.scale,
      y: (e.clientY - r.top - cam.y) / cam.scale,
    };
  }

  function hit(wx: number, wy: number): NodeDef | null {
    for (let i = defs.length - 1; i >= 0; i--) {
      const d = defs[i];
      const p = posOf(d);
      if (wx > p.x - W / 2 && wx < p.x + W / 2 && wy > p.y - H / 2 && wy < p.y + H / 2)
        return d;
    }
    return null;
  }

  function fit() {
    if (defs.length === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const d of defs) {
      const p = posOf(d);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const w = maxX - minX + 240;
    const h = maxY - minY + 180;
    cam.scale = Math.max(0.3, Math.min(size.w / w, size.h / h, 1.2));
    cam.x = size.w / 2 - ((minX + maxX) / 2) * cam.scale;
    cam.y = size.h / 2 - ((minY + maxY) / 2) * cam.scale;
  }

  $effect(() => {
    void viewKey;
    const ids = defs.map((d) => d.id).join(",");
    if (ids === lastIds) return;
    lastIds = ids;
    touched = false;
    fit();
  });

  function onDown(e: PointerEvent) {
    const w = toWorld(e);
    const d = hit(w.x, w.y);
    canvas!.setPointerCapture(e.pointerId);
    if (d) {
      const p = posOf(d);
      drag = { id: d.id, dx: w.x - p.x, dy: w.y - p.y, moved: false };
    } else {
      pan = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    }
  }

  function onMove(e: PointerEvent) {
    const w = toWorld(e);
    if (drag) {
      const d = defs.find((x) => x.id === drag!.id);
      if (!d) return;
      const nx = w.x - drag.dx;
      const ny = w.y - drag.dy;
      const p = posOf(d);
      if (Math.abs(nx - p.x) > 1.5 || Math.abs(ny - p.y) > 1.5) {
        drag.moved = true;
        touched = true;
        onmove(drag.id, nx, ny);
      }
      return;
    }
    if (pan) {
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) touched = true;
      cam.x = pan.cx + dx;
      cam.y = pan.cy + dy;
      return;
    }
    hover = hit(w.x, w.y)?.id ?? null;
  }

  function onUp() {
    if (drag) {
      if (!drag.moved) onselect(drag.id === selected ? null : drag.id);
      drag = null;
    }
    pan = null;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    touched = true;
    const r = canvas!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * 0.0016);
    const next = Math.min(2.5, Math.max(0.3, cam.scale * factor));
    cam.x = sx - ((sx - cam.x) / cam.scale) * next;
    cam.y = sy - ((sy - cam.y) / cam.scale) * next;
    cam.scale = next;
  }

  function lines(d: NodeDef, s: NodeStats | undefined): string[] {
    switch (d.kind) {
      case "client":
        return [`${s?.rps ?? 0} rps offered`];
      case "lb":
        return [
          `${s?.rps ?? 0} rps · ${settings.lbStrategy}`,
          `→ ${(d.targets ?? []).join("  ")}`,
        ];
      case "ratelimiter":
        return [`${s?.rps ?? 0} rps through`, `${s?.throttled ?? 0} shed (429)`];
      case "cache":
        return [
          s?.refill
            ? "COLD · refilling"
            : `hit ${s?.hitRatio != null ? Math.round(s.hitRatio * 100) : "—"}%`,
          `${s?.rps ?? 0} rps served`,
        ];
      case "db":
        return [
          `${s?.rps ?? 0} rps`,
          (d.replicaLagMs ?? 0) > 0
            ? `stale ${Math.round(s?.stalePct ?? 0)}% · lag ${d.replicaLagMs}ms`
            : "primary reads",
        ];
      default:
        return [
          `q ${s?.queue ?? 0}/${Number.isFinite(d.queueLimit) ? d.queueLimit : "∞"}`,
          `${s?.rps ?? 0} rps · util ${Math.round((s?.util ?? 0) * 100)}%`,
        ];
    }
  }

  function quad(
    ax: number,
    ay: number,
    cx: number,
    cy: number,
    bx: number,
    by: number,
    t: number,
  ) {
    const u = 1 - t;
    return {
      x: u * u * ax + 2 * u * t * cx + t * t * bx,
      y: u * u * ay + 2 * u * t * cy + t * t * by,
    };
  }

  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function badge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    color: string,
  ) {
    ctx.font = "600 9px system-ui, sans-serif";
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = "#0b1118";
    roundRect(ctx, x - w, y - 8, w, 15, 7);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x - w / 2, y);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function draw() {
    const cv = canvas;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);

    const now = performance.now();
    const pmap = new Map(defs.map((d) => [d.id, posOf(d)]));

    for (const l of links) {
      const a = pmap.get(l.from);
      const b = pmap.get(l.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const cx = (a.x + b.x) / 2 - dy * 0.07;
      const cy = (a.y + b.y) / 2 + dx * 0.07;
      const st = linkStats[l.id];
      const rps = st?.rps ?? 0;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      if (l.partitioned) {
        ctx.strokeStyle = "#7f1d1d";
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 6]);
      } else {
        ctx.strokeStyle = rps > 0 ? "#2f6f95" : "#22303d";
        ctx.lineWidth = 1.4 + Math.min(3.5, rps / 70);
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (!l.partitioned && rps > 0) {
        const count = Math.min(11, Math.max(1, Math.round(rps / 14)));
        const speed = 0.00016 * (0.7 + Math.min(1.4, rps / 400));
        ctx.fillStyle = "#8bdcff";
        for (let i = 0; i < count; i++) {
          const t = (now * speed + i / count) % 1;
          const p = quad(a.x, a.y, cx, cy, b.x, b.y, t);
          ctx.globalAlpha = 0.3 + 0.55 * Math.sin(Math.PI * t);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      const mp = quad(a.x, a.y, cx, cy, b.x, b.y, 0.5);
      if (l.partitioned) {
        ctx.strokeStyle = "#f87171";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(mp.x - 6, mp.y - 6);
        ctx.lineTo(mp.x + 6, mp.y + 6);
        ctx.moveTo(mp.x + 6, mp.y - 6);
        ctx.lineTo(mp.x - 6, mp.y + 6);
        ctx.stroke();
      } else {
        const label = `${l.latencyMs}ms${rps > 0 ? ` · ${rps}/s` : ""}`;
        ctx.font = "10.5px ui-monospace, monospace";
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = "rgba(11,17,24,0.87)";
        roundRect(ctx, mp.x - w / 2, mp.y - 8, w, 15, 7);
        ctx.fill();
        ctx.fillStyle = "#7f93a6";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, mp.x, mp.y);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
    }

    for (const d of defs) {
      const p = pmap.get(d.id)!;
      const s = stats[d.id];
      const kindColor = KIND_COLOR[d.kind] ?? "#94a3b8";
      const x = p.x - W / 2;
      const y = p.y - H / 2;
      const isSel = selected === d.id;
      const isHover = hover === d.id;
      const queueFull =
        Number.isFinite(d.queueLimit) && d.queueLimit > 0 && (s?.queue ?? 0) >= d.queueLimit;
      const hot =
        !queueFull &&
        Number.isFinite(d.queueLimit) &&
        d.queueLimit > 0 &&
        (s?.queue ?? 0) / d.queueLimit > 0.75;

      ctx.save();
      if (isSel) {
        ctx.shadowColor = kindColor;
        ctx.shadowBlur = 16;
      }
      roundRect(ctx, x, y, W, H, 11);
      ctx.fillStyle = isSel ? "#131d27" : isHover ? "#121a23" : "#0f161e";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = isSel ? 2.4 : 1.4;
      ctx.strokeStyle = d.crashed
        ? "#e05252"
        : s?.unhealthy
          ? "#f59e0b"
          : queueFull
            ? "#e05252"
            : hot
              ? "#d9a326"
              : kindColor;
      ctx.globalAlpha = isSel || isHover ? 1 : 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();

      ctx.fillStyle = kindColor;
      roundRect(ctx, x + 10, y + 12, 8, 8, 2);
      ctx.fill();

      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#e7f0f8";
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.fillText(d.label, x + 24, y + 21);

      const ls = lines(d, s);
      ctx.font = "11.5px ui-monospace, monospace";
      ctx.fillStyle = d.crashed || queueFull ? "#ff9c9c" : ls[0]?.startsWith("COLD") ? "#ffd88a" : "#8ba0b3";
      ctx.fillText(ls[0] ?? "", x + 12, y + 42);
      if (ls[1]) {
        ctx.fillStyle = "#6d8296";
        ctx.fillText(ls[1], x + 12, y + 60);
      }

      if (d.crashed) badge(ctx, x + W - 12, y + 16, "CRASHED", "#f87171");
      else if (s?.unhealthy) badge(ctx, x + W - 12, y + 16, "UNHEALTHY", "#f59e0b");
      else if (s?.refill) badge(ctx, x + W - 12, y + 16, "COLD", "#fbbf24");

      const util = s?.util ?? 0;
      if (Number.isFinite(d.capacityRps) && d.capacityRps > 0) {
        ctx.fillStyle = "#18222c";
        roundRect(ctx, x + 10, y + H - 9, W - 20, 4, 2);
        ctx.fill();
        if (util > 0.01) {
          ctx.fillStyle = util > 0.92 ? "#ef4444" : util > 0.75 ? "#f59e0b" : "#34d399";
          roundRect(ctx, x + 10, y + H - 9, Math.min(1, util) * (W - 20), 4, 2);
          ctx.fill();
        }
      }
    }
  }

  onMount(() => {
    const cv = canvas!;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      size.w = cv.parentElement!.clientWidth;
      size.h = cv.parentElement!.clientHeight;
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
      cv.style.width = `${size.w}px`;
      cv.style.height = `${size.h}px`;
      if (!touched) fit();
    });
    ro.observe(cv.parentElement!);
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });
</script>

<canvas
  bind:this={canvas}
  style="cursor: {drag ? 'grabbing' : hover ? 'grab' : 'default'}"
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointerleave={() => {
    hover = null;
    pan = null;
    drag = null;
  }}
  onwheel={onWheel}
></canvas>

<style>
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    touch-action: none;
  }
</style>

<script module lang="ts">
  const W = 156;
  const H = 76;
  const KIND_COLOR: Record<string, string> = {
    client: "#7dd3fc",
    lb: "#c4b5fd",
    ratelimiter: "#fb7185",
    cache: "#fbbf24",
    service: "#34d399",
    queue: "#f472b6",
    db: "#60a5fa",
  };
</script>
