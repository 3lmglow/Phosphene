import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

// Exercise the shipped worker's fetch handler rather than just matching strings in its source.
function scriptRequest(networkResponse: Response) {
  const put = vi.fn();
  const match = vi.fn().mockResolvedValue(undefined);
  const addEventListener = vi.fn();
  const origin = "https://phosphene.test";
  runInNewContext(source, {
    URL, Response, self: { location: { origin }, addEventListener },
    fetch: () => Promise.resolve(networkResponse), caches: { open: async () => ({ match, put }), match }
  });
  const onFetch = addEventListener.mock.calls.find(([type]) => type === "fetch")![1];
  const request = { method: "GET", url: `${origin}/assets/entry.js`, mode: "cors", destination: "script" };
  const respondWith = vi.fn();
  onFetch({ request, respondWith });
  return { result: respondWith.mock.calls[0][0] as Promise<Response>, put, request };
}

describe("script caching", () => {
  it.each([[200, "text/html; charset=utf-8"], [200, "application/xhtml+xml"], [404, "text/plain"]] as const)(
    "does not cache a %s %s response under a script URL", async (status, mime) => {
      const network = new Response("Not a script", { status, headers: { "Content-Type": mime } });
      const { result, put } = scriptRequest(network);
      expect(await result).toBe(network);
      expect(put).not.toHaveBeenCalled();
    }
  );

  it("keeps caching a successful JavaScript response", async () => {
    const network = new Response("export {};", { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    const { result, put, request } = scriptRequest(network);
    expect(await result).toBe(network);
    expect(put).toHaveBeenCalledWith(request, expect.any(Response));
  });

  it("retires pre-fix caches on activation without touching other same-origin apps", async () => {
    const addEventListener = vi.fn();
    const remove = vi.fn().mockResolvedValue(true);
    const claim = vi.fn();
    runInNewContext(source, {
      self: { addEventListener, clients: { claim } },
      caches: { keys: async () => ["phosphene-shell-v4", "phosphene-runtime-v4", "another-app"], delete: remove }
    });
    const activate = addEventListener.mock.calls.find(([type]) => type === "activate")![1];
    const waitUntil = vi.fn();
    activate({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(remove.mock.calls.flat()).toEqual(["phosphene-shell-v4", "phosphene-runtime-v4"]);
    expect(claim).toHaveBeenCalledOnce();
  });
});
