<script lang="ts">
  import type { Knob, KnobValue } from "../sim/types";

  interface Props {
    knob: Knob;
    value: KnobValue;
    onchange: (v: KnobValue) => void;
  }

  let { knob, value, onchange }: Props = $props();

  const isRatio = (k: Knob) =>
    k.type === "range" && k.max !== undefined && k.max <= 1 && k.min === 0;

  function display(v: KnobValue): string {
    if (knob.type === "range") {
      const num = Number(v);
      if (isRatio(knob)) return `${Math.round(num * 100)}%`;
      const step = knob.step ?? 1;
      const text = step >= 1 ? Math.round(num).toLocaleString() : num.toFixed(2);
      return `${text}${knob.unit ?? ""}`;
    }
    if (knob.type === "toggle") return v ? "on" : "off";
    return String(v);
  }
</script>

<div class="knob">
  <div class="head">
    <span class="name">{knob.label}</span>
    <span class="val">{display(value)}</span>
  </div>

  {#if knob.type === "range"}
    <input
      type="range"
      min={knob.min}
      max={knob.max}
      step={knob.step}
      value={Number(value)}
      oninput={(e) => onchange(Number(e.currentTarget.value))}
    />
  {:else if knob.type === "toggle"}
    <button
      type="button"
      class="switch"
      class:on={value === true}
      onclick={() => onchange(!(value === true))}
      aria-pressed={value === true}
    >
      <span class="track"></span>
      <span>{value === true ? "enabled" : "disabled"}</span>
    </button>
  {:else}
    <div class="seg">
      {#each knob.options ?? [] as opt (opt.value)}
        <button
          type="button"
          class:active={value === opt.value}
          onclick={() => onchange(opt.value)}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if knob.hint}
    <div class="hint">{knob.hint}</div>
  {/if}
</div>
