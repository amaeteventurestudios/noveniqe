// How many Agent Grand Prix races one CPU core can run on the server at real time.
// Runs the game's own race engine (no copy of it here): point it at the game's js/ folder.
//
//   node ops/bench/race-bench.mjs <path to agent-grand-prix js/> [--seconds 20] [--races 40] [--json out.json]
//
// It measures (1) whole races run flat out, (2) many races stepped side by side, as a race server would, and
// (3) the memory each live race holds. One engine step is 0.05 s of race time, so a race at real time needs 20
// steps a second. Prints a short Markdown report (for a GitHub job summary) and, with --json, the raw numbers.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : d; };
const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!dir) { console.error('usage: node race-bench.mjs <agent-grand-prix js dir> [--seconds 20] [--races 40] [--json out.json]'); process.exit(2); }
const SECONDS = Number(opt('seconds', 20)), RACES = Number(opt('races', 40)), JSON_OUT = opt('json', '');
const url = (f) => pathToFileURL(resolve(dir, f)).href;
const { VENUES } = await import(url('data.js'));
const { setupRace } = await import(url('game.js'));
const { DT } = await import(url('sim.js'));

const ms = () => Number(process.hrtime.bigint()) / 1e6;
const newRace = (i) => { const s = setupRace({ venue: VENUES[i % VENUES.length], seed: 1000 + i, auto: true }); const R = s.make(); R.start(); return R; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// warm the engine up (track generation is cached per circuit, JIT settles)
for (let i = 0; i < 3; i++) { const R = newRace(i); for (let k = 0; k < 2000 && !R.done; k++) R.step(); }

// 1. whole races, flat out
const whole = [];
for (let i = 0; i < 6; i++) {
  const t0 = ms(), R = newRace(i); let n = 0;
  while (!R.done && n < 400000) { R.step(); n++; }
  whole.push({ venue: VENUES[i % VENUES.length].id, steps: n, ms: ms() - t0, raceSeconds: n * DT });
}
const msPerStepWhole = median(whole.map((w) => w.ms / w.steps));

// 2. many races side by side, round robin, as a server tick would step them
const live = Array.from({ length: RACES }, (_, i) => newRace(i));
let stepped = 0; const t0 = ms(); const until = t0 + SECONDS * 1000;
while (ms() < until) {
  for (let i = 0; i < live.length; i++) {
    if (live[i].done) live[i] = newRace(i + RACES * (stepped + 1));
    live[i].step(); stepped++;
  }
}
const msPerStepMixed = (ms() - t0) / stepped;

// 3. memory per live race
global.gc?.();
const before = process.memoryUsage().heapUsed;
const held = Array.from({ length: 50 }, (_, i) => { const R = newRace(i); for (let k = 0; k < 600; k++) R.step(); return R; });
global.gc?.();
const mbPerRace = (process.memoryUsage().heapUsed - before) / 50 / 1048576;

const stepsPerRealSecond = 1 / DT;
const coreShareOneRace = (msPerStepMixed * stepsPerRealSecond) / 1000;     // share of one core one real-time race needs
const racesPerCore = Math.floor(1 / coreShareOneRace);
const safePerCore = Math.floor(racesPerCore * 0.5);                         // keep half the core for everything else
const out = {
  at: new Date().toISOString(), host: os.hostname(), cpu: os.cpus()[0]?.model || 'unknown', cores: os.cpus().length, arch: process.arch,
  node: process.version, totalMemGB: +(os.totalmem() / 1073741824).toFixed(1), raceSecondsPerStep: DT,
  wholeRaces: whole.map((w) => ({ ...w, ms: +w.ms.toFixed(1) })), msPerStepWhole: +msPerStepWhole.toFixed(4),
  sideBySide: { races: RACES, seconds: SECONDS, steps: stepped }, msPerStepMixed: +msPerStepMixed.toFixed(4),
  coreShareOneRace: +coreShareOneRace.toFixed(5), racesPerCore, safeRacesPerCore: safePerCore, mbPerLiveRace: +mbPerRace.toFixed(2),
  gcExposed: typeof global.gc === 'function', heldRaces: held.length,
};
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log(`### Race engine capacity: ${out.host} (${out.arch}, ${out.cores} cores, ${out.node})

| Measure | Result |
| --- | --- |
| One engine step (whole races, median of ${whole.length}) | ${out.msPerStepWhole} ms |
| One engine step (${RACES} races side by side, ${SECONDS} s) | ${out.msPerStepMixed} ms |
| One real-time race uses | ${(coreShareOneRace * 100).toFixed(2)}% of one core |
| Real-time races one core can run | ${racesPerCore} (plan for ${safePerCore}, half the core kept free) |
| A whole race run flat out | ${(median(whole.map((w) => w.ms)) / 1000).toFixed(2)} s |
| Memory per live race | ${out.mbPerLiveRace} MB${out.gcExposed ? '' : ' (rough: run node with --expose-gc for a cleaner number)'} |
`);
