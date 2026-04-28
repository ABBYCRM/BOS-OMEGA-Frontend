import { spawn } from "child_process";

/**
 * Execute a PowerShell command in a bounded child process.
 *
 * This helper attempts to locate a usable PowerShell binary on the host
 * machine. It prefers `pwsh` (cross-platform PowerShell Core) and falls
 * back to `powershell.exe` (Windows PowerShell) when available. If
 * neither is on PATH, an error is thrown immediately.
 *
 * The command is executed with a default timeout of 30 seconds and a
 * maximum output buffer of 1 MB. These limits guard against runaway
 * processes, infinite loops and unbounded output that could degrade the
 * API server. On timeout the child is SIGTERM'd and the promise rejects
 * with a descriptive error.
 *
 * NOTE: Input shell-escaping is the *caller's* responsibility — the
 * command string is passed verbatim to PowerShell's `-Command` argument.
 * The HTTP route that wraps this helper enforces super_admin auth, an
 * audit trail, an env-flag opt-in, and a body-size cap (see
 * routes/powershell.ts) to keep the surface area appropriate.
 *
 * @param command PowerShell command string to execute
 * @returns Trimmed stdout from the PowerShell session
 */
export async function runPowerShell(command: string): Promise<string> {
  if (!command || typeof command !== "string") {
    throw new Error("runPowerShell: command must be a non-empty string");
  }

  // Probe order: prefer pwsh on Linux/macOS, powershell.exe on Windows.
  const candidates =
    process.platform === "win32"
      ? ["powershell.exe", "pwsh"]
      : ["pwsh", "powershell.exe"];

  let psBinary: string | null = null;
  for (const bin of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, ["-Command", "echo test"], { timeout: 5000 });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`probe exit ${code}`));
        });
      });
      psBinary = bin;
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!psBinary) {
    throw new Error(
      "No PowerShell binary found. Install PowerShell Core (`pwsh`) or ensure powershell.exe is on PATH.",
    );
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(psBinary as string, ["-Command", command], {
      timeout: 30_000,
    });
    let output = "";
    let bytes = 0; // combined stdout+stderr
    const MAX = 1 * 1024 * 1024; // 1 MB combined cap
    let killedFor: "timeout" | "overflow" | null = null;
    let killEscalation: NodeJS.Timeout | null = null;

    // SIGTERM first, escalate to SIGKILL after a short grace period if
    // the child ignores the signal. Without this, a `while ($true) {}`
    // PowerShell loop could hold the worker open well past the timeout.
    const terminate = (reason: "timeout" | "overflow") => {
      if (killedFor) return;
      killedFor = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      killEscalation = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, 1_500).unref();
    };

    const onChunk = (target: "out" | "err") => (data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX) {
        terminate("overflow");
        return;
      }
      // We only retain stdout for the success path. stderr is observed
      // for size accounting but intentionally NOT buffered, so failing
      // commands cannot exfiltrate large secrets back through the
      // promise-rejection path or into audit metadata.
      if (target === "out") output += data.toString();
    };
    child.stdout.on("data", onChunk("out"));
    child.stderr.on("data", onChunk("err"));
    child.on("error", (err) => {
      if (killEscalation) clearTimeout(killEscalation);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (killEscalation) clearTimeout(killEscalation);
      if (killedFor === "overflow") {
        reject(new Error("PowerShell output exceeded 1 MB cap"));
        return;
      }
      if (killedFor === "timeout" || signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error("PowerShell command timed out after 30 seconds"));
        return;
      }
      if (code !== 0) {
        // Do NOT include captured stdout/stderr in the rejection
        // message — failing scripts can produce arbitrary output that
        // routes/powershell.ts would otherwise persist into the audit
        // chain. Surface only the exit code; full output stays
        // ephemeral inside this process for the success path.
        reject(new Error(`PowerShell exited with code ${code}`));
        return;
      }
      resolve(output.trim());
    });
  });
}
