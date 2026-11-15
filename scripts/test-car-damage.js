#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const damage = require("../car_damage.js");

const root = path.resolve(__dirname, "..");
let failed = 0;

function ensure(condition, message) {
    if (!condition) {
        failed += 1;
        console.error("FAIL:", message);
    }
}

function loadGlb(file) {
    const buf = fs.readFileSync(file);
    const jsonLength = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.slice(20, 20 + jsonLength).toString("utf8"));
    const binStart = 20 + jsonLength + 8;
    const view = new DataView(buf.buffer, buf.byteOffset + binStart, buf.length - binStart);
    const typeCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const component = {
        5120: [1, "getInt8"],
        5121: [1, "getUint8"],
        5122: [2, "getInt16"],
        5123: [2, "getUint16"],
        5125: [4, "getUint32"],
        5126: [4, "getFloat32"]
    };

    function accessor(index) {
        const acc = gltf.accessors[index];
        const bufferView = gltf.bufferViews[acc.bufferView];
        const start = (bufferView.byteOffset || 0) + (acc.byteOffset || 0);
        const [size, method] = component[acc.componentType];
        const comps = typeCount[acc.type];
        const stride = bufferView.byteStride || size * comps;
        const out = new Float32Array(acc.count * comps);
        for (let i = 0; i < acc.count; i++) {
            for (let c = 0; c < comps; c++)
                out[i * comps + c] = view[method](start + i * stride + c * size, true);
        }
        return out;
    }

    return { gltf: gltf, accessor: accessor };
}

