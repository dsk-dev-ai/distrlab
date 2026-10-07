import { describe, expect, test } from "bun:test";
import { Engine } from "../src/sim/engine";

function run(id: string, seconds: number, setup?: (e: Engine) => void): Engine {
  const e = new Engine(id);
  setup?.(e);
  for (let i = 0; i < seconds; i++) e.advance(1000);
  return e;
}

describe("baseline behaviour", () => {
  test("playground stays healthy under its default load", () => {
    const e = run("playground", 20);
    const t = e.snapshot().totals;
    expect(t.errPct).toBeLessThan(3);
    expect(t.p95).toBeLessThan(500);
    expect(t.doneRps).toBeGreaterThan(300);
  });

  test("a deep queue converts overload into latency, a shallow one into fast failures", () => {
    const shallow = run("backpressure", 25, (e) => {
      e.setKnob("arrival", 1500);
      e.setKnob("svc-q", 0);
    });
    const deep = run("backpressure", 25, (e) => {
      e.setKnob("arrival", 1500);
      e.setKnob("svc-q", 500);
    });
    const a = shallow.snapshot().totals;
    const b = deep.snapshot().totals;
    expect(b.p95).toBeGreaterThan(a.p95 * 1.5);
    expect(b.totalQueue).toBeGreaterThan(a.totalQueue + 100);
  });

  test("the rate limiter protects the service behind it", () => {
    const s = run("ratelimit", 25, (e) => e.setKnob("arrival", 2500)).snapshot();
    expect(s.totals.throttled).toBeGreaterThan(100);
    expect(s.stats["api"].queue).toBeLessThan(60);
    expect(s.totals.errPct).toBeGreaterThan(10);
  });

  test("single-flight turns a stampede into coalesced waiters", () => {
    const peak = (sf: boolean) => {
      let peak = 0;
      const e = new Engine("stampede");
      e.setKnob("sf", sf);
      e.setKnob("arrival", 500);
      for (let i = 0; i < 40; i++) {
        e.advance(250);
        peak = Math.max(peak, e.snapshot().stats["catalog"].queue);
      }
      return peak;
    };
    const herd = peak(false);
    const coalesced = peak(true);
    expect(coalesced).toBeLessThan(herd * 0.8);
  });

  test("a cache TTL keeps cycling cold and warm", () => {
    const s = run("stampede", 30, (e) => {
      e.setKnob("ttl", 3000);
      e.setKnob("arrival", 400);
    }).snapshot();
    const hit = s.stats["cache"].hitRatio;
    expect(hit).not.toBeNull();
    expect(hit!).toBeGreaterThan(0.1);
    expect(hit!).toBeLessThan(0.99);
  });

  test("replication lag produces stale reads, never errors", () => {
    const s = run("staleness", 20, (e) => e.setKnob("lag", 5000)).snapshot();
    expect(s.totals.staleReads).toBeGreaterThan(100);
    expect(s.totals.errPct).toBeLessThan(1);
  });
});

describe("resilience", () => {
  test("crash fails fast, restart recovers", () => {
    const e = run("backpressure", 10);
    e.fault({ kind: "crash", nodeId: "api-a" });
    e.advance(5000);
    expect(e.snapshot().totals.errPct).toBeGreaterThan(10);
    e.fault({ kind: "restart", nodeId: "api-a" });
    e.advance(10000);
    expect(e.snapshot().totals.errPct).toBeLessThan(10);
  });

  test("health checks recover a partition in one probe interval", () => {
    const off = run("partition", 30, (e) => {
      e.setKnob("health", false);
      e.setKnob("arrival", 700);
    }).snapshot().totals;
    const on = run("partition", 30, (e) => {
      e.setKnob("health", true);
      e.setKnob("arrival", 700);
    }).snapshot().totals;
    expect(off.timeouts).toBeGreaterThan(50);
    expect(on.timeouts).toBeLessThan(off.timeouts * 0.4);
  });

  test("least-inflight routes around a partition with no health checks", () => {
    const t = run("partition", 30, (e) => {
      e.setKnob("strat", "least-inflight");
      e.setKnob("arrival", 700);
    }).snapshot().totals;
    expect(t.errPct).toBeLessThan(10);
  });

  test("timeout discipline: nothing hangs past the client timeout", () => {
    const s = run("partition", 20, (e) => {
      e.setKnob("timeout", 2000);
      e.setKnob("arrival", 700);
    }).snapshot();
    expect(s.totals.timeouts).toBeGreaterThan(0);
    expect(s.totals.inFlight).toBeLessThan(5000);
  });
});

