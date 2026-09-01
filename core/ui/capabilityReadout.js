// A small, self-contained debug readout of the detected capability tier.
//
// Phase 1 needs to ship something visible that proves the scaffolding works:
// this panel is that proof. Core provides the content element; each shell
// decides where to place it (bottom sheet vs side panel). It is expected to be
// removed or hidden once real UI lands.

/**
 * @param {object} data
 * @param {ReturnType<import('../capability/detect.js').detectCapabilities>} data.capabilities
 * @param {string} data.tier
 * @param {string[]} data.reasons
 * @param {object} data.profile
 * @returns {{ el: HTMLElement, setContextLost: (lost: boolean) => void }}
 */
export function createCapabilityReadout({ capabilities, tier, reasons, profile }) {
  const el = document.createElement('div');
  el.className = 'argus-readout';

  // title attr carries the full value so truncated rows (gpu, why) are readable
  // on hover. String() guards against non-string values slipping into markup.
  const row = (label, value) => {
    const v = String(value);
    return `<div class="argus-readout__row"><span>${label}</span><span title="${v.replace(/"/g, '&quot;')}">${v}</span></div>`;
  };

  const gpu = capabilities.webgl.renderer;
  const net = capabilities.network.effectiveType;
  const mem =
    capabilities.deviceMemory != null ? `${capabilities.deviceMemory} GiB` : 'unknown';
  const cores = capabilities.cpuCores ?? 'unknown';
  const input = capabilities.input.touchCapable
    ? capabilities.input.hover
      ? 'touch + hover'
      : 'touch'
    : 'pointer';

  el.innerHTML = `
    <div class="argus-readout__title">
      <span class="argus-readout__badge argus-readout__badge--${tier}">${tier.toUpperCase()}</span>
      <span>capability tier</span>
    </div>
    <div class="argus-readout__body">
      ${row('why', reasons.join(', '))}
      ${row('gpu', gpu)}
      ${row('webgl', `v${capabilities.webgl.version}`)}
      ${row('memory', mem)}
      ${row('cores', cores)}
      ${row('input', input)}
      ${row('network', `${net}${capabilities.network.saveData ? ' (save-data)' : ''}`)}
      ${row('resolutionScale', profile.resolutionScale)}
      ${row('targetFrameRate', `${profile.targetFrameRate} fps`)}
      ${row('renderMode', profile.requestRenderMode ? 'on-change' : 'continuous')}
      <div class="argus-readout__layers" data-role="layers"></div>
    </div>
    <div class="argus-readout__status" data-role="status"></div>
  `;

  const statusEl = el.querySelector('[data-role="status"]');
  const layersEl = el.querySelector('[data-role="layers"]');

  const setContextLost = (lost) => {
    statusEl.textContent = lost ? 'WebGL context lost, recovering...' : '';
    statusEl.classList.toggle('argus-readout__status--warn', lost);
  };

  // One row per active layer, keyed by label, showing its live count or error.
  // A disabled layer (state 'off') removes its row so stale counts do not linger.
  const setLayerStatus = (label, status) => {
    let rowEl = layersEl.querySelector(`[data-layer="${label}"]`);
    if (status.state === 'off') {
      rowEl?.remove();
      return;
    }
    if (!rowEl) {
      rowEl = document.createElement('div');
      rowEl.className = 'argus-readout__row';
      rowEl.dataset.layer = label;
      rowEl.innerHTML = `<span>${label}</span><span data-role="v"></span>`;
      layersEl.appendChild(rowEl);
    }
    const value =
      status.state === 'ok'
        ? String(status.count)
        : status.state === 'error'
          ? `error ${status.status ?? ''}`.trim()
          : (status.reason ?? status.state);
    rowEl.querySelector('[data-role="v"]').textContent = value;
  };

  return { el, setContextLost, setLayerStatus };
}
