import { install } from './install';
import { runMcpServer } from './mcp';
import { runNativeHost } from './native-host';

const usage = `Usage: tab-intentions <command>

  install       Register the native messaging host (ACP mode) and print MCP setup
  mcp           Run the MCP server (stdio) that exposes your browser tabs to an agent
  native-host   Run as Chrome's native messaging host (started by Chrome, not by you)`;

const command = process.argv[2];
const fail = (e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
};

switch (command) {
  case 'install':
    install();
    break;
  case 'mcp':
    runMcpServer().catch(fail);
    break;
  case 'native-host':
    runNativeHost().catch(fail);
    break;
  default:
    // Chrome passes the caller origin as the first argument when it launches a native host directly.
    if (command?.startsWith('chrome-extension://')) runNativeHost().catch(fail);
    else console.log(usage);
}
