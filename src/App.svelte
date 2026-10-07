<script lang="ts">
  import { onMount } from "svelte";
  import GraphCanvas from "./lib/GraphCanvas.svelte";
  import Inspector from "./lib/Inspector.svelte";
  import KnobControl from "./lib/KnobControl.svelte";
  import Sparkline from "./lib/Sparkline.svelte";
  import { explain } from "./sim/explain";
  import { SCENARIOS, scenarioById } from "./sim/scenarios";
  import type {
    FaultAction,
    KnobValue,
    Snapshot,
    TransportAction,
    WorkerInbound,
    WorkerOutbound,
  } from "./sim/types";

  let scenarioId = $state(SCENARIOS[0].id);
  let snap = $state<Snapshot | null>(null);
  let positions = $state<Record<string, { x: number; y: number }>>({});
  let selected = $state<string | null>(null);
  let knobValues = $state<Record<string, KnobValue>>({});

  const scenario = $derived(scenarioById(scenarioId));
  const insights = $derived(snap ? explain(snap, scenario) : []);
  const selDef = $derived(
    snap && selected ? (snap.defs.find((d) => d.id === selected) ?? null) : null,
  );
  const selStats = $derived(snap && selected ? (snap.stats[selected] ?? null) : null);
  const hasCache = $derived(scenario.nodes.some((n) => n.kind === "cache"));
  const t = $derived(snap?.totals ?? null);

  let worker: Worker | null = null;
  const post = (m: WorkerInbound) => worker?.postMessage(m);

  function loadScenario(id: string) {
    scenarioId = id;
    positions = {};
    selected = null;
    const sc = scenarioById(id);
    knobValues = Object.fromEntries(sc.knobs.map((k) => [k.id, k.def]));
    post({ type: "load", scenarioId: id });
  }

  function setKnob(id: string, v: KnobValue) {
    knobValues[id] = v;
    post({ type: "knob", knobId: id, value: v });
  }

  const fault = (a: FaultAction) => post({ type: "fault", action: a });
  const transport = (a: TransportAction) => post({ type: "transport", action: a });

  const num = (v: number) => Math.round(v).toLocaleString();
  const tone = (v: number, warn: number, bad: number) => (v >= bad ? "bad" : v >= warn ? "warn" : "good");
  const p95tone = $derived(t ? tone(t.p95, 700, 2000) : "good");
  const errtone = $derived(t ? tone(t.errPct, 1, 15) : "good");

  onMount(() => {
    worker = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerOutbound>) => {
      if (e.data.type === "snapshot") snap = e.data.snap;
    };
    knobValues = Object.fromEntries(scenario.knobs.map((k) => [k.id, k.def]));
    post({ type: "load", scenarioId });

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        transport({ kind: "togglePause" });
      } else if (e.key === "r" || e.key === "R") {
        transport({ kind: "reset" });
      } else if (e.key >= "1" && e.key <= "8") {
        const sc = SCENARIOS[Number(e.key) - 1];
        if (sc) loadScenario(sc.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      worker?.terminate();
    };
  });
</script>

