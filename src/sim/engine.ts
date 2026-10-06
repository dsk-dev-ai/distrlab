import type {
  FaultAction,
  GlobalSettings,
  KnobValue,
  LinkDef,
  LinkStats,
  NodeDef,
  NodeStats,
  Scenario,
  Series,
  Snapshot,
  Totals,
  TransportAction,
} from "./types";
import { scenarioById } from "./scenarios";

const SAMPLE_MS = 250;
const SERIES_CAP = 240;
const LAT_RING = 1024;
const MAX_ACTIVE = 40_000;

type ErrKind = "timeout" | "rejected" | "throttled" | "conn" | "crashed";

interface Req {
  id: number;
  born: number;
  state: "travel" | "queue" | "proc";
  /** destination while travelling, hosting node while queued/processing */
  node: number;
  /** origin node index while travelling */
  from: number;
  link: number;
  readyAt: number;
  session: number;
  hit?: boolean;
  warm?: boolean;
  hold?: boolean;
  cacheIdx?: number;
}

interface RtNode {
  def: NodeDef;
  q: Req[];
  qhead: number;
  proc: Req[];
  tokens: number;
  rr: number;
  nextExpireAt: number;
  refillUntil: number;
  upstream: number;
  hitWin: number;
  missWin: number;
  startWin: number;
  doneWin: number;
  errWin: number;
  readWin: number;
  staleWin: number;
  done: number;
  errors: number;
  rejected: number;
  throttled: number;
  rps: number;
  util: number;
  hitRatio: number | null;
  stalePct: number;
  unhealthy: boolean;
  healthEma: number;
  probeAt: number;
}

interface RtLink {
  def: LinkDef;
  carriedWin: number;
  latWin: number;
  carried: number;
  rps: number;
  avgLatMs: number;
}

const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);
const queueLen = (n: RtNode) => n.q.length - n.qhead;
const emptyWindow = () => ({
  arrivals: 0,
  ok: 0,
  timeout: 0,
  rejected: 0,
  throttled: 0,
  conn: 0,
  crashed: 0,
  reads: 0,
  stale: 0,
});

export class Engine {
  scenario: Scenario;
  settings: GlobalSettings = {
    arrivalRps: 0,
    timeoutMs: 4000,
    singleFlight: false,
    lbStrategy: "round-robin",
    healthChecks: false,
  };
  nodes: RtNode[] = [];
  links: RtLink[] = [];
  private index = new Map<string, number>();
  private adjacency = new Map<string, number>();
  private travel: Req[] = [];
  /** requests currently en route to node i — visible to the balancer */
  private arriving: number[] = [];
  private nextId = 1;
  private spawnAcc = 0;
  private nextSampleAt = SAMPLE_MS;
  t = 0;
  paused = false;
  speed = 1;

  private lat = new Array<number>(LAT_RING).fill(0);
  private latHead = 0;
  private latCount = 0;
  private win = emptyWindow();
  private totals: Totals = {
    arrivalRps: 0,
    doneRps: 0,
    errPct: 0,
    p50: 0,
    p95: 0,
    timeouts: 0,
    rejected: 0,
    throttled: 0,
    connErrors: 0,
    staleReads: 0,
    inFlight: 0,
    capacityRps: 0,
    totalQueue: 0,
  };
  series: Series = { t: [], p95: [], rps: [], errPct: [], queue: [], hitPct: [] };

  constructor(scenarioId: string) {
    this.scenario = scenarioById(scenarioId);
    this.load(scenarioId);
  }

