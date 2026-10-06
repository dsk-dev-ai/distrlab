<script lang="ts">
  interface Props {
    label: string;
    values: number[];
    color: string;
    unit?: string;
    format?: (v: number) => string;
    goodHigh?: boolean;
  }

  let { label, values, color, unit = "", format, goodHigh = false }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  const size = { w: 200, h: 132 };

  const fmt = (v: number) => (format ? format(v) : `${Math.round(v)}`);

  function draw() {
    const cv = canvas;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = size.w;
    const h = size.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 12;
    const padR = 12;
    const padT = 30;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.font = "600 10px system-ui, sans-serif";
    ctx.fillStyle = "#7f93a6";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.letterSpacing = "0.7px";
    ctx.fillText(label.toUpperCase(), padL, 16);
    ctx.letterSpacing = "0px";

    const last = values.length ? values[values.length - 1] : 0;
    ctx.font = "600 15px ui-monospace, monospace";
    ctx.textAlign = "right";
    const bad = !goodHigh && last > 0 && values.length > 4
      ? last >= sortedPct(values, 0.9) * 1.5
      : false;
    ctx.fillStyle = bad ? "#f87171" : color;
    ctx.fillText(`${fmt(last)}${unit}`, w - padR, 17);
    ctx.textAlign = "left";

    const max = Math.max(1, ...values) * 1.15;
    const n = values.length;

    ctx.strokeStyle = "#1a2530";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = padT + (plotH * i) / 2;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    if (n < 2) {
      ctx.fillStyle = "#4b5c6b";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("collecting…", w / 2, padT + plotH / 2);
      return;
    }

    const px = (i: number) => padL + (plotW * i) / (n - 1);
    const py = (v: number) => padT + plotH - (v / max) * plotH;

    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, color + "44");
    grad.addColorStop(1, color + "00");
    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(values[i]));
    ctx.lineTo(px(n - 1), padT + plotH);
    ctx.lineTo(px(0), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineJoin = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px(n - 1), py(values[n - 1]), 2.6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.fillStyle = "#4b5c6b";
    ctx.font = "9.5px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`max ${fmt(max / 1.15)}`, padL, h - 5);
    ctx.textAlign = "right";
    ctx.fillText(`${n} samples · 60s`, w - padR, h - 5);
  }

  function sortedPct(arr: number[], p: number): number {
    const c = [...arr].sort((a, b) => a - b);
    return c[Math.min(c.length - 1, Math.floor(c.length * p))];
  }

  $effect(() => {
    void values;
    draw();
  });

  import { onMount } from "svelte";

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
      draw();
    });
    ro.observe(cv.parentElement!);
    return () => ro.disconnect();
  });
</script>

<div class="chart">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .chart {
    position: relative;
    flex: 1;
    min-width: 0;
    background: var(--panel-2);
  }
</style>
