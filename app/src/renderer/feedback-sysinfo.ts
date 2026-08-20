import type { FeedbackSysinfo } from "../../../shared/feedback-contract.js";

/**
 * What the `report:sysinfo` IPC handler hands back. Field names differ from the
 * wire shape (electronVersion vs electron), which is why this mapping exists.
 */
export interface ReportSysinfoEnvelope {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  arch: string;
  wsl?: boolean;
}

/** The slice of LoomConfig the report needs. */
export interface FeedbackConfigView {
  llm?: { active?: string; providers?: Record<string, { model?: string }> };
  galaxy?: { active: string | null };
}

/**
 * Orbit's FeedbackSysinfo builder -- the shell-side counterpart to the brain's
 * buildBrainSysinfo(). DOM-free so it stays testable outside Electron. Carries
 * no cwd and no credentials.
 */
export function toFeedbackSysinfo(
  info: ReportSysinfoEnvelope,
  cfg: FeedbackConfigView,
): FeedbackSysinfo {
  const active = cfg.llm?.active;
  return {
    appVersion: info.appVersion,
    platform: info.platform,
    arch: info.arch,
    wsl: Boolean(info.wsl),
    electron: info.electronVersion,
    chrome: info.chromeVersion,
    node: info.nodeVersion,
    llmProvider: active,
    llmModel: active ? cfg.llm?.providers?.[active]?.model : undefined,
    galaxyConfigured: Boolean(cfg.galaxy?.active),
  };
}
