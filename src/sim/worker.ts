import { Engine } from "./engine";
import type { WorkerInbound, WorkerOutbound } from "./types";

const TICK_REAL_MS = 50;

let engine = new Engine("playground");
let ticks = 0;

const post = (msg: WorkerOutbound) => self.postMessage(msg);

const send = () => post({ type: "snapshot", snap: engine.snapshot() });

setInterval(() => {
  engine.advance(TICK_REAL_MS * engine.speed);
  ticks++;
  if (ticks % 4 === 0) send();
}, TICK_REAL_MS);

self.onmessage = (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  if (msg.type === "load") {
    engine.load(msg.scenarioId);
    post({ type: "loaded", scenarioId: engine.scenario.id });
    send();
  } else if (msg.type === "knob") {
    engine.setKnob(msg.knobId, msg.value);
    send();
  } else if (msg.type === "fault") {
    engine.fault(msg.action);
    send();
  } else if (msg.type === "transport") {
    engine.transport(msg.action);
    send();
  }
};

send();