function bodyPositions(parsed) {
    const mesh = parsed.gltf.meshes[0];
    const parts = mesh.primitives.map((prim) => parsed.accessor(prim.attributes.POSITION));
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Float32Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function suspensionPositions(parsed) {
    const attr = parsed.accessor(parsed.gltf.meshes[3].primitives[0].attributes.POSITION);
    const points = [];
    for (let i = 0; i < attr.length; i += 3)
        points.push([attr[i], attr[i + 1], attr[i + 2]]);
    return points;
}

function buildCar() {
    const parsed = loadGlb(path.join(root, "models", "car.glb"));
    const positions = bodyPositions(parsed);
    return damage.createDamageModel(positions, suspensionPositions(parsed));
}

function snapshot(model) {
    return new Float32Array(model.pos);
}

function maxMove(before, model, predicate) {
    let max = 0;
    let count = 0;
    for (let v = 0; v < model.count; v++) {
        if (!predicate(v))
            continue;
        const i = v * 3;
        const dist = Math.hypot(model.pos[i] - before[i], model.pos[i + 1] - before[i + 1], model.pos[i + 2] - before[i + 2]);
        if (dist > max)
            max = dist;
        if (dist > 1e-5)
            count += 1;
    }
    return { max: max, count: count };
}

function sectionNames(model, vertex) {
    const id = model.sectionOf[vertex];
    return id < 0 ? "drivebase" : model.sections[id].name;
}

function hit(model, contact, steps) {
    for (let i = 0; i < steps; i++)
        damage.applyContacts(model, [contact]);
}

function insideSpine(x, y, z) {
    const gap = damage.SPINE_GAP;
    const box = damage.SPINE;
    return x > box.minX - gap && x < box.maxX + gap && y > box.minY - gap && y < box.maxY + gap && z > box.minZ - gap && z < box.maxZ + gap;
}

function wheelPenetration(x, y, z) {
    for (const wheel of damage.WHEELS) {
        const dist = Math.hypot(x - wheel.x, y - wheel.y, z - wheel.z);
        if (dist < wheel.r - 1e-3)
            return wheel;
    }
    return null;
}

const bundle = fs.readFileSync(path.join(root, "main.bundle.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "simulation_worker.bundle.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
ensure(html.includes('src="./car_damage.js"'), "index.html should load car_damage.js");
ensure(!html.includes("car_sparks.js"), "page should not load sparks");
ensure(!html.includes("car_smoke.js"), "page should not load smoke");
ensure(bundle.includes("window.TrackpolyDamage.apply"), "visual car should apply body damage");
ensure(!bundle.includes("trackpolySyncSparks") && !bundle.includes("trackpolyDropSparks"), "the visual car should not draw sparks");
ensure(!bundle.includes("trackpolySyncSmoke") && !bundle.includes("trackpolyDropSmoke"), "the visual car should not draw smoke");
ensure(worker.includes("collisionContacts: r._trackpolyImpulses.contacts"), "worker should send contact position and force");
ensure(worker.includes("getPositionWorldOnA"), "worker should read the contact point");
ensure(worker.includes("3 + 482 * comp * comp"), "spring rate should rise with compression");
ensure(worker.includes("sign = carIs0 ? 1 : -1"), "a hit should push the shell inward");
ensure(worker.includes("m_suspensionLength > .12"), "airborne wheels should stop at the original droop");
ensure(!/for \(const e of t\)\s*Gw\(this, Dv, "m", Uw\)\.call\(this, e\)/.test(bundle) || bundle.includes("collisionImpulses"), "collision sound still reads impulses");

const model = buildCar();
const sections = damage.describe(model);
let drivebaseCount = 0;
for (let v = 0; v < model.count; v++)
    if (model.sectionOf[v] < 0)
        drivebaseCount += 1;
console.log("body verts", model.count, "drivebase", drivebaseCount, "sections", sections.length);
for (const section of sections)
    console.log(" ", section.verts.toString().padStart(4), section.name.padEnd(22), "center", section.center.join(","), "size", section.size.join(","));

ensure(drivebaseCount > 15, "drivebase should keep the center rails");
ensure(sections.length >= 8 && sections.length <= 48, "body should be split into a handful of panels, got " + sections.length);
ensure(sections.every((section) => section.verts >= 1), "empty section");
const assigned = sections.reduce((sum, section) => sum + section.verts, 0);
ensure(assigned + drivebaseCount === model.count, "every vertex is drivebase or a panel");

const nose = { impulse: 2500, x: 0.05, y: 0.05, z: 1.62, nx: 0, ny: 0, nz: -1 };
const beforeNose = snapshot(model);
hit(model, nose, 8);
const noseMove = maxMove(beforeNose, model, (v) => model.rest[v * 3 + 2] > 1.15 && model.sectionOf[v] >= 0);
const tailMove = maxMove(beforeNose, model, (v) => model.rest[v * 3 + 2] < -1.5);
const driveMove = maxMove(beforeNose, model, (v) => model.sectionOf[v] < 0);
console.log("nose hit: nose", noseMove, "tail", tailMove, "drivebase", driveMove);
ensure(noseMove.max > 0.04 && noseMove.max <= damage.MAX_TRAVEL + 0.02, "nose should dent, moved " + noseMove.max);
ensure(noseMove.count > 4, "a nose hit should crease a patch, not a single vertex");
ensure(tailMove.max < 1e-5, "a nose hit should leave the tail");
ensure(driveMove.max < 1e-6, "drivebase rails should not move");

let noseIn = false;
let noseFlew = false;
for (let v = 0; v < model.count; v++) {
    if (model.sectionOf[v] < 0 || model.rest[v * 3 + 2] < 1.2)
        continue;
    const dz = model.pos[v * 3 + 2] - model.rest[v * 3 + 2];
    if (dz < -0.03)
        noseIn = true;
    if (dz > 0.05)
        noseFlew = true;
}
ensure(noseIn, "nose vertices should crush back along the hit");
ensure(!noseFlew, "nose vertices should stay on the car");

const tailHit = { impulse: 2500, x: 0.05, y: -0.05, z: -1.85, nx: 0, ny: 0, nz: 1 };
const tailModel = buildCar();
const beforeTail = snapshot(tailModel);
hit(tailModel, tailHit, 8);
const tailCrush = maxMove(beforeTail, tailModel, (v) => tailModel.rest[v * 3 + 2] < -1.55 && tailModel.sectionOf[v] >= 0);
const noseFromTail = maxMove(beforeTail, tailModel, (v) => tailModel.rest[v * 3 + 2] > 1.15 && tailModel.sectionOf[v] >= 0);
console.log("tail hit", tailCrush, "nose", noseFromTail);
let tailIn = false;
let tailLonger = false;
for (let v = 0; v < tailModel.count; v++) {
    if (tailModel.sectionOf[v] < 0 || tailModel.rest[v * 3 + 2] > -1.55)
        continue;
    const dz = tailModel.pos[v * 3 + 2] - tailModel.rest[v * 3 + 2];
    if (dz > 0.03)
        tailIn = true;
    if (dz < -0.02)
        tailLonger = true;
}
ensure(tailCrush.max > 0.04 && tailCrush.max <= damage.MAX_TRAVEL + 0.02, "a rear hit should dent the tail, moved " + tailCrush.max);
ensure(tailIn, "a rear hit should crush the tail forward");
ensure(!tailLonger, "a rear hit should not stretch the tail");
ensure(noseFromTail.max < 1e-5, "a rear hit should leave the nose");

const sideContactZ = 0.2;
const side = { impulse: 2800, x: -0.7, y: 0.02, z: sideContactZ, nx: 1, ny: 0, nz: 0 };
const sideModel = buildCar();
const beforeSide = snapshot(sideModel);
hit(sideModel, side, 8);
const nearMove = maxMove(beforeSide, sideModel, (v) => sideModel.rest[v * 3] < -0.3 && Math.abs(sideModel.rest[v * 3 + 2] - sideContactZ) < 0.7 && sideModel.sectionOf[v] >= 0);
const farMove = maxMove(beforeSide, sideModel, (v) => sideModel.rest[v * 3] > 0.35 && sideModel.sectionOf[v] >= 0);
console.log("side hit: near", nearMove, "opposite", farMove);
ensure(nearMove.max > 0.04 && nearMove.max <= damage.MAX_TRAVEL + 0.02, "near frame should dent, moved " + nearMove.max);
ensure(farMove.max < 1e-4, "the opposite side should stay put");

let sideIn = false;
let sideFlew = false;
for (let v = 0; v < sideModel.count; v++) {
    if (sideModel.sectionOf[v] < 0)
        continue;
    const dx = sideModel.pos[v * 3] - beforeSide[v * 3];
    const travel = Math.hypot(dx, sideModel.pos[v * 3 + 1] - beforeSide[v * 3 + 1], sideModel.pos[v * 3 + 2] - beforeSide[v * 3 + 2]);
    if (dx > 0.03)
        sideIn = true;
    if (dx < -0.02 || travel > damage.MAX_TRAVEL + 0.02)
        sideFlew = true;
}
ensure(sideIn, "a side hit should push the shell inward");
ensure(!sideFlew, "a side hit should not throw the shell off the car");

let spineClip = 0;
let wheelClip = 0;
for (const crashed of [model, sideModel]) {
    for (let v = 0; v < crashed.count; v++) {
        if (crashed.sectionOf[v] < 0)
            continue;
        const x = crashed.pos[v * 3], y = crashed.pos[v * 3 + 1], z = crashed.pos[v * 3 + 2];
        if (insideSpine(x, y, z))
            spineClip += 1;
        if (wheelPenetration(x, y, z))
            wheelClip += 1;
    }
}
ensure(spineClip === 0, "deformed frame entered the drivebase spine: " + spineClip);
ensure(wheelClip === 0, "deformed frame entered a wheel: " + wheelClip);

const skirt = new Float32Array([0.3, -0.36, 0.2]);
const skirtModel = damage.createDamageModel(skirt, []);
for (let i = 0; i < 12; i++)
    damage.applyContacts(skirtModel, [{ impulse: 9000, x: 0.55, y: -0.36, z: 0.2, nx: -1, ny: 0, nz: 0 }]);
console.log("skirt dent", skirtModel.pos[0], skirtModel.pos[1], skirtModel.pos[2]);
ensure(skirtModel.pos[0] < 0.28, "skirt should dent inward, x=" + skirtModel.pos[0]);
ensure(skirtModel.pos[0] > 0.05, "skirt should stay on the car, x=" + skirtModel.pos[0]);
ensure(!insideSpine(skirtModel.pos[0], skirtModel.pos[1], skirtModel.pos[2]), "skirt vertex is inside the spine");

const besideWheel = new Float32Array([-1.05, -0.22, 1.35]);
const wheelModel = damage.createDamageModel(besideWheel, []);
for (let i = 0; i < 12; i++)
    damage.applyContacts(wheelModel, [{ impulse: 8000, x: -1.15, y: -0.22, z: 1.35, nx: 1, ny: 0, nz: 0 }]);
const wheel = damage.WHEELS[1];
const wheelDist = Math.hypot(wheelModel.pos[0] - wheel.x, wheelModel.pos[1] - wheel.y, wheelModel.pos[2] - wheel.z);
console.log("wheel keep-out dist", wheelDist, "pos", wheelModel.pos[0], wheelModel.pos[1], wheelModel.pos[2]);
ensure(wheelDist >= wheel.r - 1e-3, "frame should stay outside the wheel");
ensure(wheelModel.pos[0] > -1.05 && wheelModel.pos[0] < -0.7, "panel beside the wheel should dent inward, x=" + wheelModel.pos[0]);

const ground = buildCar();
const beforeGround = snapshot(ground);
hit(ground, { impulse: 5000, x: 0.4, y: -0.35, z: 0.4, nx: 0, ny: 1, nz: 0 }, 20);
const groundMove = maxMove(beforeGround, ground, () => true);
ensure(groundMove.max < 1e-6, "an upward ground contact should not crumple the shell");

const bump = buildCar();
const beforeBump = snapshot(bump);
hit(bump, { impulse: 12, x: 0.05, y: 0.05, z: 1.62, nx: 0, ny: 0, nz: -1 }, 4);
const bumpMove = maxMove(beforeBump, bump, () => true);
ensure(bumpMove.max < 1e-6, "a light bump should not dent the shell, moved " + bumpMove.max);

const moderate = buildCar();
const beforeModerate = snapshot(moderate);
hit(moderate, { impulse: 48, x: 0.05, y: 0.05, z: 1.62, nx: 0, ny: 0, nz: -1 }, 1);
const moderateMove = maxMove(beforeModerate, moderate, (v) => moderate.rest[v * 3 + 2] > 1.15 && moderate.sectionOf[v] >= 0);
console.log("moderate nose", moderateMove);
ensure(moderateMove.max < 0.01, "a moderate hit should not fold the shell, moved " + moderateMove.max);

function springHold(comp) {
    return (3 + 482 * comp * comp) * comp;
}
const rideHold = springHold(0.16);
const shallowHold = springHold(0.08);
const deepHold = springHold(0.2);
console.log("spring hold ride", rideHold, "shallow", shallowHold, "deep", deepHold);
ensure(Math.abs(rideHold - 9.82 / 4) < 0.03, "the lower ride should still support the car, k*c=" + rideHold);
ensure(shallowHold < 1, "a small compression should not yet hold the car, k*c=" + shallowHold);
ensure(deepHold > rideHold * 1.4, "a deeper compression should push harder than the sagged ride, k*c=" + deepHold);

const outward = damage.impactDirection({ x: 1.4, y: 0, z: 0, nx: 1, ny: 0, nz: 0 });
ensure(outward && outward[0] > 0, "a force pointing off the car stays in that direction");
const inward = damage.impactDirection({ x: 0.4, y: 0, z: 0, nx: -1, ny: 0, nz: 0 });
ensure(inward && inward[0] < 0, "an inward force dents inward");
ensure(!damage.planDetach, "body panels should stay attached");
const damageSource = fs.readFileSync(path.join(root, "car_damage.js"), "utf8");
ensure(!damageSource.includes("planDetach"), "damage should not split the body into flying faces");
ensure(damageSource.includes("const RADIUS = 0.75"), "dent radius should stay local");
ensure(damageSource.includes("const IMPULSE_MIN = 40"), "light bumps should stay under the dent threshold");
ensure(damageSource.includes("const IMPULSE_SCALE = 0.00000031"), "dent strength should stay on the milder scale");
ensure(damageSource.includes("const STEP_CAP = 0.16"), "one hit should not fold a panel in a single step");
ensure(damageSource.includes("const MAX_TRAVEL = 0.22"), "a panel should not travel past the milder cap");
ensure(!damageSource.includes("refreshWear"), "damage should not track smoke wear");
ensure(!/Math\.random\s*\(/.test(damageSource) && !/Math\.hypot\s*\(/.test(damageSource), "damage math should stay deterministic");

if (failed > 0) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
}
console.log("\nAll car damage checks passed.");
