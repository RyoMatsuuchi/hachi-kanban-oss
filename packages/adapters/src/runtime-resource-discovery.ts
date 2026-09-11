import type { RuntimeDiscoveredResource, RuntimeMemberKind } from "@hachi/core";

export type RuntimeDiscoverySource = "docker" | "os";

export interface RuntimeResourceObservation extends RuntimeDiscoveredResource {
  source: RuntimeDiscoverySource;
  usageKnown: boolean;
}

export interface RuntimeResourceLookup {
  source: RuntimeDiscoverySource;
  scopeKey: string;
  kind: RuntimeMemberKind;
  nativeId: string;
}

/**
 * host 実体を読むだけの discovery 境界。create/remove/stop/kill/relabel は意図的に公開しない。
 */
export interface RuntimeResourceDiscovery {
  list(source: RuntimeDiscoverySource, scopeKey: string): Promise<readonly RuntimeResourceObservation[]>;
  inspect(lookup: RuntimeResourceLookup): Promise<RuntimeResourceObservation | null>;
}

function lookupKey(lookup: RuntimeResourceLookup): string {
  return `${lookup.source}\u0000${lookup.scopeKey}\u0000${lookup.kind}\u0000${lookup.nativeId}`;
}

function observationKey(observation: RuntimeResourceObservation): string {
  return lookupKey({
    source: observation.source,
    scopeKey: observation.scopeKey,
    kind: observation.kind,
    nativeId: observation.nativeId,
  });
}

function cloneObservation(observation: RuntimeResourceObservation): RuntimeResourceObservation {
  return {
    ...observation,
    labels: { ...observation.labels },
    attachedNativeIds:
      observation.attachedNativeIds === null ? null : [...observation.attachedNativeIds],
  };
}

/** unit/integration test 用。外部 process/network/Docker API へ一切触れない。 */
export class FakeRuntimeResourceDiscovery implements RuntimeResourceDiscovery {
  private readonly observations = new Map<string, RuntimeResourceObservation>();

  constructor(initial: readonly RuntimeResourceObservation[] = []) {
    for (const observation of initial) {
      this.set(observation);
    }
  }

  set(observation: RuntimeResourceObservation): void {
    this.observations.set(observationKey(observation), cloneObservation(observation));
  }

  remove(lookup: RuntimeResourceLookup): void {
    this.observations.delete(lookupKey(lookup));
  }

  async list(source: RuntimeDiscoverySource, scopeKey: string): Promise<readonly RuntimeResourceObservation[]> {
    return [...this.observations.values()]
      .filter((observation) => observation.source === source && observation.scopeKey === scopeKey)
      .sort((left, right) => observationKey(left).localeCompare(observationKey(right)))
      .map(cloneObservation);
  }

  async inspect(lookup: RuntimeResourceLookup): Promise<RuntimeResourceObservation | null> {
    const observation = this.observations.get(lookupKey(lookup));
    return observation === undefined ? null : cloneObservation(observation);
  }
}
