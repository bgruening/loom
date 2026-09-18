// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDashboard } from "../app/src/renderer/dashboard/bootstrap.js";
import {
  createDefaultDashboardDocument,
  serializeDashboardDocument,
} from "../shared/dashboard-contract.js";

interface FakeShell {
  loadDashboard?: ReturnType<typeof vi.fn>;
  saveDashboard?: ReturnType<typeof vi.fn>;
  readFile?: ReturnType<typeof vi.fn>;
  listFiles?: ReturnType<typeof vi.fn>;
}

let root: HTMLElement;

function installShell(shell: FakeShell): void {
  (window as unknown as Record<string, unknown>).orbit = shell;
}

/** Let the load promise chain settle without advancing the save debounce. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = "<div id='dash'></div>";
  root = document.getElementById("dash")!;
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).orbit;
});

describe("first run", () => {
  it("renders the default layout and says nothing when there is no file", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(true);
    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("treats an empty file the same as no file", async () => {
    installShell({
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: "   " }),
      saveDashboard: vi.fn(),
    });
    const dash = initDashboard(root);
    await settle();
    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(true);
  });
});

describe("loading a saved layout", () => {
  it("adopts it without writing it straight back", async () => {
    const saved = {
      version: 1,
      activeId: "mine",
      dashboards: [
        {
          id: "mine",
          title: "Mine",
          panels: [{ id: "p", widget: "jobs", config: {}, layout: { span: 2 as const, rows: 4 } }],
        },
      ],
    };
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: JSON.stringify(saved) }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    expect(dash.host.getActiveDashboard()?.id).toBe("mine");
    vi.advanceTimersByTime(1000);
    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("falls back to the default and leaves a corrupt file alone", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: "{ not json" }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const banner = root.querySelector(".dash-banner") as HTMLElement;
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toContain("could not be read");
    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
    vi.advanceTimersByTime(1000);
    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("refuses a document from a newer build the same way", async () => {
    installShell({
      loadDashboard: vi
        .fn()
        .mockResolvedValue({ ok: true, raw: '{"version":99,"activeId":"x","dashboards":[]}' }),
      saveDashboard: vi.fn(),
    });
    initDashboard(root);
    await settle();
    expect(root.querySelector(".dash-banner")?.classList.contains("hidden")).toBe(false);
  });

  it("reports a shell-side read error in the banner", async () => {
    installShell({
      loadDashboard: vi.fn().mockResolvedValue({ ok: false, error: "EACCES" }),
      saveDashboard: vi.fn(),
    });
    initDashboard(root);
    await settle();
    expect(root.querySelector(".dash-banner")?.textContent).toContain("EACCES");
  });
});

describe("saving", () => {
  it("writes the serialized document after the debounce, once", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const first = dash.host.getDocument();
    first.dashboards[0].title = "Renamed";
    dash.host.setDocument(first);
    const second = dash.host.getDocument();
    second.dashboards[0].title = "Renamed twice";
    dash.host.setDocument(second);

    expect(shell.saveDashboard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(shell.saveDashboard).toHaveBeenCalledTimes(1);
    const written = shell.saveDashboard!.mock.calls[0][0] as string;
    expect(written).toBe(serializeDashboardDocument(dash.host.getDocument()));
    expect(JSON.parse(written).dashboards[0].title).toBe("Renamed twice");
  });

  it("drops a queued save when the analysis directory changes under it", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const changed = dash.host.getDocument();
    changed.dashboards[0].title = "Belongs to the old workspace";
    dash.host.setDocument(changed);

    dash.reloadForCwd();
    vi.advanceTimersByTime(1000);
    await settle();

    expect(shell.saveDashboard).not.toHaveBeenCalled();
  });

  it("goes back to the default layout when the new directory has none", async () => {
    const shell: FakeShell = {
      loadDashboard: vi.fn().mockResolvedValue({ ok: true, raw: null }),
      saveDashboard: vi.fn().mockResolvedValue({ ok: true }),
    };
    installShell(shell);
    const dash = initDashboard(root);
    await settle();

    const changed = dash.host.getDocument();
    changed.dashboards[0].title = "Old workspace";
    dash.host.setDocument(changed, { persist: false });

    dash.reloadForCwd();
    await settle();
    expect(dash.host.getDocument()).toEqual(createDefaultDashboardDocument());
  });
});

describe("a shell with no dashboard channels", () => {
  it("still renders, and does not blow up trying to save", async () => {
    installShell({});
    const dash = initDashboard(root);
    await settle();

    expect(root.querySelectorAll(".dash-panel").length).toBeGreaterThan(0);
    const next = dash.host.getDocument();
    next.dashboards[0].title = "Whatever";
    expect(() => dash.host.setDocument(next)).not.toThrow();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it("survives a load that rejects", async () => {
    installShell({ loadDashboard: vi.fn().mockRejectedValue(new Error("socket gone")) });
    expect(() => initDashboard(root)).not.toThrow();
    await settle();
    expect(root.querySelectorAll(".dash-panel").length).toBeGreaterThan(0);
  });
});
