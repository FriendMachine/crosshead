import { OnlyBotsLocalRuntimeDaemon } from "./local-runtime";
import path from "path";
import { acquireRuntimeDaemonOwnership } from "./daemon-ownership";
import type { OrganizationalWorkerDaemonApi } from "./local-runtime";
import type { OrganizationalWorkerReadiness } from "./organizational-worker-readiness";
import type { OrganizationalWorkerFederationStatusObserver } from "./organizational-worker-federation-protocol";
import { assertSecureNodeRuntimeVersion } from "./node-runtime-version";

/** A daemon extension composed from `--organizational-worker-config`. The public
 * Crosshead runtime ships without one; operator builds supply a composer. */
export type OrganizationalWorkerComposition = {
  api: OrganizationalWorkerDaemonApi | null;
  federationStatusObserver: OrganizationalWorkerFederationStatusObserver | null;
  readiness: OrganizationalWorkerReadiness;
  close(): Promise<void>;
};

export type OrganizationalWorkerComposer = (options: {
  home: string | undefined;
  configPath: string;
}) => Promise<OrganizationalWorkerComposition>;

export type OnlyBotsDaemonCliOptions = {
  composeOrganizationalWorker?: OrganizationalWorkerComposer;
};

const parseFlag = (args: string[], key: string): string | undefined => {
  const index = args.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
};

const parseAbsolutePathFlag = (
  args: string[],
  key: string
): string | undefined => {
  const indexes = args.flatMap((value, index) => (value === key ? [index] : []));
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1) {
    throw new Error(`${key} must be provided exactly once`);
  }
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith("--") || !path.isAbsolute(value)) {
    throw new Error(`${key} requires an absolute path`);
  }
  return path.resolve(value);
};

export const runOnlyBotsDaemonCli = async (
  argv: string[] = process.argv.slice(2),
  options: OnlyBotsDaemonCliOptions = {}
): Promise<void> => {
  assertSecureNodeRuntimeVersion();
  const command = argv[0] ?? "serve";
  if (command !== "serve") {
    throw new Error(`Unsupported crossheadd command: ${command}`);
  }

  const home = parseFlag(argv, "--home");
  const port = Number(parseFlag(argv, "--port") ?? "0");
  const organizationalWorkerConfigPath = parseAbsolutePathFlag(
    argv,
    "--organizational-worker-config"
  );
  const composeOrganizationalWorker = options.composeOrganizationalWorker;
  if (organizationalWorkerConfigPath && !composeOrganizationalWorker) {
    throw new Error("--organizational-worker-config is not supported by this Crosshead runtime build");
  }
  const ownership = await acquireRuntimeDaemonOwnership(home);
  let composition: OrganizationalWorkerComposition | null = null;
  let cleanup: Promise<void> | null = null;
  const closeComposition = () => cleanup ??= composition?.close() ?? Promise.resolve();
  let daemon: OnlyBotsLocalRuntimeDaemon;
  let removeSignalHandlers = () => {};
  try {
    if (organizationalWorkerConfigPath && composeOrganizationalWorker) {
      composition = await composeOrganizationalWorker({
        home,
        configPath: organizationalWorkerConfigPath,
      });
    }
    daemon = new OnlyBotsLocalRuntimeDaemon(home, {
      runtimeCleanup: closeComposition,
      ...(composition?.api ? { organizationalWorker: composition.api } : {}),
      ...(composition?.federationStatusObserver
	? {
	    organizationalWorkerFederationStatusObserver:
	      composition.federationStatusObserver,
	  }
	: {}),
      ...(composition
        ? { organizationalWorkerReadiness: composition.readiness }
        : {}),
      ...(organizationalWorkerConfigPath
        ? { organizationalWorkerConfigPath }
        : {}),
    });
    // Readiness is published inside start(). Arm signals first; stop() waits
    // for an in-progress start before quiescing writers and releasing ownership.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    let failure: unknown = null;
    try {
      await daemon.stop();
    } catch (error) {
      failure = error;
    }
    try {
      await closeComposition();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      console.error(failure instanceof Error ? failure.message : String(failure));
    }
    process.exit(failure ? 1 : 0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  removeSignalHandlers = () => { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); };
    await daemon.start(port, ownership);
  } catch (error) {
    removeSignalHandlers();
    await closeComposition().catch(() => undefined);
    await ownership.close();
    throw error;
  }


};
