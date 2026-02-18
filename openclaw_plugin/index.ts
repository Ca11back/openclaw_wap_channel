import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wapPlugin } from "./src/channel.js";
import { startWsService, stopWsService, setWapRuntime } from "./src/ws-server.js";

const plugin = {
    id: "openclaw-channel-wap",
    name: "WeChat (WAP)",
    description: "WeChat channel via WAuxiliary plugin",
    configSchema: emptyPluginConfigSchema(),
    register(api: OpenClawPluginApi) {
        setWapRuntime(api);
        api.registerChannel({ plugin: wapPlugin });
        api.registerService({
            id: "wap-ws-server",
            start: () => startWsService(api),
            stop: () => stopWsService(),
        });
    },
};

export default plugin;

