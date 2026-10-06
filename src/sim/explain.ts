import type { Scenario, Snapshot } from "./types";

export interface Insight {
  tone: "bad" | "warn" | "good" | "info";
  text: string;
}

const pct = (v: number) => `${v.toFixed(1)}%`;
const whole = (v: number) => Math.round(v).toLocaleString();

export function explain(snap: Snapshot, sc: Scenario): Insight[] {
  const out: Insight[] = [];
  const t = snap.totals;
  const rows = snap.defs.map((d) => ({ def: d, s: snap.stats[d.id] }));
  const cache = rows.find((n) => n.def.kind === "cache");
  const db = rows.find((n) => n.def.kind === "db");

  const partitioned = snap.links.filter((l) => l.partitioned);
  const crashed = rows.filter((n) => n.def.crashed);
  const cold = rows.filter((n) => n.s?.refill);
  const unhealthy = rows.filter((n) => n.s?.unhealthy && !n.def.crashed);

  const fill = rows
    .filter((n) => Number.isFinite(n.def.queueLimit) && n.def.queueLimit > 0)
    .map((n) => ({ n, fill: n.s.queue / n.def.queueLimit }))
    .sort((a, b) => b.fill - a.fill)[0];

  for (const l of partitioned)
    out.push({
      tone: "bad",
      text: `Partition on ${l.from} → ${l.to}: nothing is refused there, requests just hang until the client timeout fires.`,
    });

  for (const n of crashed)
    out.push({
      tone: "bad",
      text: `${n.def.label} is crashed — every request that reaches it fails instantly with 503.`,
    });

  if (t.errPct > 0.5) {
    const parts: string[] = [];
    if (t.timeouts > 0) parts.push(`${whole(t.timeouts)} timeouts so far`);
    if (t.rejected > 0) parts.push(`${whole(t.rejected)} rejected with 503`);
    if (t.throttled > 0) parts.push(`${whole(t.throttled)} shed with 429`);
    if (t.connErrors > 0) parts.push(`${whole(t.connErrors)} connection errors`);
    out.push({
      tone: t.errPct > 15 ? "bad" : "warn",
      text: `${pct(t.errPct)} of requests fail right now: ${parts.slice(0, 3).join(", ")}.`,
    });
  }

  if (fill && fill.fill > 0.75) {
    const n = fill.n;
    out.push({
      tone: fill.fill >= 1 ? "bad" : "warn",
      text: `${n.def.label}'s queue is ${Math.round(fill.fill * 100)}% full (${n.s.queue}/${n.def.queueLimit}). ${
        n.s.queue >= n.def.queueLimit
          ? "New arrivals are rejected now."
          : "The queue absorbs the burst, then it starts rejecting."
      }`,
    });
  } else if (t.capacityRps > 0 && t.arrivalRps > t.capacityRps * 1.02) {
    out.push({
      tone: "warn",
      text: `Arrival (${whole(t.arrivalRps)} rps) exceeds total capacity (${whole(
        t.capacityRps,
      )} rps): the surplus can only be queued or rejected.`,
    });
  }

  if (t.p95 > 2000)
    out.push({
      tone: "bad",
      text: `p95 is ${whole(t.p95)} ms — almost all of it spent waiting in queues, not doing real work.`,
    });
  else if (t.p95 > 700 && t.errPct <= 0.5)
    out.push({
      tone: "warn",
      text: `p95 is ${whole(t.p95)} ms with no errors: the system absorbs the load, but users wait.`,
    });

  for (const n of cold)
    out.push({
      tone: snap.settings.singleFlight ? "info" : "warn",
      text: snap.settings.singleFlight
        ? `${n.def.label} is cold and single-flight is on: one request refills it while the rest wait instead of stampeding.`
        : `${n.def.label} is in its refill window: every request misses and hits the service behind it.`,
    });

  for (const n of unhealthy)
    out.push({
      tone: "info",
      text: `Health checks marked ${n.def.label} out of rotation — recent error rate too high to trust.`,
    });

  if (t.throttled > 0)
    out.push({
      tone: "info",
      text: `The rate limiter is shedding with 429s: a fast, cheap failure instead of a slow timeout downstream.`,
    });

  if (db && db.s.stalePct > 0)
    out.push({
      tone: "warn",
      text: `${pct(db.s.stalePct)} of reads are stale — the replica is ${db.def.replicaLagMs} ms behind and every one of them still returned 200 OK.`,
    });

  if (cache && cache.s.hitRatio !== null && !cache.s.refill) {
    const h = cache.s.hitRatio * 100;
    out.push({
      tone: h > 50 ? "good" : "warn",
      text: `Cache hit ratio ${Math.round(h)}% — the other ${Math.round(100 - h)}% pay the full trip to the database.`,
    });
  }

  if (t.arrivalRps < 1 && snap.t > 1000)
    return [{ tone: "info", text: "No traffic — press play or raise the arrival rate." }];

  if (out.length === 0 && t.errPct < 0.5)
    out.push({
      tone: "good",
      text: `Healthy: ${whole(t.doneRps)} rps through, p95 ${whole(t.p95)} ms, ${pct(
        t.errPct,
      )} errors, ${whole(t.totalQueue)} queued.`,
    });

  void sc;
  return out.slice(0, 5);
}
