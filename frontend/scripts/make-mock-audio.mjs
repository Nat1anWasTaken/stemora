// Generates 4 distinct 20s stem loops (AAC .m4a) + peaks.json into public/mock using ffmpeg lavfi.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const out = new URL("../public/mock/", import.meta.url).pathname
const D = 20
// 120 bpm => beat = 0.5s
const stems = {
  vocals:
    "aevalsrc='0.35*sin(2*PI*t*(440+110*floor(mod(t*2,4)))*(1+0.004*sin(2*PI*5*t)))*(0.6+0.4*sin(2*PI*t*0.5))|0.35*sin(2*PI*t*(440+110*floor(mod(t*2,4)))*(1+0.004*sin(2*PI*5*t)))*(0.6+0.4*sin(2*PI*t*0.5))':s=44100",
  drums:
    "aevalsrc='0.9*sin(2*PI*(60+120*exp(-mod(t,1)*30))*t)*exp(-mod(t,1)*9)+0.25*(random(0)*2-1)*exp(-mod(t+0.5,1)*25)+0.12*(random(1)*2-1)*exp(-mod(t,0.25)*60)|0.9*sin(2*PI*(60+120*exp(-mod(t,1)*30))*t)*exp(-mod(t,1)*9)+0.25*(random(0)*2-1)*exp(-mod(t+0.5,1)*25)+0.12*(random(1)*2-1)*exp(-mod(t,0.25)*60)':s=44100",
  bass: "aevalsrc='0.6*sin(2*PI*t*(55+18*floor(mod(t,4))))*(0.7+0.3*sin(2*PI*t*2))|0.6*sin(2*PI*t*(55+18*floor(mod(t,4))))*(0.7+0.3*sin(2*PI*t*2))':s=44100",
  other:
    "aevalsrc='0.12*(sin(2*PI*261.6*t)+sin(2*PI*329.6*t)+sin(2*PI*392*t))*(0.5+0.5*sin(2*PI*t*0.25))|0.12*(sin(2*PI*293.7*t)+sin(2*PI*370*t)+sin(2*PI*440*t))*(0.5+0.5*sin(2*PI*t*0.25))':s=44100",
}
const peaks = { version: 1, samples_per_second: 20, stems: {} }
for (const [name, expr] of Object.entries(stems)) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", expr, "-t", String(D), "-c:a", "aac", "-b:a", "96k", `${out}${name}.m4a`])
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", `${out}${name}.m4a`, "-f", "f32le", "-ac", "1", "-ar", "44100", "-"], { maxBuffer: 1 << 28 })
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const per = 44100 / 20
  const arr = []
  for (let i = 0; i + per <= f.length + per - 1; i += per) {
    let m = 0
    for (let j = i; j < Math.min(i + per, f.length); j++) m = Math.max(m, Math.abs(f[j]))
    arr.push(Math.round(Math.min(1, m) * 1000) / 1000)
  }
  peaks.stems[name] = arr
}
writeFileSync(`${out}peaks.json`, JSON.stringify(peaks))
