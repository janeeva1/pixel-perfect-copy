/**
 * Build the application icon from bmx.png.
 *
 * Windows wants a real .ico for the executable, the NSIS installer and the taskbar
 * shortcut, and a .png is not enough. This downsamples the logo to the sizes
 * Windows actually asks for, then writes a single .ico holding every one of them
 * as an embedded PNG (supported since Vista, and it keeps the alpha channel).
 *
 * The same logo is copied into public/ so the web UI can show it.
 *
 *   node scripts/make-icon.mjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(root, "bmx.png");
const publicDir = join(root, "public");
const sizes = [16, 24, 32, 48, 64, 128, 256];

if (!existsSync(source)) {
  throw new Error(`Logo not found at ${source}. Drop bmx.png in the project root.`);
}

/** Shell out to System.Drawing to resample, keeping the alpha channel intact. */
function renderSizes(outDir) {
  mkdirSync(outDir, { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:BMX_SRC)
foreach ($size in ($env:BMX_SIZES -split ',')) {
  $n = [int]$size
  $bmp = New-Object System.Drawing.Bitmap($n, $n, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $n, $n)
  $bmp.Save((Join-Path $env:BMX_OUT "$n.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}
$src.Dispose()
`;
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      stdio: "inherit",
      env: { ...process.env, BMX_SRC: source, BMX_OUT: outDir, BMX_SIZES: sizes.join(",") },
    },
  );
}

/** ICONDIR + one ICONDIRENTRY per size, each pointing at an embedded PNG. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    const dim = entry.size >= 256 ? 0 : entry.size; // 0 means 256 in the ICO format
    directory.writeUInt8(dim, at);
    directory.writeUInt8(dim, at + 1);
    directory.writeUInt8(0, at + 2); // palette size, unused for 32-bit
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

const work = join(tmpdir(), "attendance-icon");
rmSync(work, { recursive: true, force: true });
renderSizes(work);

const entries = sizes.map((size) => ({ size, data: readFileSync(join(work, `${size}.png`)) }));
const ico = buildIco(entries);

mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "icon.ico"), ico);
writeFileSync(join(publicDir, "favicon.ico"), ico);
copyFileSync(source, join(publicDir, "bmx.png"));

console.log(
  `Wrote public/icon.ico and public/favicon.ico (${ico.length} bytes, ${sizes.join("/")}).`,
);
console.log("Copied the logo to public/bmx.png for the web UI.");
