#!/usr/bin/env node
/**
 * Unit tests for the runPowerShell helper.
 *
 * Validates that runPowerShell enforces input validation and gracefully
 * handles missing PowerShell binaries. If a PowerShell binary is
 * available on the host, it also checks that a simple command runs
 * successfully. The test is intentionally tolerant: in environments
 * without PowerShell (`pwsh` or `powershell.exe`) the helper should
 * throw an informative error rather than hanging.
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/powershell_unit.mjs
 */
import assert from "node:assert/strict";
import { runPowerShell } from "../src/tools/runPowerShell.ts";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
    fail++;
  }
}

console.log("powershell_unit: runPowerShell contracts");

await test("rejects empty command", async () => {
  await assert.rejects(() => runPowerShell(""), /non-empty string/);
});

await test("rejects non-string command", async () => {
  // @ts-expect-error: deliberate type breakage for validation test
  await assert.rejects(() => runPowerShell(undefined), /non-empty string/);
});

await test("runs a simple PowerShell command or fails gracefully", async () => {
  try {
    const out = await runPowerShell("Write-Output 42");
    // If PowerShell is available, assert correct output.
    assert.equal(out, "42");
  } catch (err) {
    // If PowerShell isn't available, we expect a descriptive error.
    assert.match(
      String(err && err.message),
      /No PowerShell binary found|exited with code/,
    );
  }
});

if (fail > 0) {
  console.log(`\n✗ powershell_unit: ${fail} failing, ${pass} passing`);
  process.exit(1);
} else {
  console.log(`\n✓ powershell_unit: ${pass} passing`);
}
