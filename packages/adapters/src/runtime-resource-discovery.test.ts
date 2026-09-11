import { describe, expect, it } from "vitest";
import { FakeRuntimeResourceDiscovery, type RuntimeResourceObservation } from "./runtime-resource-discovery.js";

function observation(nativeId: string): RuntimeResourceObservation {
  return {
    source: "docker",
    kind: "docker_container",
    scopeKey: "docker:test",
    nativeId,
    displayName: "preview",
    labels: { "io.hachi.managed": "true" },
    attachedNativeIds: [],
    usageKnown: true,
    observedAt: 100,
  };
}

describe("FakeRuntimeResourceDiscovery", () => {
  it("Docker/OS 実体に触れず list/inspect の read-only discovery を再現する", async () => {
    const fake = new FakeRuntimeResourceDiscovery([observation("container-b"), observation("container-a")]);
    expect((await fake.list("docker", "docker:test")).map((item) => item.nativeId)).toEqual([
      "container-a",
      "container-b",
    ]);
    expect(
      await fake.inspect({
        source: "docker",
        scopeKey: "docker:test",
        kind: "docker_container",
        nativeId: "container-a",
      }),
    ).toMatchObject({ nativeId: "container-a", usageKnown: true });
  });

  it("返却値を clone し、consumer から fake inventory を改変させない", async () => {
    const fake = new FakeRuntimeResourceDiscovery([observation("container-a")]);
    const listed = await fake.list("docker", "docker:test");
    const labels = listed[0]?.labels as Record<string, string>;
    labels["io.hachi.managed"] = "false";
    const inspected = await fake.inspect({
      source: "docker",
      scopeKey: "docker:test",
      kind: "docker_container",
      nativeId: "container-a",
    });
    expect(inspected?.labels["io.hachi.managed"]).toBe("true");
  });

  it("OS listener 観測も同じ read-only 境界で表現できる", async () => {
    const fake = new FakeRuntimeResourceDiscovery([
      {
        source: "os",
        kind: "tcp_port",
        scopeKey: "host:local",
        nativeId: "pid:42:start:100:port:3190",
        displayName: "127.0.0.1:3190",
        labels: {},
        attachedNativeIds: ["pid:42:start:100"],
        usageKnown: true,
        observedAt: 100,
      },
    ]);
    expect(await fake.list("os", "host:local")).toMatchObject([
      { source: "os", kind: "tcp_port", nativeId: "pid:42:start:100:port:3190" },
    ]);
  });
});
