import { afterEach, describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { resetBashChatCommandForTests } from "./bash-command.js";
import { parseInlineDirectives } from "./directive-handling.js";

function buildParams(
  commandBody: string,
  cfg: ClawdbotConfig,
  ctxOverrides?: Partial<MsgContext>,
) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleCommands gating", () => {
  afterEach(() => {
    resetBashChatCommandForTests();
    resetProcessRegistryForTests();
  });

  it("blocks /config when disabled", async () => {
    const cfg = {
      commands: { config: false, debug: false, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("/config show", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/config is disabled");
  });

  it("blocks /debug when disabled", async () => {
    const cfg = {
      commands: { config: false, debug: false, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("/debug show", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/debug is disabled");
  });

  it("blocks /bash when disabled", async () => {
    const cfg = {
      commands: { bash: false, text: true },
      whatsapp: { allowFrom: ["*"] },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["*"] } } },
    } as ClawdbotConfig;
    const params = buildParams("/bash echo hi", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/bash is disabled");
  });

  it("blocks /bash when elevated is not allowlisted", async () => {
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: [] } } },
    } as ClawdbotConfig;
    const params = buildParams("/bash echo hi", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("elevated is not available");
  });
});

describe("handleCommands identity", () => {
  it("returns sender details for /whoami", async () => {
    const cfg = {
      commands: { text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("/whoami", cfg, {
      SenderId: "12345",
      SenderUsername: "TestUser",
      ChatType: "direct",
    });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Provider: whatsapp");
    expect(result.reply?.text).toContain("User id: 12345");
    expect(result.reply?.text).toContain("Username: @TestUser");
    expect(result.reply?.text).toContain("AllowFrom: 12345");
  });
});

describe("handleCommands /bash", () => {
  afterEach(() => {
    resetBashChatCommandForTests();
    resetProcessRegistryForTests();
  });

  it("runs /bash in the foreground when fast", async () => {
    const cfg = {
      commands: { bash: true, bashForegroundMs: 2000, text: true },
      whatsapp: { allowFrom: ["*"] },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["*"] } } },
    } as ClawdbotConfig;
    const params = buildParams("/bash echo hi", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exit:");
    expect(result.reply?.text).toContain("hi");
  });

  it("supports background + poll + one-at-a-time", async () => {
    const cfg = {
      commands: { bash: true, bashForegroundMs: 0, text: true },
      whatsapp: { allowFrom: ["*"] },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["*"] } } },
    } as ClawdbotConfig;

    const start = await handleCommands(buildParams("/bash echo hi", cfg));
    expect(start.reply?.text).toContain("bash started");
    const startedText = start.reply?.text ?? "";
    const idMatch = startedText.match(
      /session\s+([0-9a-fA-F-]{8,})/,
    );
    expect(idMatch).toBeTruthy();
    const sessionId = (idMatch?.[1] ?? "").trim();

    let pollText = "";
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const poll = await handleCommands(
        buildParams(`/bash poll ${sessionId}`, cfg),
      );
      pollText = poll.reply?.text ?? "";
      if (pollText.includes("hi")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pollText).toContain("hi");

    const longStart = await handleCommands(
      buildParams(
        '/bash node -e "setTimeout(function(){},60000)"',
        cfg,
      ),
    );
    expect(longStart.reply?.text).toContain("bash started");
    const longIdMatch = (longStart.reply?.text ?? "").match(
      /session\s+([0-9a-fA-F-]{8,})/,
    );
    expect(longIdMatch).toBeTruthy();
    const longSessionId = (longIdMatch?.[1] ?? "").trim();

    const second = await handleCommands(buildParams("/bash echo second", cfg));
    expect(second.reply?.text).toContain("already running");

    const stop = await handleCommands(
      buildParams(`/bash stop ${longSessionId}`, cfg),
    );
    expect(stop.reply?.text).toContain("bash stopped");
  });
});
