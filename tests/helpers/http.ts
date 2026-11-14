import { NextRequest } from "next/server";

export function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Call a route handler directly (no server needed) and parse its JSON. */
export async function call(
  handler: (req: NextRequest) => Promise<Response>,
  method: string,
  url: string,
  body?: unknown
) {
  const res = await handler(jsonRequest(url, method, body));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}