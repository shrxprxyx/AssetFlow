import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { publishNotificationsCreated, subscribeToNotifications, resetRealtimeForTests } from "@/services/realtime";
import { openNotificationStream, MAX_STREAMS_PER_USER, openStreamCount } from "@/services/sse";

beforeEach(() => resetRealtimeForTests());

describe("realtime bus", () => {
  it("tells a user's subscribers when they get notifications", async () => {
    const cb = vi.fn();
    subscribeToNotifications(1, cb);

    await publishNotificationsCreated([1]);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not tell other users", async () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    subscribeToNotifications(1, mine);
    subscribeToNotifications(2, theirs);

    await publishNotificationsCreated([1]);

    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it("reaches every open tab of the same user", async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeToNotifications(1, a);
    subscribeToNotifications(1, b);

    await publishNotificationsCreated([1]);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("stops after unsubscribe", async () => {
    const cb = vi.fn();
    const off = subscribeToNotifications(1, cb);
    off();

    await publishNotificationsCreated([1]);

    expect(cb).not.toHaveBeenCalled();
  });

  it("one failing subscriber does not stop the others, and publish never throws", async () => {
    const good = vi.fn();
    subscribeToNotifications(1, () => {
      throw new Error("boom");
    });
    subscribeToNotifications(1, good);

    await expect(publishNotificationsCreated([1])).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("publishing to nobody is fine", async () => {
    await expect(publishNotificationsCreated([])).resolves.toBeUndefined();
    await expect(publishNotificationsCreated([99])).resolves.toBeUndefined();
  });
});

const decoder = new TextDecoder();

/** Close the stream, then return everything it wrote. */
async function drain(stream: ReadableStream<Uint8Array>, abort: () => void) {
  abort();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

describe("notification stream", () => {
  afterEach(() => vi.useRealTimers());

  function open(userId: number, opts?: Parameters<typeof openNotificationStream>[2]) {
    const controller = new AbortController();
    const stream = openNotificationStream(userId, controller.signal, opts);
    return { stream, abort: () => controller.abort() };
  }

  it("starts with a retry hint and a ready event", async () => {
    const { stream, abort } = open(1);

    const text = await drain(stream!, abort);

    expect(text).toContain("retry: 5000");
    expect(text).toContain("event: ready");
  });

  it("writes a notification event when the user is notified", async () => {
    const { stream, abort } = open(1);

    await publishNotificationsCreated([1]);
    const text = await drain(stream!, abort);

    expect(text.match(/event: notification/g)).toHaveLength(1);
  });

  it("does not write events for other users' notifications", async () => {
    const { stream, abort } = open(1);

    await publishNotificationsCreated([2]);
    const text = await drain(stream!, abort);

    expect(text).not.toContain("event: notification");
  });

  it("sends a heartbeat comment so idle connections are not dropped", async () => {
    vi.useFakeTimers();
    const { stream, abort } = open(1, { heartbeatMs: 1_000 });

    vi.advanceTimersByTime(2_500);
    const text = await drain(stream!, abort);

    expect(text.match(/: ping/g)).toHaveLength(2);
  });

  it("closes when the client goes away, and stops listening", async () => {
    const { stream, abort } = open(1);
    expect(openStreamCount(1)).toBe(1);

    await drain(stream!, abort);
    expect(openStreamCount(1)).toBe(0);

    // Publishing after close must not throw (the controller is closed).
    await expect(publishNotificationsCreated([1])).resolves.toBeUndefined();
  });

  it("closes after its maximum lifetime so the session is re-checked on reconnect", async () => {
    vi.useFakeTimers();
    const { stream } = open(1, { maxLifetimeMs: 5_000 });
    const reader = stream!.getReader();

    vi.advanceTimersByTime(5_001);
    let done = false;
    while (!done) ({ done } = await reader.read());

    expect(done).toBe(true);
    expect(openStreamCount(1)).toBe(0);
  });

  it("refuses more than the allowed number of streams per user, and frees a slot on close", async () => {
    const open_ = Array.from({ length: MAX_STREAMS_PER_USER }, () => open(7));
    expect(open_.every((o) => o.stream !== null)).toBe(true);

    expect(open(7).stream).toBeNull();
    expect(open(8).stream).not.toBeNull(); // another user is unaffected

    await drain(open_[0].stream!, open_[0].abort);
    expect(open(7).stream).not.toBeNull();
  });
});
