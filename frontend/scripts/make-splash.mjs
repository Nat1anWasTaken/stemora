// Generates iOS launch screens (apple-touch-startup-image) into public/splash with ImageMagick (`convert`)
// and prints the <link> tags for index.html. The mark is the four stem bars from icons/icon.svg
// on the app background, so the installed app opens on its own colours instead of white.
import { execFileSync } from "node:child_process"
import { join } from "node:path"

const out = new URL("../public/splash/", import.meta.url).pathname
const BG = "#050a12" // --background
// [css width, css height, device pixel ratio]: current and recent iPhones, then iPads
const devices = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [414, 896, 3], [375, 812, 3], [414, 896, 2], [375, 667, 2], [320, 568, 2],
  [1032, 1376, 2], [834, 1210, 2], [1024, 1366, 2], [834, 1194, 2], [820, 1180, 2], [768, 1024, 2],
]
const links = []
for (const [w, h, dpr] of devices) {
  const pw = w * dpr
  const ph = h * dpr
  const size = Math.round(Math.min(pw, ph) * 0.28) // mark box, in px
  const s = size / 512
  const x0 = (pw - size) / 2
  const y0 = (ph - size) / 2
  const r = 26 * s
  const bar = (x, y, bh, fill) => ["-fill", fill, "-draw", `roundrectangle ${x0 + x * s},${y0 + y * s} ${x0 + (x + 52) * s},${y0 + (y + bh) * s} ${r},${r}`]
  const name = `splash-${pw}x${ph}.png`
  execFileSync("convert", [
    "-size", `${pw}x${ph}`, `xc:${BG}`,
    ...bar(108, 206, 150, "#f2849a"), ...bar(176, 120, 272, "#f4b645"), ...bar(244, 176, 200, "#b98af0"), ...bar(312, 150, 236, "#52c9d6"),
    "-strip", "-define", "png:compression-level=9", join(out, name),
  ])
  links.push(`<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="/splash/${name}" />`)
}
console.log(links.join("\n"))
