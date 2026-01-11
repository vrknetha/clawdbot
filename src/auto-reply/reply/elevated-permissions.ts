import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type {
  AgentElevatedAllowFromConfig,
  ClawdbotConfig,
} from "../../config/config.js";
import type { MsgContext } from "../templating.js";

function normalizeAllowToken(value?: string) {
  if (!value) return "";
  return value.trim().toLowerCase();
}

function slugAllowToken(value?: string) {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[@#]+/, "");
  text = text.replace(/[\s_]+/g, "-");
  text = text.replace(/[^a-z0-9-]+/g, "-");
  return text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

function stripSenderPrefix(value?: string) {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.replace(
    /^(whatsapp|telegram|discord|signal|imessage|webchat|user|group|channel):/i,
    "",
  );
}

function resolveElevatedAllowList(
  allowFrom: AgentElevatedAllowFromConfig | undefined,
  provider: string,
  discordFallback?: Array<string | number>,
): Array<string | number> | undefined {
  switch (provider) {
    case "whatsapp":
      return allowFrom?.whatsapp;
    case "telegram":
      return allowFrom?.telegram;
    case "discord": {
      const hasExplicit = Boolean(
        allowFrom && Object.hasOwn(allowFrom, "discord"),
      );
      if (hasExplicit) return allowFrom?.discord;
      return discordFallback;
    }
    case "signal":
      return allowFrom?.signal;
    case "imessage":
      return allowFrom?.imessage;
    case "webchat":
      return allowFrom?.webchat;
    default:
      return undefined;
  }
}

function isApprovedElevatedSender(params: {
  provider: string;
  ctx: MsgContext;
  allowFrom?: AgentElevatedAllowFromConfig;
  discordFallback?: Array<string | number>;
}): boolean {
  const rawAllow = resolveElevatedAllowList(
    params.allowFrom,
    params.provider,
    params.discordFallback,
  );
  if (!rawAllow || rawAllow.length === 0) return false;

  const allowTokens = rawAllow
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (allowTokens.length === 0) return false;
  if (allowTokens.some((entry) => entry === "*")) return true;

  const tokens = new Set<string>();
  const addToken = (value?: string) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    tokens.add(trimmed);
    const normalized = normalizeAllowToken(trimmed);
    if (normalized) tokens.add(normalized);
    const slugged = slugAllowToken(trimmed);
    if (slugged) tokens.add(slugged);
  };

  addToken(params.ctx.SenderName);
  addToken(params.ctx.SenderUsername);
  addToken(params.ctx.SenderTag);
  addToken(params.ctx.SenderE164);
  addToken(params.ctx.From);
  addToken(stripSenderPrefix(params.ctx.From));
  addToken(params.ctx.To);
  addToken(stripSenderPrefix(params.ctx.To));

  for (const rawEntry of allowTokens) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const stripped = stripSenderPrefix(entry);
    if (tokens.has(entry) || tokens.has(stripped)) return true;
    const normalized = normalizeAllowToken(stripped);
    if (normalized && tokens.has(normalized)) return true;
    const slugged = slugAllowToken(stripped);
    if (slugged && tokens.has(slugged)) return true;
  }

  return false;
}

export function resolveElevatedPermissions(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  ctx: MsgContext;
  provider: string;
}): {
  enabled: boolean;
  allowed: boolean;
  failures: Array<{ gate: string; key: string }>;
} {
  const globalConfig = params.cfg.tools?.elevated;
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId)?.tools
    ?.elevated;
  const globalEnabled = globalConfig?.enabled !== false;
  const agentEnabled = agentConfig?.enabled !== false;
  const enabled = globalEnabled && agentEnabled;
  const failures: Array<{ gate: string; key: string }> = [];
  if (!globalEnabled)
    failures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  if (!agentEnabled)
    failures.push({
      gate: "enabled",
      key: "agents.list[].tools.elevated.enabled",
    });
  if (!enabled) return { enabled, allowed: false, failures };
  if (!params.provider) {
    failures.push({ gate: "provider", key: "ctx.Provider" });
    return { enabled, allowed: false, failures };
  }

  const discordFallback =
    params.provider === "discord"
      ? params.cfg.discord?.dm?.allowFrom
      : undefined;
  const globalAllowed = isApprovedElevatedSender({
    provider: params.provider,
    ctx: params.ctx,
    allowFrom: globalConfig?.allowFrom,
    discordFallback,
  });
  if (!globalAllowed) {
    failures.push({
      gate: "allowFrom",
      key:
        params.provider === "discord" && discordFallback
          ? "tools.elevated.allowFrom.discord (or discord.dm.allowFrom fallback)"
          : `tools.elevated.allowFrom.${params.provider}`,
    });
    return { enabled, allowed: false, failures };
  }

  const agentAllowed = agentConfig?.allowFrom
    ? isApprovedElevatedSender({
        provider: params.provider,
        ctx: params.ctx,
        allowFrom: agentConfig.allowFrom,
      })
    : true;
  if (!agentAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `agents.list[].tools.elevated.allowFrom.${params.provider}`,
    });
  }
  return { enabled, allowed: globalAllowed && agentAllowed, failures };
}

export function formatElevatedUnavailableMessage(params: {
  runtimeSandboxed: boolean;
  failures: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  if (params.failures.length > 0) {
    lines.push(
      `Failing gates: ${params.failures
        .map((f) => `${f.gate} (${f.key})`)
        .join(", ")}`,
    );
  } else {
    lines.push(
      "Failing gates: enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled), allowFrom (tools.elevated.allowFrom.<provider>).",
    );
  }
  lines.push("Fix-it keys:");
  lines.push("- tools.elevated.enabled");
  lines.push("- tools.elevated.allowFrom.<provider>");
  lines.push("- agents.list[].tools.elevated.enabled");
  lines.push("- agents.list[].tools.elevated.allowFrom.<provider>");
  if (params.sessionKey) {
    lines.push(`See: clawdbot sandbox explain --session ${params.sessionKey}`);
  }
  return lines.join("\n");
}
