<div align="center">

# DistrLab

**Break a live distributed system — right in your browser.**

Simulate cache stampedes, queue backpressure, rate limiting, load-balancing
strategies, network partitions and replica lag in real time. Flip the switches,
watch latency, throughput, errors and queue depth react — then read the
plain-language explanation of *why*.

[Try it live](https://distrlab.onrender.com) ·
[Releases](https://github.com/dsk-dev-ai/distrlab/releases) ·
[Report a bug](https://github.com/dsk-dev-ai/distrlab/issues)

![live](https://img.shields.io/website?url=https%3A%2F%2Fdistrlab.onrender.com&label=live%20on%20render&color=success)
![release](https://img.shields.io/github/v/release/dsk-dev-ai/distrlab?label=release)
![stars](https://img.shields.io/github/stars/dsk-dev-ai/distrlab?color=gold)
![license](https://img.shields.io/github/license/dsk-dev-ai/distrlab)
![svelte](https://img.shields.io/badge/Svelte_5-FF3E00?logo=svelte&logoColor=white)
![typescript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)

**Status:** v1.1.0 — live on Render, in review as a PR. Circuit breaker + two smarter
LB strategies join the seven original scenarios. 100% in the browser: no backend, no LLM,
no paid API, no tracking. Everything runs inside a Web Worker on a static page — works
offline, deployable to any static host.

</div>

## Why DistrLab?

| Pain point | DistrLab solves it |
|---|---|
| Static diagrams that you just nod along to | A **live topology you can actually break** — every toggle moves real latency, error and throughput numbers |
| Tutorials that only show the happy path | **Eight failure scenarios**: stampede, backpressure, throttling, LB skew, partition, stale replicas, a tripping circuit breaker |
| "I get it" fading an hour later | **Hands-on memory** — break it, watch it recover, then re-check yourself |
| Trusting that health checks / least-inflight work | **See requests reroute around a dead instance in real time** |
| Taking load balancers on faith | **Round-robin vs random vs P2C vs least-latency** head-to-head against a weak instance |
| Paid doorstopper simulators | Free, offline, no signup — a Svelte 5 + Canvas + Web Worker static page |

## Contents

- [A taste of the action](#a-taste-of-the-action)
- [Scenarios](#scenarios)
- [Controls](#controls)
- [How the simulation works](#how-the-simulation-works)
- [Development](#development)
- [Deploy](#deploy)
- [Roadmap](#roadmap)
- [Support](#support)
- [License](#license)

## A taste of the action

A healthy, idle playground — p95, throughput, capacity, queues and cache hit
ratio all visible at a glance:

![healthy playground](media/distrlab-playground.png)

Same cache expiry, **single-flight off**: every request herds at the origin and
the catalog service melts down:

![cache stampede: expired cache without single-flight melts down the catalog service](media/distrlab-stampede.png)

The same expiry with **single-flight on**: waiters coalesce at the cache and the
catalog stays idle:

![the same expiry with single-flight on: waiters coalesce, the catalog stays idle](media/distrlab-coalesced.png)

A real run, compressed — expire the cache, watch it recover:

![Demo](media/distrlab-demo.gif)

## Scenarios

| # | Scenario | The lesson |
|---|----------|-----------|
| 1 | Playground | A healthy baseline: p95, throughput, capacity, queues, cache hit ratio |
| 2 | Cache stampede | Turning off single-flight near a TTL expiry herds every request at the origin |
| 3 | Queue backpressure | Shallow queues shed fast; deep queues trade errors for latency (both hurt) |
| 4 | Rate limiting | A token bucket in front of the service protects it, at the cost of 429s |
| 5 | Load balancer strategies | Round-robin vs random vs least-inflight vs sticky vs P2C vs least-latency under skew and failure |
| 6 | Network partition | A cut link stops traffic; health checks + least-inflight route around it |
| 7 | Replication lag | Reading a replica is fast and stale; tune the lag and watch stale reads |
| 8 | Circuit breaker | A breaker in front of a flaky dependency: slow timeouts → instant 503s, then probe back to health |

## Controls

- **Buttons in the header** switch scenarios, reset, pause, and set sim speed (space / `R` / `1`–`8` keyboard shortcuts).
- **The graph** is the live topology — click a node to open the Inspector, drag to rearrange, scroll to zoom, drag the background to pan.
- **Knobs** in the sidebar change arrival rate, capacities, queue limits, TTL, single-flight, LB strategy, health checks, timeouts, replica lag, fault windows, and the breaker's trip threshold / cooldown / probe limit.
- **Inspector** can crash / restart a service, expire a cache, slow an instance, partition/repair links, and trip or reset the circuit breaker by hand.
- **Charts** (bottom) track p95, throughput, error rate, queue depth, and cache hit ratio over time; the **insights panel** explains what's currently wrong.

## How the simulation works

A discrete-time queueing model ticks every 20 ms of simulated time (player time
is scaled 1×/2×/4×). Requests are small objects that carry latency, are counted
against windows, drain through queues, wait in `proc` slots for a service time
drawn from a log-normal distribution, and eventually complete or fail with
`timeout | rejected | throttled | conn | crashed`.

- **Services** have capacity (rps) and queue limits; over their limit they reject with 503.
- **Client timeouts** kill in-flight requests; a request that dies mid-route still credits the target's error slice.
- **Health checks** use an error-rate EMA with probe fallback; unhealthy nodes are pulled from LB rotation and get probed once per second, and their health recovers (decays) once the outage ends — so recovery is automatic.
- **Least-inflight** counts what's *actually* waiting — including requests still travelling across the network, so a silent hole (partition) repels traffic. **P2C** picks the less loaded of two random candidates; **least-latency** prefers the node with the lowest response-time EMA.
- **Circuit breaker** trips OPEN above a recent error-rate threshold, fast-fails with 503, goes half-open after a cooldown, and closes once its limited probes succeed.
- **Cache** write-misses coalesce when single-flight is on; expiry refills the window.
- **Rate limiters** are token buckets refilled per tick.
- **Replica reads** are always served, but carry the configured staleness lag.

## Development

```bash
bun install
bun test         # headless engine tests (no browser needed)
bun run dev      # vite dev server
bun run check    # svelte-check (types + a11y)
bun run build    # production build → dist/
bun run preview  # serve the build locally
```

The engine is framework-agnostic (`src/sim/engine.ts`) and runs headless in a
Web Worker (`src/sim/worker.ts`); the UI (`src/App.svelte`, `src/lib/`) is a
thin canvas + Svelte skin over the snapshots it emits. Deploy `dist/` anywhere
that serves static files — set the SPA fallback if your host needs it.

## Deploy

One free Render static site hosts the app — no backend to run:

```yaml
# render.yaml — already in this repo
runtime: static
buildCommand: npm install && npm run build
publishPath: dist
```

Or push the button course: Render → **New → Blueprint** → connect this repo →
**Deploy**. AutoDeploy is on, so every push to `main` rebuilds.

**Honest note:** `dist/` is 100% static with no server-side logic, so it can be
dropped onto any static host (GitHub Pages, Netlify, Cloudflare Pages…) — the
SPA fallback is the only host-specific thing to configure.

## Roadmap

- [x] v1.0.0 — live playground, 7 scenarios, inspector, charts, insights
- [x] v1.1.0 — circuit breaker + scenario, P2C and least-latency LB strategies, engine test suite
- [ ] v1.2.0 — chaos & retries: backoff with jitter, fault scheduler, per-request work log
- [ ] v1.3.0 — share & export: scenario URLs, layouts, PNG/GIF export
- [ ] v2.0.0 — beyond the single request path: sagas, quorum/consensus, multi-region, leader election

See [ROADMAP.md](ROADMAP.md) for the full version-wise plan.

## Support

Built by [@dsk-dev-ai](https://github.com/dsk-dev-ai). If DistrLab saves you an
hour of debugging your own systems — sponsor it:

https://github.com/sponsors/dsk-dev-ai

## License

Apache-2.0. See [LICENSE](LICENSE).