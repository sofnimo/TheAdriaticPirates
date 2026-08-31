import type { ModelLoadOptions, SpinnerSpec } from './ModelStage';

/**
 * Per-asset sidecars: `Foo.fbx` is configured by `Foo.parts.json` beside it.
 *
 * ONE source of truth, deliberately. Both the model bench and the grass world
 * load the same aircraft, and the grass world originally carried its own copy of
 * the hide list — which promptly went stale the first time a part was added to
 * the sidecar and not to the copy. A shared lookup is the fix; the alternative is
 * remembering to edit two places forever.
 *
 * Eager, because the hide list has to be in hand BEFORE the model is fitted — the
 * auto-fit sizes to whatever is visible, so fetching it afterwards means the asset
 * visibly resizes a moment after it lands. These are a few hundred bytes each.
 *
 * Keyed by BASENAME rather than by the glob's own path, so it does not matter
 * which directory a caller thinks it is importing from.
 */
interface PartsSidecar {
  /** Top-level part names to switch off before the first fit. */
  hide?: string[];
  /** Rotating assemblies — a propeller, a rotor, a wheel. */
  spin?: SpinnerSpec[];
  /** Why. Neither is read by anything — they are the record for whoever opens the file. */
  note?: string;
  spinNote?: string;
}

const MODULES = import.meta.glob('../models/*.parts.json', {
  eager: true,
  import: 'default',
}) as Record<string, PartsSidecar>;

const BY_NAME = new Map<string, PartsSidecar>(
  Object.entries(MODULES).map(([path, sidecar]) => [path.slice(path.lastIndexOf('/') + 1), sidecar]),
);

/**
 * Load options for a model file name (`Porcorosso.fbx`, or any path ending in one).
 * Returns an empty object when the asset has no sidecar, which is the common case.
 */
export function sidecarFor(modelFile: string): ModelLoadOptions {
  const base = modelFile.slice(modelFile.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  const sidecar = BY_NAME.get(stem + '.parts.json');
  if (!sidecar) return {};
  const options: ModelLoadOptions = {};
  if (sidecar.hide) options.hide = sidecar.hide;
  if (sidecar.spin) options.spin = sidecar.spin;
  return options;
}
