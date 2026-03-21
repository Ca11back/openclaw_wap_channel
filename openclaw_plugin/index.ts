import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { wapPlugin } from "./src/channel.js";
import { registerWapCommands } from "./src/commands.js";
import { registerWapTools } from "./src/tools.js";
import { startWsService, stopWsService, setWapRuntime } from "./src/ws-server.js";

const plugin = {
    id: "openclaw-channel-wap",
    name: "WeChat (WAP)",
    description: "WeChat channel via WAuxiliary plugin",
    configSchema: emptyPluginConfigSchema(),
    register(api: OpenClawPluginApi) {
        setWapRuntime(api);
        api.registerChannel({ plugin: wapPlugin });
        registerWapTools(api);
        registerWapCommands(api);
        api.registerService({
            id: "wap-ws-server",
            start: () => startWsService(api),
            stop: () => stopWsService(),
        });
    },
};

export default plugin;
