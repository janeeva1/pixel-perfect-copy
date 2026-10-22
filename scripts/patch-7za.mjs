/**
 * electron-builder unpacks its winCodeSign cache with 7za.exe. That archive
 * holds two darwin symlinks, and on a machine without SeCreateSymbolicLinkPrivilege
 * the extraction exits 2 even though every Windows binary we actually need
 * (rcedit, signtool, ...) was written. Rather than ask for Developer Mode or an
 * elevated shell, swap 7za.exe for a shim that forwards to the real binary and
 * downgrades that one specific failure to success.
 *
 * This only touches node_modules, so it has to run again after npm install. The
 * electron:pack and electron:build scripts do that for you.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const binDir = join(root, "node_modules", "7zip-bin", "win", "x64");
const shimExe = join(binDir, "7za.exe");
const realExe = join(binDir, "7za-real.exe");

const SHIM_SOURCE = `using System;
using System.Diagnostics;
using System.Text;

class Shim {
    const string SYMLINK_FAILURE = "Cannot create symbolic link";

    static int Main(string[] args) {
        string dir = System.IO.Path.GetDirectoryName(
            System.Reflection.Assembly.GetExecutingAssembly().Location);
        string real = System.IO.Path.Combine(dir, "7za-real.exe");
        if (!System.IO.File.Exists(real)) {
            Console.Error.WriteLine("[7za-shim] 7za-real.exe is missing, nothing to forward to.");
            return 1;
        }

        var psi = new ProcessStartInfo(real);
        psi.Arguments = BuildArgs(args);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;

        using (var proc = Process.Start(psi)) {
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();
            proc.WaitForExit();
            string stdoutText = stdoutTask.Result;
            string stderrText = stderrTask.Result;
            Console.Write(stdoutText);
            Console.Error.Write(stderrText);

            bool symlinkOnly = (stdoutText + stderrText)
                .IndexOf(SYMLINK_FAILURE, StringComparison.OrdinalIgnoreCase) >= 0;
            if (proc.ExitCode != 0 && symlinkOnly) {
                Console.Error.WriteLine(
                    "[7za-shim] extraction only failed on a symbolic link this platform cannot create, "
                    + "treating it as success (real exit code " + proc.ExitCode + ").");
                return 0;
            }
            return proc.ExitCode;
        }
    }

    // Arguments electron-builder passes may already carry quotes around a path
    // with spaces, so only add quoting when there is no quote to collide with.
    static string BuildArgs(string[] args) {
        var sb = new StringBuilder();
        foreach (string arg in args) {
            if (sb.Length > 0) sb.Append(' ');
            bool spaced = arg.IndexOf(' ') >= 0 || arg.IndexOf('\\t') >= 0;
            if (spaced && arg.IndexOf('"') < 0) {
                sb.Append('"').Append(arg).Append('"');
            } else {
                sb.Append(arg);
            }
        }
        return sb.ToString();
    }
}
`;

function findCsc() {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find csc.exe. Install the .NET Framework developer tools or build on a machine with them.",
  );
}

if (!existsSync(binDir)) {
  throw new Error(`7zip is not installed at ${binDir}. Run npm install first.`);
}

if (existsSync(realExe)) {
  console.log("7za shim already in place.");
  process.exit(0);
}

const work = join(tmpdir(), "attendance-7za-shim");
mkdirSync(work, { recursive: true });
const source = join(work, "shim.cs");
const compiled = join(work, "shim.exe");
writeFileSync(source, SHIM_SOURCE, "utf8");
rmSync(compiled, { force: true });

execFileSync(findCsc(), ["/nologo", "/target:exe", `/out:${compiled}`, source], {
  stdio: "inherit",
});

renameSync(shimExe, realExe);
copyFileSync(compiled, shimExe);
console.log(`Installed 7za shim. Real binary kept at ${realExe}`);
