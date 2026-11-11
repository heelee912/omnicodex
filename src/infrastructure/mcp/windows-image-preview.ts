import { join } from "node:path";
import { HiddenChildProcessBoundary } from "../windows/hidden-child-process.js";

export interface WindowsImagePreview {
  readonly data: string;
  readonly mimeType: "image/jpeg";
}

const POWERSHELL_PREVIEW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$imageStream = [System.IO.MemoryStream]::new()
[Console]::OpenStandardInput().CopyTo($imageStream)
$imageStream.Position = 0
$prefixLength = [Math]::Min(8, [int]$imageStream.Length)
if ($prefixLength -eq 0) { throw 'Image input was empty' }
$prefix = [BitConverter]::ToString($imageStream.ToArray(), 0, $prefixLength)
try {
  $image = [System.Drawing.Image]::FromStream($imageStream)
} catch {
  throw "Image decode failed length=$($imageStream.Length) prefix=$prefix $($_.Exception.Message)"
}
try {
  $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' } |
    Select-Object -First 1
  if ($null -eq $encoder) { throw 'JPEG encoder unavailable' }
  $result = $null
  foreach ($maximum in @(1600, 1280, 1024, 768)) {
    $scale = [Math]::Min(1.0, $maximum / [double][Math]::Max($image.Width, $image.Height))
    $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($image, 0, 0, $width, $height)
      } finally {
        $graphics.Dispose()
      }
      $parameters = [System.Drawing.Imaging.EncoderParameters]::new(1)
      try {
        $quality = [System.Drawing.Imaging.EncoderParameter]::new(
          [System.Drawing.Imaging.Encoder]::Quality,
          [long]82
        )
        $parameters.Param[0] = $quality
        $output = [System.IO.MemoryStream]::new()
        try {
          $bitmap.Save($output, $encoder, $parameters)
          $candidate = $output.ToArray()
        } finally {
          $output.Dispose()
          $quality.Dispose()
        }
      } finally {
        $parameters.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
    $result = $candidate
    if ($candidate.Length -le 458752) { break }
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} finally {
  $image.Dispose()
  $imageStream.Dispose()
}
`;

/**
 * Produces a bounded visual input for MCP/SSE transport while the caller keeps
 * the exact original bytes in its owner-bound result resource. The helper is
 * intentionally fileless and every child-process surface is hidden.
 */
export async function createWindowsImagePreview(data: string): Promise<WindowsImagePreview> {
  if (process.platform !== "win32") throw new Error("WINDOWS_IMAGE_PREVIEW_UNAVAILABLE");
  const systemRoot = process.env.SystemRoot?.trim();
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error("WINDOWS_IMAGE_PREVIEW_SYSTEM_ROOT_UNAVAILABLE");
  }
  const bytes = Buffer.from(data.replaceAll(/[\t\n\f\r ]/g, ""), "base64");
  const childProcesses = new HiddenChildProcessBoundary();
  return await new Promise<WindowsImagePreview>((resolve, reject) => {
    const child = childProcesses.spawnHidden(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        POWERSHELL_PREVIEW_SCRIPT,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      reject(new Error("WINDOWS_IMAGE_PREVIEW_PIPE_UNAVAILABLE"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `WINDOWS_IMAGE_PREVIEW_FAILED code=${code ?? "null"} ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      const preview = Buffer.concat(stdout).toString("ascii").trim();
      if (preview.length === 0) {
        reject(new Error("WINDOWS_IMAGE_PREVIEW_EMPTY"));
        return;
      }
      resolve({ data: preview, mimeType: "image/jpeg" });
    });
    child.stdin.end(bytes);
  });
}