describe("load-balancer strategies", () => {
  const errorsFor = (strat: string) =>
    run("lb", 25, (e) => {
      e.setKnob("strat", strat);
      e.setKnob("arrival", 900);
    }).snapshot().totals.errPct;

  test("round-robin overloads the weak instance", () => {
    expect(errorsFor("round-robin")).toBeGreaterThan(20);
  });

  test("least-inflight beats round-robin under skew", () => {
    expect(errorsFor("least-inflight")).toBeLessThan(errorsFor("round-robin") * 0.6);
  });

  test("power of two choices approximates least-inflight", () => {
    const p2c = errorsFor("p2c");
    const li = errorsFor("least-inflight");
    expect(p2c).toBeLessThan(errorsFor("round-robin") * 0.6);
    expect(Math.abs(p2c - li)).toBeLessThan(li * 0.6 + 4);
  });

  test("least-latency avoids the weak instance entirely", () => {
    const s = run("lb", 25, (e) => {
      e.setKnob("strat", "least-latency");
      e.setKnob("arrival", 900);
    }).snapshot();
    expect(s.totals.errPct).toBeLessThan(15);
    expect(s.stats["weak"].queue).toBeLessThan(10);
  });
});

describe("circuit breaker", () => {
  test("a downed dependency makes calls slow; the breaker makes them fast", () => {
    const off = run("circuit", 25, (e) => {
      e.setKnob("arrival", 400);
      e.setKnob("breaker", false);
      e.setKnob("link-down", true);
    }).snapshot().totals;
    const on = run("circuit", 25, (e) => {
      e.setKnob("arrival", 400);
      e.setKnob("breaker", true);
      e.setKnob("link-down", true);
    }).snapshot();
    expect(off.p95).toBeGreaterThan(3000);
    expect(off.timeouts).toBeGreaterThan(1000);
    expect(on.totals.p95).toBeLessThan(off.p95 * 0.2);
  });

  test("the circuit trips open under a sustained failure rate", () => {
    const e = new Engine("circuit");
    e.setKnob("arrival", 400);
    e.setKnob("link-down", true);
    let tripped = false;
    for (let i = 0; i < 60 && !tripped; i++) {
      e.advance(250);
      tripped = e.snapshot().stats["breaker"].circuit === "open";
    }
    expect(tripped).toBe(true);
  });

  test("repairing the link lets half-open probes close it", () => {
    const e = new Engine("circuit");
    e.setKnob("arrival", 400);
    e.setKnob("link-down", true);
    for (let i = 0; i < 60; i++) e.advance(250);
    e.setKnob("link-down", false);
    for (let i = 0; i < 60; i++) e.advance(250);
    const s = e.snapshot();
    expect(s.stats["breaker"].circuit).toBe("closed");
    expect(s.totals.errPct).toBeLessThan(10);
  });

  test("a recovered node clears its unhealthy flag and returns to Healthy insights", () => {
    const e = new Engine("circuit");
    e.setKnob("arrival", 400);
    e.setKnob("link-down", true);
    for (let i = 0; i < 60; i++) e.advance(250);
    expect(e.snapshot().stats["breaker"].unhealthy).toBe(true);
    e.setKnob("link-down", false);
    let recovered = false;
    for (let i = 0; i < 80 && !recovered; i++) {
      e.advance(250);
      const s = e.snapshot();
      recovered = !s.stats["breaker"].unhealthy && s.totals.errPct < 0.5;
    }
    expect(recovered).toBe(true);
    expect(e.snapshot().stats["catalog"].unhealthy).toBe(false);
  });

  test("tripping and resetting from the inspector works", () => {
    const e = run("circuit", 5);
    e.fault({ kind: "breaker-open", nodeId: "breaker" });
    expect(e.snapshot().stats["breaker"].circuit).toBe("open");
    e.fault({ kind: "breaker-reset", nodeId: "breaker" });
    expect(e.snapshot().stats["breaker"].circuit).toBe("closed");
  });

  test("a disabled breaker is a transparent pass-through", () => {
    const off = run("circuit", 25, (e) => {
      e.setKnob("arrival", 400);
      e.setKnob("breaker", false);
      e.setKnob("link-down", true);
    }).snapshot();
    expect(off.stats["breaker"].rejected).toBe(0);
  });
});