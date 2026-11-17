#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const bundlePath = path.join(repoRoot, "main.bundle.js");
const bundle = fs.readFileSync(bundlePath, "utf8");

const tests = [];

function addTest(name, fn) {
  tests.push({ name, fn });
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listTrackFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".track"))
    .map((entry) => entry.name);
}

addTest("Required 0.6.3 build artifacts exist", () => {
  [
    "index.html",
    "main.bundle.js",
    "error_screen.bundle.js",
    "simulation_worker.bundle.js",
    "polytrack_physics.wasm",
    "lib/polytrack_physics.js"
  ].forEach((file) => {
    ensure(fs.existsSync(path.join(repoRoot, file)), `Expected ${file} to exist`);
  });
  const wasm = fs.readFileSync(path.join(repoRoot, "polytrack_physics.wasm"));
  ensure(wasm.slice(0, 4).toString("binary") === "\0asm", "polytrack_physics.wasm is not wasm");
});

addTest("Official and community track directories contain 0.6.3 tracks", () => {
  const officialDir = path.join(repoRoot, "tracks", "official");
  const communityDir = path.join(repoRoot, "tracks", "community");
  [officialDir, communityDir].forEach((dir) => {
    ensure(fs.existsSync(dir), `Missing directory: ${dir}`);
  });
  const officialTracks = listTrackFiles(officialDir);
  const communityTracks = listTrackFiles(communityDir);
  ["summer1.track", "desert5.track", "winter5.track"].forEach((name) => {
    ensure(officialTracks.includes(name), `tracks/official is missing ${name}`);
  });
  ensure(communityTracks.length > 0, "tracks/community must contain at least one .track file");
});

addTest("Client is PolyTrack 0.6.3", () => {
  const index = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const worker = fs.readFileSync(path.join(repoRoot, "simulation_worker.bundle.js"), "utf8");
  const manifest = fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8");
  const physics = fs.readFileSync(path.join(repoRoot, "lib/polytrack_physics.js"), "utf8");
  ensure(index.includes("<title>PolyTrack</title>"), "Page title should be PolyTrack");
  ensure(!index.includes("car_damage.js"), "0.6.3 page should not load car_damage.js");
  ensure(!index.includes("car_sparks.js") && !index.includes("car_smoke.js"), "Sparks and smoke scripts should stay unloaded");
  ensure(index.includes("main.bundle.js"), "Page should load main.bundle.js");
  ensure(bundle.includes('version:"0.6.3"'), "Main bundle should start the 0.6.3 simulation");
  ensure(worker.includes('if("0.6.3"!=i)'), "Worker should reject any version other than 0.6.3");
  ensure(manifest.includes('"name": "PolyTrack"'), "Manifest name should be PolyTrack");
  ensure(physics.includes("polytrack_physics.wasm"), "Physics loader should fetch polytrack_physics.wasm");
  const wasm = fs.readFileSync(path.join(repoRoot, "polytrack_physics.wasm"));
  const soft = Buffer.from("43000048434300004041", "hex");
  const softStop = Buffer.from("430000a0424300004041", "hex");
  const tallOnly = Buffer.from("43000048434300001042", "hex");
  const tooLow = Buffer.from("43000048434300002041", "hex");
  const stock = Buffer.from([0x43, 0x00, 0x00, 0x48, 0x42]);
  const preload = Buffer.from("43000000409220032a028c0294", "hex");
  const damp = Buffer.from("428080808a848080c8c100", "hex");
  const rebound = Buffer.from("4280808082848080a0c000", "hex");
  const unloadRebound = Buffer.from("4280808088848080a0c000", "hex");
  const stop = Buffer.from("43ae4761be5d1b", "hex");
  const lowStop = Buffer.from("430ad7a3be5d1b", "hex");
  const deepStop = Buffer.from("43b81e85be5d1b", "hex");
  ensure(wasm.includes(soft), "Ride rate should stay 12 and the bump stop should stay at 200");
  ensure(!wasm.includes(softStop), "A stop stiffness of 80 lets the body catch and spin the car");
  ensure(wasm.includes(preload), "A preload of 2 should hold the tall ride at the softer rate");
  ensure(wasm.includes(damp), "Compression damping should be 18 with the rate 12 spring");
  ensure(wasm.includes(rebound), "Rebound damping should be 3 so a landing settles without unloading a tire");
  ensure(!wasm.includes(unloadRebound), "Rebound damping 8 unloads a tire on a small bump and spins the car");
  ensure(!wasm.includes(tallOnly), "Stiffness 36 without preload is too stiff to follow an incline");
  ensure(!wasm.includes(tooLow), "Stiffness 10 without preload lets the car creep down onto the road");
  ensure(!wasm.includes(stock), "Stock suspension stiffness 50 should be gone");
  ensure(wasm.includes(stop), "Bump stop should engage below length -0.22, just before a landing can plant the body");
  ensure(!wasm.includes(deepStop), "The stop at length -0.26 lets the nose and tail reach the road");
  ensure(!wasm.includes(lowStop), "The stop at length -0.32 is below the body and should be gone");
  const pitch = Buffer.from("4300004040942101", "hex");
  ensure(wasm.includes(pitch), "Drive force should act below the car so it pitches under throttle and brake");
  const lean = Buffer.from("42808080fc838089bac900", "hex");
  const fakeRoll = Buffer.from("428080c084848089bac900", "hex");
  const stockRoll = Buffer.from("42808080f8838089bac900", "hex");
  ensure(wasm.includes(lean), "Roll influence should be 1 so lean comes from the tires");
  ensure(!wasm.includes(fakeRoll), "Exaggerated roll influence 4.5 should be gone");
  ensure(!wasm.includes(stockRoll), "Stock roll influence 0.5 should be gone");
});

(async () => {
  let passed = 0;
  for (const test of tests) {
    try {
      await test.fn();
      console.log(`✔ ${test.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✘ ${test.name}`);
      console.error(err.message || err);
      process.exitCode = 1;
      break;
    }
  }
  if (passed === tests.length) {
    console.log(`\nAll ${passed} tests passed.`);
  } else {
    console.log(`\n${passed} of ${tests.length} tests passed.`);
  }
})();
