<script lang="ts">
  import type {
    FaultAction,
    GlobalSettings,
    LinkDef,
    LinkStats,
    NodeDef,
    NodeStats,
  } from "../sim/types";

  interface Props {
    def: NodeDef;
    stats: NodeStats;
    links: LinkDef[];
    linkStats: Record<string, LinkStats>;
    settings: GlobalSettings;
    onfault: (a: FaultAction) => void;
    onselect: (id: string | null) => void;
  }

  let { def, stats, links, linkStats, settings, onfault, onselect }: Props = $props();

  const connected = $derived(links.filter((l) => l.from === def.id || l.to === def.id));

  const items = $derived.by(() => {
    const list: { k: string; v: string }[] = [
      { k: "throughput", v: `${stats.rps} rps` },
      { k: "queue", v: `${stats.queue}` },
      { k: "in flight", v: `${stats.inflight}` },
      { k: "utilisation", v: `${Math.round(stats.util * 100)}%` },
      { k: "served", v: stats.done.toLocaleString() },
      { k: "errors", v: stats.errors.toLocaleString() },
    ];
    if (stats.rejected > 0) list.push({ k: "rejected 503", v: stats.rejected.toLocaleString() });
    if (stats.throttled > 0) list.push({ k: "shed 429", v: stats.throttled.toLocaleString() });
    if (def.kind === "cache" && stats.hitRatio !== null)
      list.push({ k: "hit ratio", v: `${Math.round(stats.hitRatio * 100)}%` });
    if (def.kind === "db" && (def.replicaLagMs ?? 0) > 0)
      list.push({ k: "stale reads", v: `${Math.round(stats.stalePct)}%` });
    return list;
  });

  const healthClass = $derived(
    def.crashed ? "bad" : stats.unhealthy ? "warn" : stats.util > 0.9 ? "warn" : "good",
  );
  const healthText = $derived(
    def.crashed ? "crashed" : stats.unhealthy ? "unhealthy" : stats.util > 0.9 ? "saturated" : "healthy",
  );
</script>

<div class="inspector">
  <div class="title">
    <b>{def.label}</b>
    <span class="pill">{def.kind}</span>
    <span class="pill {healthClass}">{healthText}</span>
    <span style="flex:1"></span>
    <button type="button" onclick={() => onselect(null)}>✕</button>
  </div>

  <div class="grid">
    {#each items as it (it.k)}
      <div class="item">
        <div class="k">{it.k}</div>
        <div class="v">{it.v}</div>
      </div>
    {/each}
  </div>

  <div class="actions">
    {#if def.kind !== "client"}
      {#if def.crashed}
        <button type="button" onclick={() => onfault({ kind: "restart", nodeId: def.id })}>
          Restart
        </button>
      {:else}
        <button
          type="button"
          class="danger"
          onclick={() => onfault({ kind: "crash", nodeId: def.id })}
        >
          Crash it
        </button>
      {/if}
    {/if}
    {#if def.kind === "service" || def.kind === "db" || def.kind === "queue"}
      {#if def.faultLatencyMs}
        <button type="button" onclick={() => onfault({ kind: "slow", nodeId: def.id, ms: 0 })}>
          Remove +{def.faultLatencyMs}ms fault
        </button>
      {:else}
        <button type="button" onclick={() => onfault({ kind: "slow", nodeId: def.id, ms: 150 })}>
          Add 150ms latency
        </button>
      {/if}
    {/if}
    {#if def.kind === "cache"}
      <button type="button" onclick={() => onfault({ kind: "expire", nodeId: def.id })}>
        Expire cache now
      </button>
    {/if}
  </div>

  {#if connected.length > 0}
    <div style="margin-top:12px">
      <h3 style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted)">
        Links
      </h3>
      {#each connected as l (l.id)}
        <div class="linkrow">
          <span class="name">{l.from} → {l.to}</span>
          <span style="color:var(--muted);font-family:var(--mono);font-size:11.5px">
            {linkStats[l.id]?.rps ?? 0}/s · {l.latencyMs}ms
          </span>
          <button
            type="button"
            class:active={l.partitioned}
            onclick={() => onfault({ kind: "partition", linkId: l.id, on: !l.partitioned })}
          >
            {l.partitioned ? "repair" : "partition"}
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if settings.lbStrategy && def.kind === "lb"}
    <p class="empty" style="margin-top:10px">
      Routing with <b style="color:var(--accent)">{settings.lbStrategy}</b>
      {settings.healthChecks ? "· health checks on" : "· health checks off"}.
    </p>
  {/if}
</div>
