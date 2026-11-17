import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { waitUntilReady } from "@/lib/rateLimit";

// A stand-in for the Redis client: just a status and the ready event.
function fakeClient(status: string) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    status,
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  }) as never as Parameters<typeof waitUntilReady>[0] & EventEmitter;
}

describe("waitUntilReady", () => {
  it("returns at once when the connection is ready", async () => {
    await expect(waitUntilReady(fakeClient("ready"))).resolves.toBeUndefined();
  });

  it("waits for a connection that is still starting, then goes ahead", async () => {
    const client = fakeClient("connecting");
    const waiting = waitUntilReady(client, 500);
    setTimeout(() => client.emit("ready"), 20);

    await expect(waiting).resolves.toBeUndefined();
    expect(client.listenerCount("ready")).toBe(0);
  });

  it("gives up after the timeout, and leaves no listener behind", async () => {
    const client = fakeClient("connecting");

    await expect(waitUntilReady(client, 30)).rejects.toThrow(/not ready/);
    expect(client.listenerCount("ready")).toBe(0);
  });

  it("does not wait for a client that is reconnecting (Redis is down)", async () => {
    const started = Date.now();

    await expect(waitUntilReady(fakeClient("reconnecting"), 1_000)).rejects.toThrow(/reconnecting/);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
