import { runOnlyBotsDaemonCli } from "./daemon-host";

export { runOnlyBotsDaemonCli };

if (require.main === module) {
  runOnlyBotsDaemonCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