  load(scenarioId: string): void {
    this.scenario = scenarioById(scenarioId);
    this.t = 0;
    this.paused = false;
    this.speed = 1;
    this.travel = [];
    this.spawnAcc = 0;
    this.nextSampleAt = SAMPLE_MS;
    this.nextId = 1;
    this.lat = new Array<number>(LAT_RING).fill(0);
    this.latHead = 0;
    this.latCount = 0;
    this.win = emptyWindow();
    this.series = { t: [], p95: [], rps: [], errPct: [], queue: [], hitPct: [] };
    this.totals = {
      arrivalRps: 0,
      doneRps: 0,
      errPct: 0,
      p50: 0,
      p95: 0,
      timeouts: 0,
      rejected: 0,
      throttled: 0,
      connErrors: 0,
      staleReads: 0,
      inFlight: 0,
      capacityRps: 0,
      totalQueue: 0,
    };

    this.index = new Map();
    this.nodes = this.scenario.nodes.map((def) => {
      this.index.set(def.id, this.index.size);
      return {
        def: structuredClone(def),
        q: [],
        qhead: 0,
        proc: [],
        tokens: 0,
        rr: 0,
        nextExpireAt: Number.POSITIVE_INFINITY,
        refillUntil: 0,
        upstream: 0,
        hitWin: 0,
        missWin: 0,
        startWin: 0,
        doneWin: 0,
        errWin: 0,
        readWin: 0,
        staleWin: 0,
        done: 0,
        errors: 0,
        rejected: 0,
        throttled: 0,
        rps: 0,
        util: 0,
        hitRatio: null,
        stalePct: 0,
        unhealthy: false,
        healthEma: 0,
        probeAt: 0,
      } satisfies RtNode;
    });
    this.arriving = new Array<number>(this.nodes.length).fill(0);
    this.links = this.scenario.links.map((def) => ({
      def: structuredClone(def),
      carriedWin: 0,
      latWin: 0,
      carried: 0,
      rps: 0,
      avgLatMs: 0,
    }));
    this.adjacency = new Map();
    this.links.forEach((l, i) => {
      const a = this.index.get(l.def.from);
      const b = this.index.get(l.def.to);
      if (a !== undefined && b !== undefined) this.adjacency.set(`${a}>${b}`, i);
    });
    for (const k of this.scenario.knobs) this.setKnob(k.id, k.def);
    for (const n of this.nodes)
      if (n.def.kind === "ratelimiter") n.tokens = n.def.bucketSize ?? 100;
  }

  setKnob(knobId: string, value: KnobValue): void {
    const k = this.scenario.knobs.find((x) => x.id === knobId);
    if (!k) return;
    const v =
      k.type === "range" ? Number(value) : k.type === "toggle" ? Boolean(value) : String(value);
    const t = k.target;
    if (t.scope === "global") {
      (this.settings as unknown as Record<string, KnobValue>)[t.field] = v;
    } else if (t.scope === "node") {
      const n = this.nodes[this.index.get(t.id) ?? -1];
      if (n) (n.def as unknown as Record<string, KnobValue>)[t.field] = v;
    } else if (t.scope === "kind") {
      for (const n of this.nodes)
        if (n.def.kind === t.kind) (n.def as unknown as Record<string, KnobValue>)[t.field] = v;
    } else {
      const l = this.links.find((x) => x.def.id === t.id);
      if (l) (l.def as unknown as Record<string, KnobValue>)[t.field] = v;
    }
  }

  fault(action: FaultAction): void {
    if (action.kind === "partition") {
      const l = this.links.find((x) => x.def.id === action.linkId);
      if (l) l.def.partitioned = action.on;
      return;
    }
    const i = this.index.get(action.nodeId);
    const n = i === undefined ? undefined : this.nodes[i];
    if (!n || i === undefined) return;
    if (action.kind === "crash") {
      n.def.crashed = true;
      while (n.qhead < n.q.length) this.fail("crashed", n.q[n.qhead++], i);
      n.q = [];
      n.qhead = 0;
      for (const r of n.proc) this.fail("crashed", r, i);
      n.proc = [];
    } else if (action.kind === "restart") {
      n.def.crashed = false;
      n.tokens = 0;
      n.unhealthy = false;
      n.healthEma = 0;
      n.probeAt = 0;
    } else if (action.kind === "expire") {
      n.refillUntil = this.t + (n.def.refillMs ?? 2000);
      n.upstream = 0;
      n.nextExpireAt = Number.POSITIVE_INFINITY;
    } else if (action.kind === "slow") {
      n.def.faultLatencyMs = action.ms;
    }
  }

  transport(action: TransportAction): void {
    if (action.kind === "togglePause") this.paused = !this.paused;
    else if (action.kind === "speed") this.speed = action.speed;
    else if (action.kind === "reset") this.load(this.scenario.id);
  }

