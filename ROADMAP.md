# DistrLab Roadmap

Version-wise plan. Shipped items are checked; open items are the next candidates.

## v1.0.0 — Playground (shipped)

The core simulator and its seven failure scenarios:

- Live topology canvas with Inspector (crash/restart, expire cache, slow a node, partition/repair links)
- Scenario knobs: arrival rate, capacity, queue limits, TTL, single-flight, LB strategy, health checks, timeouts, replica lag, fault windows
- Real-time charts (p95, throughput, errors, queue depth, cache hit ratio) + plain-language insights
- Discrete-time queueing engine running in a Web Worker
- Deployed as a static site (Render), release with media assets

## v1.1.0 — Resilience depth (in progress)

Go deeper on failure handling instead of wider on scenarios:

- Circuit breaker node: trips OPEN past an error-rate threshold, fast-fails with 503, half-open probing, auto-recovery
- New scenario: circuit breaker in front of a flaky dependency (with a link-down toggle)
- Two more load-balancer strategies: power-of-two-choices and least-latency (EMA of response time)
- Health-check EMA recovery: nodes decay back to healthy after an outage (fixed a real stuck-unhealthy bug)
- In-repo engine test suite (`bun test`, headless, no browser)
- Inspector buttons to trip / reset the breaker by hand

## v1.2.0 — Chaos & retries

- Client retry policy with jitter + exponential backoff (observe retry storms vs. spaced retries)
- Fault scheduler: scripted chaos — schedule a partition, then a flake, then a crash at given times
- Retry-visibility: per-request work log showing each hop, retry, and where time went
- Hints for backoff tuning (reasonable jitter, capped retries)

## v1.3.0 — Share & export

- Shareable scenario URLs (encode scenario + knob values)
- Save / load named layouts + knob presets
- Export the topology and run as PNG / GIF
- Embeddable mode for docs

## v2.0.0 — Beyond the single request path

- Sagas / distributed transactions: a multi-node sequence that can roll back
- Quorum / consensus (Raft-flavoured): majority writes, leader vs. follower reads
- Multi-region topology with DNS steering to the nearest replica
- Leader election + failover under node loss

## Done / in progress

| Version | Theme | Status |
|---|---|---|
| v1.0.0 | Playground | released |
| v1.1.0 | Resilience depth | branch `feat/v1.1-resilience-depth` |
| v1.2.0 | Chaos & retries | planned |
| v1.3.0 | Share & export | planned |
| v2.0.0 | Beyond a single path | planned |