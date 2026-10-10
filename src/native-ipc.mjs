import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { MAX_BRIDGE_MESSAGE_BYTES, SESSION_ID_PATTERN } from "./native-messaging.mjs";
import { windowsPowerShellPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

export const IPC_PROTOCOL = 2;
export const IPC_AUTH_TIMEOUT_MS = 5_000;
export const WINDOWS_PIPE_START_TIMEOUT_MS = 10_000;
export const WINDOWS_PIPE_NAME_PREFIX = "weixin-channels-video-";

const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const PROOF_DOMAIN = "weixin-channels-video\0native-ipc\0v2\0";
const WINDOWS_PIPE_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
function Write-Transport-Marker([System.IO.Stream]$stream, [uint32]$length) {
  $stream.Write([BitConverter]::GetBytes($length), 0, 4)
  $stream.Flush()
}
try {
  $pipeName = $env:WCV_IPC_PIPE_NAME
  if ($pipeName -notmatch '^weixin-channels-video-[0-9a-f]{32}$') { exit 2 }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $userSid = $identity.User
  $logonSids = @($identity.Groups | Where-Object { $_.Value -match '^S-1-5-5-\d+-\d+$' })
  if ($null -eq $userSid -or $logonSids.Count -ne 1) { exit 3 }

  $pipeSecurity = New-Object System.IO.Pipes.PipeSecurity
  $pipeSecurity.SetAccessRuleProtection($true, $false)
  $pipeSecurity.SetOwner($userSid)
  $fullControl = [System.IO.Pipes.PipeAccessRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $pipeSecurity.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($logonSids[0], $fullControl, $allow))
  $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,
    4096,
    4096,
    $pipeSecurity
  )

  $actual = $pipe.GetAccessControl()
  $actualOwner = $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or
      $actualOwner -ne $userSid.Value -or
      $rules.Count -ne 1) { exit 4 }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $logonSids[0].Value -or
        $rule.AccessControlType -ne $allow -or
        $rule.PipeAccessRights -ne $fullControl) { exit 5 }
  }

  $processInput = [Console]::OpenStandardInput()
  $processOutput = [Console]::OpenStandardOutput()
  $processReadBuffer = New-Object byte[] 65536
  $processBuffer = New-Object 'System.Collections.Generic.List[byte]'
  $processRead = $processInput.ReadAsync($processReadBuffer, 0, $processReadBuffer.Length)
  $pipeReadBuffer = New-Object byte[] 65536
  $pipeBuffer = New-Object 'System.Collections.Generic.List[byte]'
  [Console]::Error.WriteLine('READY')
  [Console]::Error.Flush()
  while ($true) {
    $accept = $pipe.WaitForConnectionAsync()
    while (-not $accept.IsCompleted) {
      $winner = [System.Threading.Tasks.Task]::WhenAny($accept, $processRead).GetAwaiter().GetResult()
      if ([object]::ReferenceEquals($winner, $processRead)) {
        $count = $processRead.GetAwaiter().GetResult()
        if ($count -eq 0) { $pipe.Dispose(); exit 0 }
        $processBuffer.AddRange([byte[]]$processReadBuffer[0..($count - 1)])
        $processRead = $processInput.ReadAsync($processReadBuffer, 0, $processReadBuffer.Length)
      }
    }
    $accept.GetAwaiter().GetResult()
    Write-Transport-Marker $processOutput 0
    $pipeBuffer.Clear()
    $connected = $true
    try {
      while ($connected) {
        $forwarded = $false
        if ($pipeBuffer.Count -ge 4) {
          $header = $pipeBuffer.GetRange(0, 4).ToArray()
          $length = [BitConverter]::ToUInt32($header, 0)
          if ($length -eq 0 -or $length -gt 1048576) { $connected = $false; break }
          if ($pipeBuffer.Count -ge 4 + $length) {
            $frame = $pipeBuffer.GetRange(0, 4 + [int]$length).ToArray()
            $pipeBuffer.RemoveRange(0, 4 + [int]$length)
            $processOutput.Write($frame, 0, $frame.Length)
            $processOutput.Flush()
            $forwarded = $true
          }
        }
        if (-not $forwarded) { $pipeRead = $pipe.ReadAsync($pipeReadBuffer, 0, $pipeReadBuffer.Length) }
        while ($connected -and -not $forwarded) {
          $winner = [System.Threading.Tasks.Task]::WhenAny($pipeRead, $processRead).GetAwaiter().GetResult()
          if ([object]::ReferenceEquals($winner, $processRead)) {
            $count = $processRead.GetAwaiter().GetResult()
            if ($count -eq 0) { $pipe.Dispose(); exit 0 }
            $processBuffer.AddRange([byte[]]$processReadBuffer[0..($count - 1)])
            $processRead = $processInput.ReadAsync($processReadBuffer, 0, $processReadBuffer.Length)
            if ($processBuffer.Count -ge 4) {
              $hostHeader = $processBuffer.GetRange(0, 4).ToArray()
              $hostLength = [BitConverter]::ToUInt32($hostHeader, 0)
              if ($hostLength -eq 0) {
                $processBuffer.RemoveRange(0, 4)
                $pipe.Disconnect()
                try { [void]$pipeRead.GetAwaiter().GetResult() } catch { }
                $connected = $false
                break
              }
              if ($hostLength -gt 1048576) { exit 7 }
              if ($processBuffer.Count -ge 4 + $hostLength) {
                $hostFrame = $processBuffer.GetRange(0, 4 + [int]$hostLength).ToArray()
                $processBuffer.RemoveRange(0, 4 + [int]$hostLength)
                $pipe.Write($hostFrame, 0, $hostFrame.Length)
                $pipe.Flush()
              }
            }
            continue
          }
          $count = $pipeRead.GetAwaiter().GetResult()
          if ($count -eq 0) { $connected = $false; break }
          $pipeBuffer.AddRange([byte[]]$pipeReadBuffer[0..($count - 1)])
          if ($pipeBuffer.Count -ge 4) {
            $header = $pipeBuffer.GetRange(0, 4).ToArray()
            $length = [BitConverter]::ToUInt32($header, 0)
            if ($length -eq 0 -or $length -gt 1048576) { $connected = $false; break }
            if ($pipeBuffer.Count -ge 4 + $length) {
              $frame = $pipeBuffer.GetRange(0, 4 + [int]$length).ToArray()
              $pipeBuffer.RemoveRange(0, 4 + [int]$length)
              $processOutput.Write($frame, 0, $frame.Length)
              $processOutput.Flush()
              $forwarded = $true
            }
          }
          if (-not $forwarded -and $connected) {
            $pipeRead = $pipe.ReadAsync($pipeReadBuffer, 0, $pipeReadBuffer.Length)
          }
        }
        if (-not $connected) { break }

        $hostFrameWritten = $false
        while ($connected -and -not $hostFrameWritten) {
          if ($processBuffer.Count -ge 4) {
            $hostHeader = $processBuffer.GetRange(0, 4).ToArray()
            $hostLength = [BitConverter]::ToUInt32($hostHeader, 0)
            if ($hostLength -eq 0) {
              $processBuffer.RemoveRange(0, 4)
              $pipe.Disconnect()
              $connected = $false
              break
            }
            if ($hostLength -gt 1048576) { exit 8 }
            if ($processBuffer.Count -ge 4 + $hostLength) {
              $hostFrame = $processBuffer.GetRange(0, 4 + [int]$hostLength).ToArray()
              $processBuffer.RemoveRange(0, 4 + [int]$hostLength)
              $pipe.Write($hostFrame, 0, $hostFrame.Length)
              $pipe.Flush()
              $hostFrameWritten = $true
              if ($processBuffer.Count -ge 4) {
                $nextHostHeader = $processBuffer.GetRange(0, 4).ToArray()
                if ([BitConverter]::ToUInt32($nextHostHeader, 0) -eq 0) {
                  $processBuffer.RemoveRange(0, 4)
                  $pipe.Disconnect()
                  $connected = $false
                }
              }
              continue
            }
          }
          $count = $processRead.GetAwaiter().GetResult()
          if ($count -eq 0) { $pipe.Dispose(); exit 0 }
          $processBuffer.AddRange([byte[]]$processReadBuffer[0..($count - 1)])
          $processRead = $processInput.ReadAsync($processReadBuffer, 0, $processReadBuffer.Length)
        }
      }
    } finally {
      if ($pipe.IsConnected) { $pipe.Disconnect() }
      Write-Transport-Marker $processOutput 4294967295
    }
  }
} catch {
  exit 1
}
`;

export function isIpcSession(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    typeof value.sessionId === "string" &&
    SESSION_ID_PATTERN.test(value.sessionId) &&
    value.ipcProtocol === IPC_PROTOCOL &&
    typeof value.ipcSecret === "string" && SECRET_PATTERN.test(value.ipcSecret);
}

export function isIpcNonce(value) {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export function createIpcNonce() {
  return randomBytes(32).toString("hex");
}

export function createIpcProof(ipcSecret, role, clientNonce, hostNonce) {
  if (typeof ipcSecret !== "string" || !SECRET_PATTERN.test(ipcSecret) || !["client", "host"].includes(role) ||
      !isIpcNonce(clientNonce) || !isIpcNonce(hostNonce)) {
    throw new Error("INVALID_IPC_AUTH");
  }
  return createHmac("sha256", Buffer.from(ipcSecret, "hex"))
    .update(`${PROOF_DOMAIN}${role}\0${IPC_PROTOCOL}\0${clientNonce}\0${hostNonce}`, "utf8")
    .digest("hex");
}

export function verifyIpcProof(expected, actual) {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual)) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function windowsPipeName(appSupportDir, sessionId) {
  if (typeof appSupportDir !== "string" || !appSupportDir || typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("INVALID_IPC_ENDPOINT");
  }
  const normalizedPath = appSupportDir.replaceAll("/", "\\").toLowerCase();
  const digest = createHash("sha256")
    .update(`weixin-channels-video\0windows-pipe\0v${IPC_PROTOCOL}\0${normalizedPath}\0${sessionId}`, "utf8")
    .digest("hex");
  return `${WINDOWS_PIPE_NAME_PREFIX}${digest.slice(0, 32)}`;
}

function readExactFrame(buffer, offset, length) {
  if (buffer.byteLength - offset - 4 < length) return null;
  return buffer.subarray(offset, offset + 4 + length);
}

function createWindowsTransportDecoder(onConnection, onFrame, onDisconnect, onFatal) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let offset = 0;
    while (buffered.length - offset >= 4) {
      const length = buffered.readUInt32LE(offset);
      if (length === 0) {
        onConnection();
        offset += 4;
        continue;
      }
      if (length === 0xffffffff) {
        onDisconnect();
        offset += 4;
        continue;
      }
      if (length > MAX_BRIDGE_MESSAGE_BYTES) {
        onFatal(new Error("WINDOWS_PIPE_PROTOCOL_ERROR"));
        return;
      }
      const frame = readExactFrame(buffered, offset, length);
      if (!frame) break;
      onFrame(Buffer.from(frame));
      offset += frame.length;
    }
    if (offset > 0) buffered = buffered.subarray(offset);
  };
}

export function createWindowsPipeServer(pipeName, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  onConnection = () => {},
  onFrame = () => {},
  onDisconnect = () => {},
  onFatal = () => {},
} = {}) {
  if (platform !== "win32" || typeof pipeName !== "string" ||
      !new RegExp(`^${WINDOWS_PIPE_NAME_PREFIX}[0-9a-f]{32}$`).test(pipeName)) {
    throw new Error("WINDOWS_PIPE_UNAVAILABLE");
  }
  const child = spawnImpl(windowsPowerShellPath(env), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_PIPE_COMMAND,
  ], {
    env: {
      ...Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
        .filter((key) => typeof env[key] === "string")
        .map((key) => [key, env[key]])),
      WCV_IPC_PIPE_NAME: pipeName,
    },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let startupReady = false;
  const ready = new Promise((resolve, reject) => {
    let stderrBuffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("WINDOWS_PIPE_START_TIMEOUT")), WINDOWS_PIPE_START_TIMEOUT_MS);
    timeout.unref?.();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      startupReady = !error;
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on("data", (chunk) => {
      stderrBuffer = (stderrBuffer + chunk.toString("utf8")).slice(-4096);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      if (lines.includes("READY")) finish();
    });
    child.once("error", () => finish(new Error("WINDOWS_PIPE_START_FAILED")));
    child.once("exit", () => finish(new Error("WINDOWS_PIPE_START_FAILED")));
  });
  const decode = createWindowsTransportDecoder(onConnection, onFrame, onDisconnect, onFatal);
  child.stdout.on("data", decode);
  child.stdout.on("error", () => onFatal(new Error("WINDOWS_PIPE_FAILED")));
  child.stdin.on("error", () => onFatal(new Error("WINDOWS_PIPE_FAILED")));
  let processClosed = child.exitCode !== null || child.signalCode !== null;
  let closing = false;
  let resolveProcessClosed;
  const processClosedPromise = new Promise((resolve) => { resolveProcessClosed = resolve; });
  if (processClosed) resolveProcessClosed();
  child.once("close", () => {
    processClosed = true;
    resolveProcessClosed();
    if (startupReady && !closing) onFatal(new Error("WINDOWS_PIPE_CLOSED"));
  });
  return {
    child,
    ready,
    write(frame) {
      if (child.exitCode !== null || child.killed) throw new Error("WINDOWS_PIPE_CLOSED");
      child.stdin.write(frame);
    },
    disconnect() {
      if (child.exitCode === null && !child.killed) child.stdin.write(Buffer.alloc(4));
    },
    async close() {
      if (processClosed) return;
      closing = true;
      if (!child.killed) child.kill();
      await processClosedPromise;
    },
  };
}
