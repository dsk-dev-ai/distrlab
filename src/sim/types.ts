export type NodeKind =
  | "client"
  | "lb"
  | "ratelimiter"
  | "breaker"
  | "cache"
  | "service"
  | "queue"
  | "db";

export type LbStrategy =
  | "round-robin"
  | "random"
  | "least-inflight"
  | "sticky"
  | "least-latency"
  | "p2c";

export type CircuitState = "closed" | "open" | "half-open";

export interface NodeDef {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  /** average processing time of one request inside the node */
  baseLatencyMs: number;
  /** requests per second the node may start processing */
  capacityRps: number;
  /** max waiting requests before new arrivals are rejected with 503 */
  queueLimit: number;
  /** lb: candidate service ids */
  targets?: string[];
  /** cache: steady-state hit ratio */
  hitRatio?: number;
  /** cache: time between TTL expiries */
  ttlMs?: number;
  /** cache: length of the cold refill window */
  refillMs?: number;
  /** ratelimiter: sustained refill rate */
  refillRps?: number;
  /** ratelimiter: bucket depth */
  bucketSize?: number;
  /** breaker: enabled/disabled (disabled = transparent pass-through) */
  enabled?: boolean;
  /** breaker: error-rate threshold that trips the circuit open (0..1) */
  tripsAt?: number;
  /** breaker: time spent OPEN before the first half-open probe */
  cooldownMs?: number;
  /** breaker: request limit allowed through while half-open */
  probeLimit?: number;
  /** breaker: rolling window (number of calls) the error rate is measured over */
  cbWindow?: number;
  /** db: replica lag in ms (0 = reads served by the primary) */
  replicaLagMs?: number;
  /** db: fraction of traffic that writes */
  writeFraction?: number;
  /** extra latency injected by a fault */
  faultLatencyMs?: number;
  crashed?: boolean;
}

export interface LinkDef {
  id: string;
  from: string;
  to: string;
  latencyMs: number;
  partitioned?: boolean;
  /** probability a request dies crossing this link */
  errorProb?: number;
}

export type KnobTarget =
  | { scope: "global"; field: GlobalSettingName }
  | { scope: "node"; id: string; field: keyof NodeDef }
  | { scope: "kind"; kind: NodeKind; field: keyof NodeDef }
  | { scope: "link"; id: string; field: keyof LinkDef };

export type KnobValue = number | boolean | string;

export interface Knob {
  id: string;
  label: string;
  type: "range" | "toggle" | "select";
  target: KnobTarget;
  def: KnobValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

export type GlobalSettingName =
  | "arrivalRps"
  | "timeoutMs"
  | "singleFlight"
  | "lbStrategy"
  | "healthChecks";

export interface GlobalSettings {
  arrivalRps: number;
  timeoutMs: number;
  singleFlight: boolean;
  lbStrategy: LbStrategy;
  healthChecks: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  lesson: string;
  tips: string[];
  start: string;
  /** node id -> ids it forwards to when it finishes processing */
  next: Record<string, string[]>;
  nodes: NodeDef[];
  links: LinkDef[];
  knobs: Knob[];
}

export interface NodeStats {
  queue: number;
  processing: number;
  inflight: number;
  rejected: number;
  throttled: number;
  errors: number;
  done: number;
  rps: number;
  util: number;
  /** cache only: observed hit ratio */
  hitRatio: number | null;
  /** cache only: inside the cold window */
  refill: boolean;
  /** db only: share of reads served stale */
  stalePct: number;
  /** true when a health check marks it unusable */
  unhealthy: boolean;
  /** breaker only: circuit state */
  circuit?: CircuitState;
}

export interface LinkStats {
  rps: number;
  avgLatMs: number;
  carried: number;
}

export interface Series {
  t: number[];
  p95: number[];
  rps: number[];
  errPct: number[];
  queue: number[];
  hitPct: number[];
}

export interface Totals {
  arrivalRps: number;
  doneRps: number;
  errPct: number;
  p50: number;
  p95: number;
  timeouts: number;
  rejected: number;
  throttled: number;
  connErrors: number;
  staleReads: number;
  inFlight: number;
  capacityRps: number;
  totalQueue: number;
}

export interface Snapshot {
  t: number;
  paused: boolean;
  speed: number;
  settings: GlobalSettings;
  defs: NodeDef[];
  links: LinkDef[];
  stats: Record<string, NodeStats>;
  linkStats: Record<string, LinkStats>;
  series: Series;
  totals: Totals;
}

export type FaultAction =
  | { kind: "crash"; nodeId: string }
  | { kind: "restart"; nodeId: string }
  | { kind: "partition"; linkId: string; on: boolean }
  | { kind: "expire"; nodeId: string }
  | { kind: "slow"; nodeId: string; ms: number }
  | { kind: "breaker-open"; nodeId: string }
  | { kind: "breaker-reset"; nodeId: string };

export type TransportAction =
  | { kind: "togglePause" }
  | { kind: "speed"; speed: number }
  | { kind: "reset" };

export type WorkerInbound =
  | { type: "load"; scenarioId: string }
  | { type: "knob"; knobId: string; value: KnobValue }
  | { type: "fault"; action: FaultAction }
  | { type: "transport"; action: TransportAction };

export type WorkerOutbound =
  | { type: "snapshot"; snap: Snapshot }
  | { type: "loaded"; scenarioId: string };
