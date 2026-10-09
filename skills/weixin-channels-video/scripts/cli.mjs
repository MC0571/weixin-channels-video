#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARSE_ERROR_MESSAGES } from "../../../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, isSafeRelativeMp4Filename, validateBridgeCommand } from "../../../src/native-messaging.mjs";
import { BridgeSetupError, installBridge, listBridgeProfiles, readBridgeInstallation, readBridgeSession } from "./bridge-install.mjs";
import { BridgeError, requestBridge, waitForBridge } from "./bridge-client.mjs";
import { diagnoseEnvironment, launchChrome } from "./diagnostics.mjs";

const USAGE = "Usage: cli.mjs list-profiles | install-bridge --extension-id ID --profile NAME | diagnose | status | connect | parse --url URL | download --url URL [--filename RELATIVE.mp4]";
const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });
const STARTUP_WAIT_MS = 5_000;
const BRIDGE_WAIT_MS = 30_000;

function parseArguments(command, args) {
  const allowed = {
    "list-profiles": [],
    "install-bridge": ["extension-id", "profile"],
    diagnose: [],
    status: [],
    connect: [],
    parse: ["url"],
    download: ["url", "filename"],
  }[command];
  if (!allowed) throw new Error("USAGE");
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error("USAGE");
    const key = argument.slice(2);
    const value = args[index + 1];
    if (!allowed.includes(key) || options[key] !== undefined || !value || value.startsWith("--")) {
      throw new Error("USAGE");
    }
    options[key] = value;
    index += 1;
  }
  if (command === "install-bridge" && (!options["extension-id"] || !options.profile)) throw new Error("USAGE");
  if (["parse", "download"].includes(command) && !options.url) throw new Error("USAGE");
  if (options.filename && !isSafeRelativeMp4Filename(options.filename)) throw new Error("INVALID_FILENAME");
  return options;
}

async function ensureBridgeConnection(config, sessionId, { launch, bridgeWait }) {
  try {
    await bridgeWait(config, sessionId, { timeoutMs: 500 });
    return;
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "BRIDGE_TIMEOUT") throw error;
  }

  await launch(config);
  try {
    await bridgeWait(config, sessionId, { timeoutMs: STARTUP_WAIT_MS });
    return;
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "BRIDGE_TIMEOUT") throw error;
  }

  await launch(config, sessionId);
  await bridgeWait(config, sessionId, { timeoutMs: BRIDGE_WAIT_MS });
}

