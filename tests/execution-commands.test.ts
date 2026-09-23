import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerExecutionCommands } from "../extensions/loom/execution-commands";
import { resetState, setNotebookPath } from "../extensions/loom/state";

let tmpDir: string;
let nbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-execute-command-"));
  nbPath = path.join(tmpDir, "notebook.md");
  resetState();
});

afterEach(() => {
  resetState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRunnableNotebook() {
  fs.writeFileSync(
    nbPath,
    `
## Plan A: Smoke [local]

- [ ] 1. **Write config** {#plan-a-step-1} -- create the requested config file
  - Routing: local
  - Tool: file write
  - Verification: read the file back and confirm the requested key is present
`,
    "utf-8",
  );
  setNotebookPath(nbPath);
}

describe("registerExecutionCommands", () => {
  it("instructs the agent to verify before marking a step complete", async () => {
    writeRunnableNotebook();

    const commands = new Map<string, { handler: (args: string | undefined, ctx: any) => void }>();
    const sendUserMessage = vi.fn();
    const pi = {
      registerCommand: vi.fn(
        (name: string, command: { handler: (args: string | undefined, ctx: any) => void }) => {
          commands.set(name, command);
        },
      ),
      sendUserMessage,
    };

    registerExecutionCommands(pi as any);
    await commands.get("execute")!.handler(undefined, { ui: { notify: vi.fn() } });

    const prompt = sendUserMessage.mock.calls[0][0] as string;
    // Background execution must not become a new user approval checkpoint.
    expect(prompt).toContain("Galaxy steps run in the BACKGROUND");
    expect(prompt).toContain("Continue other ready, authorized work");
    expect(prompt).toContain("If the run already finished, verify it in this turn");
    expect(prompt).toContain("Do not wait for the user to ask again");
    expect(prompt).toContain("Do NOT sit in this turn polling the invocation to completion");
    // Evidence still gates continuation.
    expect(prompt).toContain("use the step's `Verification:` sub-bullet");
    expect(prompt).toContain("verification happens");
    expect(prompt).toContain("Write the verification evidence into the notebook");
    expect(prompt).toContain("Only after verification succeeds");
    expect(prompt).toContain("created but not verified");
    expect(prompt).toContain("Do NOT claim the artifact or step is done");
  });
});
