import { useEffect } from 'react';

/**
 * Inline toggle row for a single provider (STT, LLM, TTS).
 *   local ←→ cloud
 * Disabled options are greyed out with a tooltip.
 */
function Toggle({ label, value, onChange, available, names }) {
  const localAvailable = available?.local ?? true;
  const cloudAvailable = available?.cloud ?? false;

  const localName = names?.local || 'Local';
  const cloudName = names?.cloud || 'Cloud';

  return (
    <div className="provider-row">
      <span className="provider-label">{label}</span>
      <div className="toggle-switch-container">
        <button
          type="button"
          className={`toggle-option ${value === 'local' ? 'active local' : ''}`}
          disabled={!localAvailable}
          onClick={() => onChange('local')}
          title={localAvailable ? localName : 'Local provider not available'}
        >
          <span className="toggle-icon">💻</span>
          <span className="toggle-text">{localName}</span>
          <span className="toggle-location-label">Local</span>
        </button>

        <button
          type="button"
          className={`toggle-option ${value === 'cloud' ? 'active cloud' : ''}`}
          disabled={!cloudAvailable}
          onClick={() => onChange('cloud')}
          title={cloudAvailable ? cloudName : 'Cloud provider not configured (API key missing)'}
        >
          <span className="toggle-icon">☁️</span>
          <span className="toggle-text">{cloudName}</span>
          <span className="toggle-location-label">Cloud</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Panel with three toggles: STT, LLM, TTS.
 *
 * Props:
 *   providers     – { stt: 'local'|'cloud', llm: 'local'|'cloud', tts: 'local'|'cloud' }
 *   onChange       – (key, value) => void
 *   available      – from server health: { stt: { local, cloud }, ... }
 *   providerNames  – { stt: { local, cloud }, llm: { local, cloud }, tts: { local, cloud } }
 */
export default function ProviderToggle({ providers, onChange, available, providerNames }) {
  // If cloud becomes unavailable while selected, fall back to local
  useEffect(() => {
    for (const key of ['stt', 'llm', 'tts']) {
      if (providers[key] === 'cloud' && available?.[key] && !available[key].cloud) {
        onChange(key, 'local');
      }
    }
  }, [available, providers, onChange]);

  return (
    <div className="provider-toggle-panel">
      <Toggle
        label="STT"
        value={providers.stt}
        onChange={(v) => onChange('stt', v)}
        available={available?.stt}
        names={providerNames?.stt}
      />
      <Toggle
        label="LLM"
        value={providers.llm}
        onChange={(v) => onChange('llm', v)}
        available={available?.llm}
        names={providerNames?.llm}
      />
      <Toggle
        label="TTS"
        value={providers.tts}
        onChange={(v) => onChange('tts', v)}
        available={available?.tts}
        names={providerNames?.tts}
      />
    </div>
  );
}