export async function runCli(argv, {
  stdout = (value) => process.stdout.write(`${value}\n`),
  stderr = (value) => process.stderr.write(`${value}\n`),
  launch = launchChrome,
  install = installBridge,
  listProfiles = listBridgeProfiles,
  readInstallation = readBridgeInstallation,
  readSession = readBridgeSession,
  bridgeRequest = requestBridge,
  bridgeWait = waitForBridge,
  diagnose = diagnoseEnvironment,
} = {}) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    stdout(USAGE);
    return 0;
  }

  let options;
  try { options = parseArguments(command, args); }
  catch (error) {
    if (error.message === "INVALID_FILENAME") {
      stderr("Filename must be a safe relative .mp4 path.");
      return 2;
    }
    stderr(USAGE);
    return 2;
  }

  try {
    if (command === "list-profiles") {
      const profiles = await listProfiles();
      for (const profile of profiles) stdout(JSON.stringify(profile));
      return 0;
    }
    if (command === "install-bridge") {
      const result = await install({ extensionId: options["extension-id"], profile: options.profile });
      stdout(JSON.stringify({ installed: true, profile: result.profile.name, extensionId: result.config.extensionId }));
      return 0;
    }

    if (command === "diagnose") {
      let config;
      let configuration = "unconfigured";
      try {
        config = await readInstallation();
        if (config) configuration = "configured";
      } catch {
        configuration = "invalid";
      }
      let sessionId;
      if (config) {
        try { sessionId = await readSession(config); }
        catch { sessionId = null; }
      }
      const result = await diagnose({ configuration, config, sessionId }, { bridgeWait });
      stdout(JSON.stringify(result));
      return 0;
    }

    const config = await readInstallation();
    if (!config) {
      if (command === "status") {
        stdout(JSON.stringify({ configuration: "unconfigured", connection: "disconnected", login: "not_checked" }));
        return 0;
      }
      throw new BridgeError("BRIDGE_NOT_CONFIGURED", BRIDGE_ERROR_MESSAGES.BRIDGE_NOT_CONFIGURED);
    }
    const sessionId = await readSession(config);

    if (command === "status") {
      if (!sessionId) {
        stdout(JSON.stringify({ configuration: "configured", connection: "disconnected", login: "not_checked" }));
        return 0;
      }
      const id = randomUUID();
      try {
        const result = await bridgeRequest(config, sessionId, { id, command: "status" }, { timeoutMs: 30_000 });
        if (!["authenticated", "anonymous"].includes(result?.login)) throw new BridgeError("BRIDGE_PROTOCOL_ERROR", "ignored");
        stdout(JSON.stringify({ configuration: "configured", connection: "connected", login: result.login }));
      } catch (error) {
        if (error instanceof BridgeError && error.code === "LOGIN_CHECK_FAILED") {
          stdout(JSON.stringify({ configuration: "configured", connection: "connected", login: "failed:LOGIN_CHECK_FAILED" }));
          return 1;
        }
        const code = error instanceof BridgeError ? error.code : "BRIDGE_PROTOCOL_ERROR";
        if (code === "BRIDGE_DISCONNECTED") {
          stdout(JSON.stringify({ configuration: "configured", connection: "disconnected", login: "not_checked" }));
          return 0;
        }
        stdout(JSON.stringify({ configuration: "configured", connection: `failed:${code}`, login: "not_checked" }));
        return 1;
      }
      return 0;
    }

    if (command === "connect") {
      if (!sessionId) throw new BridgeError("BRIDGE_NOT_CONFIGURED", BRIDGE_ERROR_MESSAGES.BRIDGE_NOT_CONFIGURED);
      await ensureBridgeConnection(config, sessionId, { launch, bridgeWait });
      stdout("Connected to the Chrome extension.");
      return 0;
    }

    if (command === "parse" || command === "download") {
      if (!sessionId) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
      await ensureBridgeConnection(config, sessionId, { launch, bridgeWait });
      const request = command === "parse"
        ? { id: randomUUID(), command, url: options.url }
        : {
            id: randomUUID(),
            command,
            url: options.url,
            ...(options.filename ? { filename: options.filename } : {}),
          };
      if (!validateBridgeCommand(request)) throw new BridgeError("INVALID_COMMAND", BRIDGE_ERROR_MESSAGES.INVALID_COMMAND);
      const timeoutMs = command === "download" ? 31 * 60_000 : 90_000;
      let result;
      try { result = await bridgeRequest(config, sessionId, request, { timeoutMs }); }
      catch (error) {
        if (command === "download" && error instanceof BridgeError && error.details) {
          stdout(JSON.stringify(error.details));
          return 1;
        }
        throw error;
      }
      stdout(JSON.stringify(result));
      if (command === "download" && result.state === "interrupted") return 1;
      return 0;
    }
  } catch (error) {
    const code = error instanceof BridgeError || error instanceof BridgeSetupError
      ? error.code
      : command === "install-bridge" || command === "list-profiles" ? "BRIDGE_INSTALL_FAILED" : "BRIDGE_CONFIG_INVALID";
    const message = error instanceof BridgeSetupError
      ? error.message
      : ERROR_MESSAGES[code] ?? "请求失败。";
    stderr(`${code}: ${message}`);
    return 1;
  }

  stderr(USAGE);
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("Command failed.\n");
    process.exitCode = 1;
  });
}
