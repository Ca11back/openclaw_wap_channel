import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk";
import { CHANNEL_ID, resolveWapAccount } from "./config.js";
import { buildWapClientDiagnostics } from "./operations.js";

function buildWapDoctorText(config: OpenClawConfig, accountId?: string | null): string {
  const resolvedAccount = resolveWapAccount(config, accountId);
  const diagnostics = buildWapClientDiagnostics(resolvedAccount.accountId);
  const rpcMethods = diagnostics.capabilities?.rpc_methods?.join(", ") || "(none advertised)";
  const commandTypes = diagnostics.capabilities?.command_types?.join(", ") || "(none advertised)";

  return [
    `WAP diagnostics for account: ${resolvedAccount.accountId}`,
    `enabled: ${resolvedAccount.enabled}`,
    `configured: ${String(Boolean(resolvedAccount.config.authToken ?? process.env.WAP_AUTH_TOKEN))}`,
    `connectedClients: ${diagnostics.connectedClients}`,
    `protocolVersion: ${diagnostics.capabilities?.protocol_version ?? "(unknown)"}`,
    `rpcMethods: ${rpcMethods}`,
    `commandTypes: ${commandTypes}`,
    `channelId: ${CHANNEL_ID}`,
  ].join("\n");
}

export function registerWapCommands(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "wap_doctor",
    description: "Inspect WAP plugin readiness and connected client capabilities",
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx: { config: OpenClawConfig; accountId?: string | null }) {
      return {
        text: buildWapDoctorText(ctx.config, ctx.accountId),
      };
    },
  });

  api.registerCommand({
    name: "wap",
    description: "WAP plugin commands (doctor, capabilities, help)",
    acceptsArgs: true,
    requireAuth: true,
    async handler(ctx: { config: OpenClawConfig; accountId?: string | null; args?: string }) {
      const subcommand = ctx.args?.trim().split(/\s+/)[0]?.toLowerCase() ?? "help";
      if (subcommand === "doctor" || subcommand === "capabilities" || subcommand === "status") {
        return {
          text: buildWapDoctorText(ctx.config, ctx.accountId),
        };
      }
      return {
        text: [
          "WAP plugin commands:",
          "/wap doctor",
          "/wap capabilities",
          "/wap help",
        ].join("\n"),
      };
    },
  });

  api.registerCli(
    (ctx: {
      program: {
        command: (name: string) => {
          description: (text: string) => {
            action: (handler: () => void) => void;
          };
        };
      };
      config: OpenClawConfig;
    }) => {
      ctx.program
        .command("wap-diagnose")
        .description("Inspect WAP plugin readiness and connected client capabilities")
        .action(() => {
          // eslint-disable-next-line no-console -- CLI command writes directly to the terminal.
          console.log(buildWapDoctorText(ctx.config));
        });
    },
    { commands: ["wap-diagnose"] },
  );
}
