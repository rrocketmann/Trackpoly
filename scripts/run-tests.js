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
  const soft = Buffer.from([0x43, 0x00, 0x00, 0x40, 0x41]);
  const stock = Buffer.from([0x43, 0x00, 0x00, 0x48, 0x42]);
  ensure(wasm.includes(soft), "Suspension stiffness should be the soft rate 12");
  ensure(!wasm.includes(stock), "Stock suspension stiffness 50 should be gone");
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
