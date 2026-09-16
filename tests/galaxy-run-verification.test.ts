/**
 * `verifyGalaxyRun` -- the round trip the record tools make before writing an
 * id into the notebook, and the line it draws between "Galaxy says this id is
 * not a thing" and "Galaxy didn't answer".
 *
 * Only `fetch` is faked, so the status-to-outcome mapping is exercised through
 * the real `galaxyGet`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalaxyApiError, verifyGalaxyRun } from "../extensions/loom/galaxy-api";

function response(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : {}),
  } as unknown as Response;
}

describe("verifyGalaxyRun", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("asks the invocation endpoint for an invocation id", async () => {
    const fetchMock = vi.fn(async () => response(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyGalaxyRun("invocation", "inv-1")).toEqual({ outcome: "found" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://usegalaxy.org/api/invocations/inv-1");
  });

  it("asks the jobs endpoint for a job id", async () => {
    const fetchMock = vi.fn(async () => response(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyGalaxyRun("job", "job-1")).toEqual({ outcome: "found" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://usegalaxy.org/api/jobs/job-1");
  });

  it("reports a 404 as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(404, "No invocation found")),
    );
    const result = await verifyGalaxyRun("invocation", "nope");
    expect(result.outcome).toBe("absent");
    expect(result).toHaveProperty("detail", expect.stringContaining("404"));
  });

  it("reports a 400 as absent, because that is what a malformed id returns", async () => {
    // Galaxy decodes ids before it looks anything up, and decode_id raises
    // MalformedId -- a 400 -- for a value that isn't an encoded id at all.
    // A hallucinated id arrives in exactly that shape.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(400, "Malformed id")),
    );
    expect((await verifyGalaxyRun("job", "not-an-id")).outcome).toBe("absent");
  });

  it("reports a server error as unreachable, not absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(502, "bad gateway")),
    );
    const result = await verifyGalaxyRun("invocation", "inv-1");
    expect(result.outcome).toBe("unreachable");
    expect(result).toHaveProperty("detail", expect.stringContaining("502"));
  });

  it("reports an auth failure as unreachable -- a 403 is about us, not the id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(403, "Forbidden")),
    );
    expect((await verifyGalaxyRun("job", "job-1")).outcome).toBe("unreachable");
  });

  it("reports a dead network as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await verifyGalaxyRun("invocation", "inv-1");
    expect(result.outcome).toBe("unreachable");
    expect(result).toHaveProperty("detail", expect.stringContaining("fetch failed"));
  });

  it("reports missing credentials as unreachable without calling out", async () => {
    delete process.env.GALAXY_API_KEY;
    const fetchMock = vi.fn(async () => response(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyGalaxyRun("invocation", "inv-1");
    expect(result.outcome).toBe("unreachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("percent-encodes the id rather than pasting it into the path", async () => {
    const fetchMock = vi.fn(async () => response(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);

    await verifyGalaxyRun("job", "a/b?c");
    expect(fetchMock.mock.calls[0][0]).toBe("https://usegalaxy.org/api/jobs/a%2Fb%3Fc");
  });
});

describe("GalaxyApiError", () => {
  it("keeps the message shape callers already match on", () => {
    expect(new GalaxyApiError(404, "not found", "Not Found").message).toBe(
      "Galaxy API 404: not found",
    );
    expect(new GalaxyApiError(500, "", "Server Error").message).toBe(
      "Galaxy API 500: Server Error",
    );
  });
});