  advance(ms: number): void {
    if (this.paused) return;
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 20);
      this.tick(step);
      left -= step;
    }
  }

  // ------------------------------------------------------------------ tick

  private tick(ms: number): void {
    this.t += ms;
    const t = this.t;
    const dtSec = ms / 1000;

    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];

      if (n.def.kind === "ratelimiter") {
        n.tokens = Math.min(
          n.tokens + (n.def.refillRps ?? 0) * dtSec,
          n.def.bucketSize ?? 100,
        );
      } else if (Number.isFinite(n.def.capacityRps)) {
        n.tokens = Math.min(n.tokens + n.def.capacityRps * dtSec, n.def.capacityRps * 0.1);
        let guard = 0;
        while (n.tokens >= 1 && n.qhead < n.q.length && guard++ < 4000) {
          const r = n.q[n.qhead];
          if (r.hold) break;
          n.qhead++;
          n.tokens -= 1;
          n.startWin++;
          r.state = "proc";
          r.readyAt = t + this.serviceTime(n);
          n.proc.push(r);
        }
        if (n.qhead >= n.q.length) {
          n.q = [];
          n.qhead = 0;
        }
      }

      for (let j = n.proc.length - 1; j >= 0; j--) {
        const r = n.proc[j];
        if (r.readyAt > t) continue;
        n.proc.splice(j, 1);
        if (r.hit) this.complete(r, n, i);
        else this.forwardFrom(n, r, i);
      }
    }

    for (let j = this.travel.length - 1; j >= 0; j--) {
      const r = this.travel[j];
      if (r.readyAt > t) continue;
      this.travel.splice(j, 1);
      this.arrive(r);
    }

    const timeout = this.settings.timeoutMs;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      for (let k = n.q.length - 1; k >= n.qhead; k--) {
        if (t - n.q[k].born > timeout) {
          this.fail("timeout", n.q[k], i);
          n.q.splice(k, 1);
        }
      }
      for (let k = n.proc.length - 1; k >= 0; k--) {
        if (t - n.proc[k].born > timeout) {
          this.fail("timeout", n.proc[k], i);
          n.proc.splice(k, 1);
        }
      }
      if (n.qhead >= n.q.length && n.q.length > 0) {
        n.q = [];
        n.qhead = 0;
      }
    }
    for (let j = this.travel.length - 1; j >= 0; j--) {
      const r = this.travel[j];
      if (t - r.born <= timeout) continue;
      this.travel.splice(j, 1);
      this.arriving[r.node] = Math.max(0, this.arriving[r.node] - 1);
      this.fail("timeout", r, r.node);
    }

    this.spawn(ms);

    if (t >= this.nextSampleAt) {
      this.nextSampleAt = t + SAMPLE_MS;
      this.sample(SAMPLE_MS / 1000);
    }
  }

  private serviceTime(n: RtNode): number {
    return jitter(n.def.baseLatencyMs) + (n.def.faultLatencyMs ?? 0);
  }

  private spawn(ms: number): void {
    const rate = this.settings.arrivalRps;
    this.spawnAcc += (rate * ms) / 1000;
    this.spawnAcc *= 0.999 + Math.random() * 0.002;
    const n = Math.floor(this.spawnAcc);
    if (n <= 0) return;
    this.spawnAcc -= n;
    const start = this.index.get(this.scenario.start);
    if (start === undefined) return;
    const active =
      this.travel.length + this.nodes.reduce((a, x) => a + queueLen(x) + x.proc.length, 0);
    if (active > MAX_ACTIVE) return;

    const hops = this.scenario.next[this.scenario.start] ?? [];
    if (hops.length === 0) return;
    const to = this.index.get(hops[0]);
    if (to === undefined) return;

    for (let k = 0; k < n; k++) {
      const r: Req = {
        id: this.nextId++,
        born: this.t,
        state: "travel",
        node: to,
        from: start,
        link: -1,
        readyAt: 0,
        session: Math.floor(Math.random() * 64),
      };
      this.win.arrivals++;
      this.nodes[start].startWin++;
      this.pushTravel(r, start, to);
    }
  }

  private pushTravel(r: Req, from: number, to: number): void {
    const linkIdx = this.adjacency.get(`${from}>${to}`);
    r.state = "travel";
    r.node = to;
    r.from = from;
    r.link = linkIdx ?? -1;
    if (linkIdx === undefined) {
      r.readyAt = this.t;
      this.arriving[to]++;
      this.travel.push(r);
      return;
    }
    const l = this.links[linkIdx];
    l.carriedWin++;
    l.latWin += l.def.latencyMs;
    if (l.def.partitioned) {
      r.readyAt = Number.POSITIVE_INFINITY;
    } else if (l.def.errorProb !== undefined && Math.random() < l.def.errorProb) {
      this.fail("conn", r, to);
      return;
    } else {
      r.readyAt = this.t + jitter(l.def.latencyMs);
    }
    this.arriving[to]++;
    this.travel.push(r);
  }

  private arrive(r: Req): void {
    const i = r.node;
    this.arriving[i] = Math.max(0, this.arriving[i] - 1);
    const n = this.nodes[i];
    if (n.def.crashed) return this.fail("crashed", r, i);

    switch (n.def.kind) {
      case "lb": {
        const target = this.pickLbTarget(n, r);
        if (target === undefined) return this.fail("rejected", r, i);
        return this.pushTravel(r, i, target);
      }
      case "ratelimiter": {
        if (n.tokens < 1) {
          n.throttled++;
          return this.fail("throttled", r, i);
        }
        n.tokens -= 1;
        return this.forwardFrom(n, r, i);
      }
      case "cache": {
        if (n.refillUntil > 0 && this.t >= n.refillUntil && n.upstream === 0) {
          n.refillUntil = 0;
          n.nextExpireAt = this.t + (n.def.ttlMs ?? 10_000);
        }
        if (n.nextExpireAt === Number.POSITIVE_INFINITY)
          n.nextExpireAt = this.t + (n.def.ttlMs ?? 10_000);
        if (this.t >= n.nextExpireAt && n.refillUntil <= this.t) {
          n.refillUntil = this.t + (n.def.refillMs ?? 2000);
          n.upstream = 0;
          n.nextExpireAt = Number.POSITIVE_INFINITY;
        }
        const cold = n.refillUntil > this.t;
        if (cold) {
          if (n.upstream > 0 && this.settings.singleFlight) {
            if (queueLen(n) >= n.def.queueLimit) {
              n.rejected++;
              return this.fail("rejected", r, i);
            }
            r.hold = true;
            r.state = "queue";
            r.cacheIdx = i;
            n.q.push(r);
            return;
          }
          if (n.upstream === 0) {
            n.upstream = 1;
            r.warm = true;
            r.cacheIdx = i;
          }
          n.missWin++;
          return this.forwardFrom(n, r, i);
        }
        if (Math.random() >= (n.def.hitRatio ?? 0.8)) {
          n.missWin++;
          return this.forwardFrom(n, r, i);
        }
        n.hitWin++;
        r.hit = true;
        r.state = "proc";
        r.readyAt = this.t + this.serviceTime(n);
        n.proc.push(r);
        return;
      }
      default: {
        if (queueLen(n) >= n.def.queueLimit) {
          n.rejected++;
          return this.fail("rejected", r, i);
        }
        r.state = "queue";
        r.hold = false;
        n.q.push(r);
      }
    }
  }

  private forwardFrom(n: RtNode, r: Req, i: number): void {
    const hops = this.scenario.next[n.def.id] ?? [];
    if (hops.length === 0) return this.complete(r, n, i);
    const to = this.index.get(hops[0]);
    if (to === undefined) return this.complete(r, n, i);
    this.pushTravel(r, i, to);
  }

  private inflightOf(idx: number): number {
    const n = this.nodes[idx];
    return queueLen(n) + n.proc.length + this.arriving[idx];
  }

  private pickLbTarget(n: RtNode, r: Req): number | undefined {
    const ids = n.def.targets ?? [];
    const all = ids
      .map((id) => this.index.get(id))
      .filter((x): x is number => x !== undefined);
    if (all.length === 0) return undefined;

    let candidates = all.filter((idx) => {
      const t = this.nodes[idx];
      if (t.def.crashed) return false;
      if (this.settings.healthChecks && t.unhealthy) return false;
      return true;
    });
    if (candidates.length === 0) {
      // everything looks dead: probe, one target at a time
      const ready = all.filter((idx) => this.nodes[idx].probeAt <= this.t);
      candidates =
        ready.length > 0
          ? ready
          : [all.reduce((a, b) => (this.nodes[a].probeAt <= this.nodes[b].probeAt ? a : b))];
    }

    const strat = this.settings.lbStrategy;
    let chosen: number;
    if (strat === "random") chosen = candidates[Math.floor(Math.random() * candidates.length)];
    else if (strat === "sticky") chosen = candidates[r.session % candidates.length];
    else if (strat === "least-inflight") {
      chosen = candidates[0];
      let bestLoad = Infinity;
      for (const idx of candidates) {
        const load = this.inflightOf(idx);
        if (load < bestLoad) {
          bestLoad = load;
          chosen = idx;
        }
      }
    } else {
      chosen = candidates[n.rr % candidates.length];
      n.rr++;
    }

    if (this.settings.healthChecks && this.nodes[chosen].unhealthy)
      this.nodes[chosen].probeAt = this.t + 1000;
    return chosen;
  }

  private complete(r: Req, n: RtNode, i: number): void {
    n.done++;
    n.doneWin++;
    this.win.ok++;
    this.pushLat(this.t - r.born);
    if (n.def.kind === "db") {
      const isWrite = Math.random() < (n.def.writeFraction ?? 0);
      if (!isWrite) {
        n.readWin++;
        this.win.reads++;
        if ((n.def.replicaLagMs ?? 0) > 0) {
          n.staleWin++;
          this.win.stale++;
          this.totals.staleReads++;
        }
      }
    }
    if (r.warm && r.cacheIdx !== undefined) this.releaseWarm(this.nodes[r.cacheIdx], r);
  }

  /** a refill request finished: the cache is warm again */
  private releaseWarm(n: RtNode, r: Req): void {
    if (r.cacheIdx === undefined) return;
    n.upstream = 0;
    n.refillUntil = 0;
    n.nextExpireAt = this.t + (n.def.ttlMs ?? 10_000);
    for (let k = n.qhead; k < n.q.length; k++) {
      const h = n.q[k];
      if (!h.hold) continue;
      h.hold = false;
      h.hit = true;
      h.state = "proc";
      h.readyAt = this.t + this.serviceTime(n);
      n.proc.push(h);
      n.hitWin++;
    }
    n.q = n.q.slice(n.qhead);
    n.qhead = 0;
  }

  /** the refill request died: hand the job to the next waiter */
  private promoteWarm(cacheIdx: number): void {
    const c = this.nodes[cacheIdx];
    if (c.refillUntil <= this.t || !this.settings.singleFlight) return;
    for (let k = c.qhead; k < c.q.length; k++) {
      const h = c.q[k];
      if (!h.hold) continue;
      h.hold = false;
      h.warm = true;
      h.cacheIdx = cacheIdx;
      c.upstream = 1;
      c.missWin++;
      this.forwardFrom(c, h, cacheIdx);
      return;
    }
  }

  private fail(kind: ErrKind, r: Req, nodeIdx: number): void {
    if (nodeIdx >= 0) {
      const n = this.nodes[nodeIdx];
      if (n) {
        n.errors++;
        n.errWin++;
      }
    }
    if (kind === "timeout") this.totals.timeouts++;
    else if (kind === "rejected") this.totals.rejected++;
    else if (kind === "throttled") this.totals.throttled++;
    else if (kind === "conn") this.totals.connErrors++;
    this.win[kind]++;
    this.pushLat(this.t - r.born);
    if (r.warm && r.cacheIdx !== undefined) {
      const c = this.nodes[r.cacheIdx];
      c.upstream = 0;
      this.promoteWarm(r.cacheIdx);
    }
  }

  private pushLat(v: number): void {
    this.lat[this.latHead] = v;
    this.latHead = (this.latHead + 1) % LAT_RING;
    this.latCount = Math.min(this.latCount + 1, LAT_RING);
  }

  private pct(p: number): number {
    if (this.latCount === 0) return 0;
    const n = Math.min(this.latCount, 512);
    const arr: number[] = [];
    for (let k = 0; k < n; k++) arr.push(this.lat[(this.latHead - 1 - k + LAT_RING * 2) % LAT_RING]);
    arr.sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
  }

  private sample(sec: number): void {
    const w = this.win;
    const total = w.ok + w.timeout + w.rejected + w.throttled + w.conn + w.crashed;
    const errs = total - w.ok;
    let queue = 0;
    let capacity = 0;
    let hits = 0;
    let misses = 0;

    for (const n of this.nodes) {
      queue += queueLen(n);
      if (!n.def.crashed && Number.isFinite(n.def.capacityRps)) capacity += n.def.capacityRps;
      if (n.def.kind === "cache") {
        hits += n.hitWin;
        misses += n.missWin;
        n.hitRatio = n.hitWin + n.missWin > 0 ? n.hitWin / (n.hitWin + n.missWin) : null;
      }
      if (n.def.kind === "db")
        n.stalePct = n.readWin > 0 ? (n.staleWin / n.readWin) * 100 : 0;
      n.rps = n.rps * 0.5 + (n.doneWin / sec) * 0.5;
      n.util =
        Number.isFinite(n.def.capacityRps) && n.def.capacityRps > 0
          ? Math.min(1.5, n.startWin / (n.def.capacityRps * sec))
          : 0;
      const winTotal = n.doneWin + n.errWin;
      if (winTotal > 0) {
        const rate = n.errWin / winTotal;
        const a = rate > 0 ? Math.min(0.6, 0.15 + winTotal / 20) : 0.4;
        n.healthEma = n.healthEma * (1 - a) + rate * a;
      }
      n.unhealthy = !n.def.crashed && n.def.kind !== "client" && n.healthEma > 0.5;
      n.doneWin = 0;
      n.errWin = 0;
      n.startWin = 0;
      n.hitWin = 0;
      n.missWin = 0;
      n.readWin = 0;
      n.staleWin = 0;
    }
    for (const l of this.links) {
      l.rps = l.rps * 0.5 + (l.carriedWin / sec) * 0.5;
      l.avgLatMs = l.carriedWin > 0 ? l.latWin / l.carriedWin : 0;
      l.carried += l.carriedWin;
      l.carriedWin = 0;
      l.latWin = 0;
    }

    this.totals.arrivalRps = w.arrivals / sec;
    this.totals.doneRps = w.ok / sec;
    this.totals.errPct = total > 0 ? (errs / total) * 100 : 0;
    this.totals.p50 = this.pct(50);
    this.totals.p95 = this.pct(95);
    this.totals.inFlight =
      this.travel.length + this.nodes.reduce((a, x) => a + queueLen(x) + x.proc.length, 0);
    this.totals.capacityRps = capacity;
    this.totals.totalQueue = queue;

    const hitPct = hits + misses > 0 ? (hits / (hits + misses)) * 100 : NaN;
    const s = this.series;
    s.t.push(Math.round(this.t));
    s.p95.push(Math.round(this.totals.p95));
    s.rps.push(Math.round(this.totals.doneRps));
    s.errPct.push(Math.round(this.totals.errPct * 10) / 10);
    s.queue.push(queue);
    s.hitPct.push(Number.isNaN(hitPct) ? 0 : Math.round(hitPct));
    while (s.t.length > SERIES_CAP) {
      s.t.shift();
      s.p95.shift();
      s.rps.shift();
      s.errPct.shift();
      s.queue.shift();
      s.hitPct.shift();
    }

    this.win = emptyWindow();
  }

  snapshot(): Snapshot {
    const stats: Record<string, NodeStats> = {};
    const defs: NodeDef[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      defs.push(n.def);
      stats[n.def.id] = {
        queue: queueLen(n),
        processing: n.proc.length,
        inflight: queueLen(n) + n.proc.length + this.arriving[i],
        rejected: n.rejected,
        throttled: n.throttled,
        errors: n.errors,
        done: n.done,
        rps: Math.round(n.rps),
        util: Math.min(1, n.util),
        hitRatio: n.hitRatio,
        refill: n.refillUntil > this.t,
        stalePct: n.stalePct,
        unhealthy: n.unhealthy,
      };
    }
    const linkStats: Record<string, LinkStats> = {};
    const links: LinkDef[] = [];
    for (const l of this.links) {
      links.push(l.def);
      linkStats[l.def.id] = {
        rps: Math.round(l.rps),
        avgLatMs: Math.round(l.avgLatMs * 10) / 10,
        carried: l.carried,
      };
    }
    return {
      t: this.t,
      paused: this.paused,
      speed: this.speed,
      settings: { ...this.settings },
      defs,
      links,
      stats,
      linkStats,
      series: this.series,
      totals: { ...this.totals },
    };
  }
}
