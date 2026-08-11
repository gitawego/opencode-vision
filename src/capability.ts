/**
 * Capability detection (ported from `@gitawego/vision` lib/capability.ts).
 *
 * Decides whether image analysis must be delegated. The primary model's
 * capability is read from its resolved `Model.capabilities.input.image`.
 *
 * `ToolContext` does not carry the active model, so the server tracks the
 * per-session primary model capability via the `chat.message` hook and serves
 * it to `describe_image.execute` through a session-scoped tracker.
 */
import type { Model, Provider } from "@opencode-ai/sdk";

/** The minimal client slice needed for capability resolution. */
export interface CapabilityClient {
  config: {
    providers(options: { query?: { directory?: string } }): Promise<{ providers: Provider[] }>;
  };
}

/** Safe default (mirrors pi): unknown/missing → treated as text-only. */
export function isMultimodal(model: Pick<Model, "capabilities"> | undefined): boolean {
  return !!model?.capabilities?.input?.image;
}

/** Find a model by provider+model id in the resolved provider list. */
export function findModel(
  providers: Provider[],
  providerID: string,
  modelID: string,
): Model | undefined {
  const provider = providers.find((p) => p.id === providerID);
  return provider?.models?.[modelID];
}

/** Find the first vision-capable model across all providers (for auto-detect). */
export function findFirstVisionModel(providers: Provider[]): Model | undefined {
  for (const provider of providers) {
    for (const model of Object.values(provider.models ?? {})) {
      if (model.capabilities?.input?.image) return model;
    }
  }
  return undefined;
}

/** Find the first vision-capable model whose provider matches `providerID`
 *  (prefer the primary's provider), else any vision model. */
export function autoDetectVisionModel(
  providers: Provider[],
  providerID: string | undefined,
): Model | undefined {
  if (providerID) {
    const sameProvider = providers.find((p) => p.id === providerID);
    if (sameProvider) {
      for (const model of Object.values(sameProvider.models ?? {})) {
        if (model.capabilities?.input?.image) return model;
      }
    }
  }
  return findFirstVisionModel(providers);
}

/** Enumerate every image-capable model across all providers, preferred
 *  provider's models first, others after (each model once). Used as the
 *  delegation-time candidate chain for auto-detected models. */
export function listVisionModels(
  providers: Provider[],
  preferredProviderID?: string,
): Array<{ providerID: string; modelID: string }> {
  const out: Array<{ providerID: string; modelID: string }> = [];
  const seen = new Set<string>();
  const pushProvider = (p: Provider) => {
    for (const model of Object.values(p.models ?? {})) {
      if (!model.capabilities?.input?.image) continue;
      const key = `${p.id}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ providerID: p.id, modelID: model.id });
    }
  };
  const preferred = preferredProviderID ? providers.find((p) => p.id === preferredProviderID) : undefined;
  if (preferred) pushProvider(preferred);
  for (const p of providers) {
    if (p !== preferred) pushProvider(p);
  }
  return out;
}

/** Resolve the primary model object for a session via the client. */
export async function resolveModel(
  client: CapabilityClient,
  directory: string | undefined,
  providerID: string,
  modelID: string,
): Promise<Model | undefined> {
  try {
    const { providers } = await client.config.providers(
      directory ? { query: { directory } } : {},
    );
    return findModel(providers, providerID, modelID);
  } catch {
    return undefined;
  }
}

/** Session → primary-model capability cache (updated by chat.message, read by
 *  the describe_image tool). Thread-safe-ish: single server process. */
export class CapabilityTracker {
  private bySession = new Map<string, { providerID: string; modelID: string; multimodal: boolean }>();

  set(sessionID: string, model: { providerID: string; modelID: string; multimodal: boolean }): void {
    this.bySession.set(sessionID, model);
  }

  get(sessionID: string): { providerID: string; modelID: string; multimodal: boolean } | undefined {
    return this.bySession.get(sessionID);
  }

  delete(sessionID: string): void {
    this.bySession.delete(sessionID);
  }

  clear(): void {
    this.bySession.clear();
  }
}
