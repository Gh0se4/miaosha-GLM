<script lang="ts">
  import { devEnvironment, type DevMode } from '../../../lib/settings/dev';
  import { version } from '../../../package.json';

  let { mode, onmodechange }: {
    mode: DevMode;
    onmodechange: (mode: DevMode) => void;
  } = $props();
</script>

<div class="topbar">
  <div class="brand">
    <div class="brand-mark">Z</div>
    <div class="brand-text">抢购助手</div>
    <span class="ver">v{version}</span>
  </div>
  <div class="pill-toggle">
    <button
      class="pill-btn"
      class:active={mode === 'development'}
      onclick={() => onmodechange('development')}
    >DEV</button>
    <button
      class="pill-btn"
      class:active={mode === 'production'}
      onclick={() => onmodechange('production')}
    >PROD</button>
  </div>
</div>

<style>
  .topbar {
    flex: 0 0 auto;
    padding: 12px 14px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #ffffff;
    border-bottom: 1.5px solid #0c1224;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .brand-mark {
    width: 28px;
    height: 28px;
    border: 1.5px solid #0c1224;
    border-radius: 6px;
    background: #0c1224;
    color: #f5f3ee;
    display: grid;
    place-items: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
  }

  .brand-text {
    font-family: 'Plus Jakarta Sans', 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 700;
    color: #0c1224;
    letter-spacing: -0.1px;
  }

  .ver {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    color: #0c1224;
    background: #fafaf7;
    padding: 2px 6px;
    border: 1px solid #0c1224;
    border-radius: 4px;
    margin-left: 2px;
  }

  .pill-toggle {
    display: flex;
    background: #fafaf7;
    border: 1.5px solid #0c1224;
    border-radius: 6px;
    padding: 2px;
  }

  .pill-btn {
    padding: 4px 12px;
    border: 0;
    background: transparent;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
    color: #6a7496;
    letter-spacing: 0.1em;
    transition: all 0.15s;
  }

  .pill-btn.active {
    background: #0c1224;
    color: #f5f3ee;
  }
</style>