<div class="app">
  <header>
    <div class="brand">
      <b>DistrLab</b>
      <span>break a distributed system in your browser</span>
    </div>

    <div class="scenarios">
      {#each SCENARIOS as sc, i (sc.id)}
        <button
          type="button"
          class:active={sc.id === scenarioId}
          onclick={() => loadScenario(sc.id)}
          title="press {i + 1}"
        >
          {sc.title}
        </button>
      {/each}
    </div>

    <div class="transport">
      <button type="button" onclick={() => transport({ kind: "reset" })} title="reset (R)">
        ⟲ reset
      </button>
      <button
        type="button"
        class:active={snap?.paused === false}
        onclick={() => transport({ kind: "togglePause" })}
        title="space"
      >
        {snap?.paused === false ? "⏸ pause" : "▶ play"}
      </button>
      {#each [0.5, 1, 2, 4] as s (s)}
        <button
          type="button"
          class:active={snap?.speed === s}
          onclick={() => transport({ kind: "speed", speed: s })}
        >
          {s}×
        </button>
      {/each}
      <span class="clock">t={snap ? (snap.t / 1000).toFixed(1) : "0.0"}s</span>
    </div>
  </header>

  <div class="stats">
    <div class="cell">
      <span class="k">p95</span>
      <span class="v {p95tone}">{t ? `${num(t.p95)}ms` : "—"}</span>
      <span class="k">p50 {t ? `${num(t.p50)}ms` : "—"}</span>
    </div>
    <div class="cell">
      <span class="k">throughput</span>
      <span class="v">{t ? num(t.doneRps) : "—"}</span>
      <span class="k">of {t ? num(t.capacityRps) : "—"} rps cap</span>
    </div>
    <div class="cell">
      <span class="k">errors</span>
      <span class="v {errtone}">{t ? `${t.errPct.toFixed(1)}%` : "—"}</span>
      <span class="k">{t ? num(t.timeouts + t.rejected + t.throttled + t.connErrors) : "0"} total</span>
    </div>
    <div class="cell">
      <span class="k">queued</span>
      <span class="v">{t ? num(t.totalQueue) : "—"}</span>
      <span class="k">{t ? num(t.inFlight) : "—"} in flight</span>
    </div>
    <div class="cell">
      <span class="k">arrival</span>
      <span class="v">{t ? num(t.arrivalRps) : "—"}</span>
      <span class="k">rps offered</span>
    </div>
  </div>

  <main>
    <div class="stage">
      {#if snap}
        <GraphCanvas
          defs={snap.defs}
          links={snap.links}
          stats={snap.stats}
          linkStats={snap.linkStats}
          settings={snap.settings}
          {positions}
          {selected}
          viewKey={scenarioId}
          onselect={(id) => (selected = id)}
          onmove={(id, x, y) => (positions[id] = { x, y })}
        />
      {/if}
    </div>

    <aside>
      <section class="block">
        <h3>What is happening</h3>
        {#if insights.length === 0}
          <p class="empty">Waiting for traffic…</p>
        {/if}
        {#each insights as ins, i (i)}
          <div class="insight {ins.tone}">{ins.text}</div>
        {/each}
      </section>

      <section class="block">
        <h3>Controls</h3>
        {#each scenario.knobs as k (k.id)}
          <KnobControl
            knob={k}
            value={knobValues[k.id] ?? k.def}
            onchange={(v) => setKnob(k.id, v)}
          />
        {/each}
      </section>

      {#if selDef && selStats}
        <section class="block">
          <h3>Node inspector</h3>
          <Inspector
            def={selDef}
            stats={selStats}
            links={snap?.links ?? []}
            linkStats={snap?.linkStats ?? {}}
            settings={snap?.settings ?? {
              arrivalRps: 0,
              timeoutMs: 4000,
              singleFlight: false,
              lbStrategy: "round-robin",
              healthChecks: false,
            }}
            onfault={fault}
            onselect={(id) => (selected = id)}
          />
        </section>
      {:else}
        <p class="empty">Click a node to inspect it, drag to rearrange, scroll to zoom.</p>
      {/if}

      <section class="block">
        <h3>{scenario.title}</h3>
        <p class="lesson">{scenario.lesson}</p>
        <h3>Try this</h3>
        <ul class="tips">
          {#each scenario.tips as tip (tip)}
            <li>{tip}</li>
          {/each}
        </ul>
      </section>
    </aside>
  </main>

  <div class="charts">
    <Sparkline
      label="latency p95"
      values={snap?.series.p95 ?? []}
      color="#38bdf8"
      unit="ms"
    />
    <Sparkline
      label="throughput"
      values={snap?.series.rps ?? []}
      color="#34d399"
      unit=" rps"
      goodHigh
    />
    <Sparkline
      label="error rate"
      values={snap?.series.errPct ?? []}
      color="#f87171"
      unit="%"
    />
    <Sparkline
      label="queue depth"
      values={snap?.series.queue ?? []}
      color="#fbbf24"
      unit=" reqs"
      goodHigh
    />
    {#if hasCache}
      <Sparkline
        label="cache hit ratio"
        values={snap?.series.hitPct ?? []}
        color="#c4b5fd"
        unit="%"
        goodHigh
      />
    {/if}
  </div>
</div>
