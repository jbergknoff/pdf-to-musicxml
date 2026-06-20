import type { BackendChoice, OmrConfig } from "../worker/protocol";

/**
 * Inference controls in the header: pick the backend (or auto). Changing it
 * recreates the worker (see main.tsx), so the control is disabled while a run
 * is in flight. `provider` is the backend the worker actually resolved (null
 * while it's still starting), shown so "auto" reveals what it landed on.
 */

interface InferenceSettingsProps {
  config: OmrConfig;
  provider: string | null;
  disabled: boolean;
  onChange: (next: OmrConfig) => void;
}

const BACKEND_LABELS: Record<BackendChoice, string> = {
  auto: "Auto (WebGPU if available)",
  webgpu: "WebGPU",
  wasm: "WASM (CPU)",
};

const BACKEND_CHOICES = Object.keys(BACKEND_LABELS) as BackendChoice[];

export function InferenceSettings({
  config,
  provider,
  disabled,
  onChange,
}: InferenceSettingsProps) {
  return (
    <div class="settings">
      <label class="settings__field">
        <span>Backend</span>
        <select
          disabled={disabled}
          value={config.backend}
          onChange={(event) => {
            onChange({
              ...config,
              backend: event.currentTarget.value as BackendChoice,
            });
          }}
        >
          {BACKEND_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {BACKEND_LABELS[choice]}
            </option>
          ))}
        </select>
      </label>

      <span class="settings__provider">
        {provider === null ? "starting…" : `running on ${provider}`}
      </span>
    </div>
  );
}
