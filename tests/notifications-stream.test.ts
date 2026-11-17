import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as openStream } from "@/app/api/notifications/stream/route";
import { MAX_STREAMS_PER_USER } from "@/lib/sse";
import { notifyForActivity } from "@/lib/notifications";
import { resetDb, createUser } from "./helpers/db";
import { signInAs, signOut } from "./helpers/auth";

const decoder = new TextDecoder();

function connect() {
  const controller = new AbortController();
  const req = new NextRequest("http://localhost/api/notifications/stream", { signal: controller.signal });
  return { controller, response: openStream(req) };
}

/** Close the connection and return everything the server wrote. */
async function finish(res: Response, controller: AbortController) {
  controller.abort();
  const reader = res.body!.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

describe("GET /api/notifications/stream", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("needs a signed-in user", async () => {
    signOut();
    const { response } = connect();
    expect((await response).status).toBe(401);
  });

  it("is an event stream that is never cached", async () => {
    signInAs(await createUser());
    const { controller, response } = connect();
    const res = await response;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    await finish(res, controller);
  });

  it("sends an event when the user gets a notification, and only to that user", async () => {
    const me = await createUser();
    const other = await createUser();

    signInAs(me);
    const mine = connect();
    const myRes = await mine.response;
    signInAs(other);
    const theirs = connect();
    const theirRes = await theirs.response;

    // "role_changed" notifies the user whose role changed (resourceId = their id).
    await notifyForActivity("role_changed", { actorId: other.id, resourceId: me.id, changes: { to: "ASSET_MANAGER" } });

    const myText = await finish(myRes, mine.controller);
    const theirText = await finish(theirRes, theirs.controller);
    expect(myText.match(/event: notification/g)).toHaveLength(1);
    expect(theirText).not.toContain("event: notification");
  });

  it("refuses a sixth open connection with a 429", async () => {
    signInAs(await createUser());
    const open = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) open.push(connect());
    const responses = await Promise.all(open.map((o) => o.response));
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const extra = await connect().response;

    expect(extra.status).toBe(429);
    for (let i = 0; i < open.length; i++) await finish(responses[i], open[i].controller);
  });
});
