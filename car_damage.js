// Visual crash damage for the car body.
//
// The shell is split into panels around a rigid drivebase: the center chassis
// rails, the suspension, and the wheels. A hard hit blasts those panels off
// the car, away from the cabin. Vertices are kept out of the drivebase.
// The collision hull is not modified.

(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports)
        module.exports = api;
    root.TrackpolyDamage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    // Mesh space, same coordinates as models/car.glb before the render offset.
    const SPINE = {
        minX: -0.18,
        maxX: 0.18,
        minY: -0.46,
        maxY: -0.30,
        minZ: -2.20,
        maxZ: 1.85
    };
    const SPINE_GAP = 0.025;
    // Wheel centers from the glTF nodes. Radius stays inside the tire mesh
    // so a panel can crease up to the rubber without entering it.
    const WHEELS = [
        { x: 0.627909, y: -0.218824, z: 1.347801, r: 0.32 },
        { x: -0.627911, y: -0.218825, z: 1.347801, r: 0.32 },
        { x: 0.720832, y: -0.218824, z: -1.526859, r: 0.32 },
        { x: -0.720833, y: -0.218825, z: -1.526855, r: 0.32 }
    ];
    const CLEARANCE = 0.03;
    const RADIUS = 0.9;
    const IMPULSE_MIN = 40;
    // Squared so a light brush barely moves a panel and a wall hit throws it
    // clear of the car in one physics step.
    const IMPULSE_SCALE = 0.000000484;
    const STEP_CAP = 2.15;
    const SECTION_CAP = 2.3;
    const MAX_TRAVEL = 2.3;
    const SPIN_CAP = 2.1;
    const MIN_SECTION_VERTS = 6;
    const SPLIT_EXTENT = 0.82;

    // The game replaces Math.hypot with a throw. Length stays on sqrt, which
    // the physics build provides.
    function lengthOf(x, y, z) {
        return Math.sqrt(x * x + y * y + z * z);
    }

    function isDrivebase(x, y, z) {
        return x >= SPINE.minX && x <= SPINE.maxX && y >= SPINE.minY && y <= SPINE.maxY && z >= SPINE.minZ && z <= SPINE.maxZ;
    }

    function regionKey(x, y, z) {
        const along = z >= 1.05 ? "nose" : z >= 0.15 ? "front" : z >= -0.75 ? "mid" : z >= -1.45 ? "rear" : "tail";
        const side = x >= 0.26 ? "L" : x <= -0.26 ? "R" : "C";
        const band = y >= 0.12 ? "hi" : y >= -0.22 ? "mid" : "lo";
        if (along === "nose")
            return side === "C" ? "nose" : "nose-" + side;
        if (along === "tail")
            return side === "C" ? "tail" : "tail-" + side;
        if (side === "C" && band === "hi") {
            if (along === "front")
                return "hood";
            if (along === "mid")
                return "roof";
            return "rear-deck";
        }
        return along + "-" + side + "-" + band;
    }

    function centroid(rest, indices) {
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < indices.length; k++) {
            const i = indices[k] * 3;
            x += rest[i];
            y += rest[i + 1];
            z += rest[i + 2];
        }
        const n = indices.length || 1;
        return [x / n, y / n, z / n];
    }

    function extent(rest, indices) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let k = 0; k < indices.length; k++) {
            const i = indices[k] * 3;
            const x = rest[i], y = rest[i + 1], z = rest[i + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        return [maxX - minX, maxY - minY, maxZ - minZ];
    }

    function splitLarge(rest, key, indices, depth, out) {
        const ext = extent(rest, indices);
        let axis = 0;
        if (ext[1] > ext[axis]) axis = 1;
        if (ext[2] > ext[axis]) axis = 2;
        if (depth >= 3 || ext[axis] <= SPLIT_EXTENT || indices.length < 16) {
            out.push([key, indices]);
            return;
        }
        const coords = indices.map((index) => rest[index * 3 + axis]);
        const sorted = coords.slice().sort((a, b) => a - b);
        const mid = sorted[sorted.length >> 1];
        const lo = [];
        const hi = [];
        for (let k = 0; k < indices.length; k++)
            (coords[k] <= mid ? lo : hi).push(indices[k]);
        if (lo.length === 0 || hi.length === 0) {
            out.push([key, indices]);
            return;
        }
        splitLarge(rest, key + "-a", lo, depth + 1, out);
        splitLarge(rest, key + "-b", hi, depth + 1, out);
    }

    function mergeSmall(rest, buckets) {
        const frozen = new Set();
        while (buckets.length > 1) {
            let pick = -1;
            for (let i = 0; i < buckets.length; i++) {
                if (frozen.has(buckets[i].name))
                    continue;
                if (buckets[i].indices.length >= MIN_SECTION_VERTS)
                    continue;
                if (pick === -1 || buckets[i].indices.length < buckets[pick].indices.length)
                    pick = i;
            }
            if (pick === -1)
                break;
            const small = buckets[pick];
            const ca = centroid(rest, small.indices);
            let best = -1;
            let bestCost = Infinity;
            for (let j = 0; j < buckets.length; j++) {
                if (j === pick)
                    continue;
                const cb = centroid(rest, buckets[j].indices);
                let cost = lengthOf(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
                if (Math.sign(ca[0]) !== Math.sign(cb[0]) && Math.abs(ca[0]) > 0.2 && Math.abs(cb[0]) > 0.2)
                    cost += 2;
                if (cost < bestCost) {
                    bestCost = cost;
                    best = j;
                }
            }
            if (best === -1 || bestCost > 0.55) {
                frozen.add(small.name);
                continue;
            }
            const host = buckets[best];
            for (let k = 0; k < small.indices.length; k++)
                host.indices.push(small.indices[k]);
            buckets.splice(pick, 1);
        }
    }

    function createDamageModel(livePositions, extraPoints) {
        const count = livePositions.length / 3;
        const rest = new Float32Array(livePositions);
        const groups = new Map();
        const sectionOf = new Int16Array(count);
        sectionOf.fill(-1);
        for (let v = 0; v < count; v++) {
            const i = v * 3;
            const key = isDrivebase(rest[i], rest[i + 1], rest[i + 2]) ? null : regionKey(rest[i], rest[i + 1], rest[i + 2]);
            if (key === null)
                continue;
            let list = groups.get(key);
            if (!list) {
                list = [];
                groups.set(key, list);
            }
            list.push(v);
        }
        const split = [];
        for (const [key, indices] of groups)
            splitLarge(rest, key, indices, 0, split);
        const buckets = split.map(([name, indices], index) => ({
            name: name + "#" + index,
            indices: indices,
            used: 0,
            spin: 0,
            spun: 0,
            hasAxis: false,
            ax: 0,
            ay: 1,
            az: 0
        }));
        mergeSmall(rest, buckets);
        for (let s = 0; s < buckets.length; s++) {
            const indices = buckets[s].indices;
            for (let k = 0; k < indices.length; k++)
                sectionOf[indices[k]] = s;
        }
        const drivebasePoints = [];
        for (let v = 0; v < count; v++) {
            if (sectionOf[v] !== -1)
                continue;
            const i = v * 3;
            drivebasePoints.push([rest[i], rest[i + 1], rest[i + 2]]);
        }
        const extras = extraPoints || [];
        const step = Math.max(1, Math.floor(extras.length / 80));
        for (let e = 0; e < extras.length; e += step)
            drivebasePoints.push(extras[e]);
        return {
            count: count,
            rest: rest,
            pos: livePositions,
            sectionOf: sectionOf,
            sections: buckets,
            drivebasePoints: drivebasePoints,
            add: new Float32Array(livePositions.length)
        };
    }

    function describe(model) {
        return model.sections.map((section) => {
            const c = centroid(model.rest, section.indices);
            const ext = extent(model.rest, section.indices);
            return {
                name: section.name,
                verts: section.indices.length,
                center: c.map((n) => Math.round(n * 1000) / 1000),
                size: ext.map((n) => Math.round(n * 1000) / 1000)
            };
        });
    }

    function pushOutOfSphere(x, y, z, cx, cy, cz, radius) {
        let vx = x - cx, vy = y - cy, vz = z - cz;
        let dist = lengthOf(vx, vy, vz);
        if (dist >= radius)
            return null;
        if (dist < 1e-6) {
            vx = 1;
            vy = 0;
            vz = 0;
            dist = 1;
        }
        const scale = radius / dist;
        return [cx + vx * scale, cy + vy * scale, cz + vz * scale];
    }

    function constrainPoint(rx, ry, rz, x, y, z, model) {
        let dx = x - rx, dy = y - ry, dz = z - rz;
        let travel = lengthOf(dx, dy, dz);
        if (travel > MAX_TRAVEL) {
            const scale = MAX_TRAVEL / travel;
            x = rx + dx * scale;
            y = ry + dy * scale;
            z = rz + dz * scale;
        }
        for (let iter = 0; iter < 3; iter++) {
            const spineMinX = SPINE.minX - SPINE_GAP;
            const spineMaxX = SPINE.maxX + SPINE_GAP;
            const spineMinY = SPINE.minY - SPINE_GAP;
            const spineMaxY = SPINE.maxY + SPINE_GAP;
            const spineMinZ = SPINE.minZ - SPINE_GAP;
            const spineMaxZ = SPINE.maxZ + SPINE_GAP;
            if (x > spineMinX && x < spineMaxX && y > spineMinY && y < spineMaxY && z > spineMinZ && z < spineMaxZ) {
                const faces = [
                    { d: Math.abs(x - spineMinX), x: spineMinX - 1e-4, y: y, z: z },
                    { d: Math.abs(spineMaxX - x), x: spineMaxX + 1e-4, y: y, z: z },
                    { d: Math.abs(y - spineMinY), x: x, y: spineMinY - 1e-4, z: z },
                    { d: Math.abs(spineMaxY - y), x: x, y: spineMaxY + 1e-4, z: z },
                    { d: Math.abs(z - spineMinZ), x: x, y: y, z: spineMinZ - 1e-4 },
                    { d: Math.abs(spineMaxZ - z), x: x, y: y, z: spineMaxZ + 1e-4 }
                ];
                faces.sort((a, b) => a.d - b.d);
                x = faces[0].x;
                y = faces[0].y;
                z = faces[0].z;
            }
            for (let w = 0; w < WHEELS.length; w++) {
                const wheel = WHEELS[w];
                const pushed = pushOutOfSphere(x, y, z, wheel.x, wheel.y, wheel.z, wheel.r);
                if (pushed) {
                    x = pushed[0];
                    y = pushed[1];
                    z = pushed[2];
                }
            }
            const points = model.drivebasePoints;
            for (let p = 0; p < points.length; p++) {
                const q = points[p];
                const restDist = lengthOf(rx - q[0], ry - q[1], rz - q[2]);
                if (restDist > MAX_TRAVEL + 0.12)
                    continue;
                const limit = restDist < CLEARANCE ? restDist : CLEARANCE;
                let vx = x - q[0], vy = y - q[1], vz = z - q[2];
                const now = lengthOf(vx, vy, vz);
                if (now + 1e-5 >= limit)
                    continue;
                if (now < 1e-6) {
                    vx = x - rx;
                    vy = y - ry;
                    vz = z - rz;
                    const away = lengthOf(vx, vy, vz);
                    if (away < 1e-6) {
                        vx = 1;
                        vy = 0;
                        vz = 0;
                    } else {
                        vx /= away;
                        vy /= away;
                        vz /= away;
                    }
                } else {
                    vx /= now;
                    vy /= now;
                    vz /= now;
                }
                x = q[0] + vx * limit;
                y = q[1] + vy * limit;
                z = q[2] + vz * limit;
            }
        }
        return { x: x, y: y, z: z };
    }

    function impactDirection(contact) {
        let nx = contact.nx, ny = contact.ny, nz = contact.nz;
        const mag = lengthOf(nx, ny, nz);
        if (mag < 1e-4)
            return null;
        nx /= mag;
        ny /= mag;
        nz /= mag;
        // Tires holding the car up are not a crash.
        if (ny > 0.65 && lengthOf(nx, nz, 0) < 0.55)
            return null;
        // Blast away from the cabin. If the contact force points inward, flip it
        // so the panel flies back off the car instead of crushing into the spine.
        const toward = nx * (0 - contact.x) + ny * (-0.02 - contact.y) + nz * (-0.15 - contact.z);
        if (toward > 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        return [nx, ny, nz];
    }

    function blastDirection(dir, center, sectionIndex) {
        let rx = center[0], ry = center[1] + 0.2, rz = center[2];
        const radial = lengthOf(rx, ry, rz);
        if (radial > 1e-4) {
            rx /= radial;
            ry /= radial;
            rz /= radial;
        } else {
            rx = dir[0];
            ry = 0;
            rz = dir[2];
        }
        // Fan the panels apart so a hit reads as pieces leaving, not one sliding shell.
        const fan = (sectionIndex % 5) - 2;
        const yaw = (sectionIndex % 3) - 1;
        let x = dir[0] * 0.9 + rx * 0.7 + fan * 0.28;
        let y = 0.78 + dir[1] * 0.12 + ry * 0.2 + (sectionIndex % 4) * 0.08;
        let z = dir[2] * 0.9 + rz * 0.7 + yaw * 0.24;
        const mag = lengthOf(x, y, z);
        if (mag < 1e-4)
            return dir;
        return [x / mag, y / mag, z / mag];
    }

    // A triangle stays on the chassis unless every corner is shell and at least
    // two corners belong to the same panel. Boundary triangles that touch the
    // drivebase stay, so a flying panel cannot stretch a spike back to the spine.
    function triangleOwner(sectionOf, a, b, c) {
        const ids = [sectionOf[a], sectionOf[b], sectionOf[c]];
        if (ids[0] < 0 || ids[1] < 0 || ids[2] < 0)
            return -1;
        if (ids[0] === ids[1] && ids[1] === ids[2])
            return ids[0];
        let best = -1;
        let bestN = 0;
        for (let i = 0; i < 3; i++) {
            let n = 0;
            for (let j = 0; j < 3; j++)
                if (ids[j] === ids[i])
                    n += 1;
            if (n > bestN) {
                bestN = n;
                best = ids[i];
            }
        }
        return bestN >= 2 ? best : -1;
    }

    function planDetach(sectionOf, index, vertexCount) {
        const triCount = (index.length / 3) | 0;
        const sources = [];
        const ownerList = [];
        const map = new Map();
        const newIndex = new Uint32Array(index.length);
        for (let t = 0; t < triCount; t++) {
            const corners = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]];
            const owner = triangleOwner(sectionOf, corners[0], corners[1], corners[2]);
            for (let k = 0; k < 3; k++) {
                const old = corners[k];
                const key = old + (owner + 1) * vertexCount;
                let slot = map.get(key);
                if (slot === undefined) {
                    slot = sources.length;
                    sources.push(old);
                    ownerList.push(owner);
                    map.set(key, slot);
                }
                newIndex[t * 3 + k] = slot;
            }
        }
        return {
            index: newIndex,
            sources: sources,
            owners: Int16Array.from(ownerList)
        };
    }

    function adoptDetach(model, plan, positions) {
        const count = plan.sources.length;
        const rest = new Float32Array(positions.length);
        rest.set(positions);
        const sections = [];
        for (let s = 0; s < model.sections.length; s++) {
            sections.push({
                name: model.sections[s].name,
                indices: [],
                used: 0,
                spin: 0,
                spun: 0,
                hasAxis: false,
                ax: 0,
                ay: 1,
                az: 0
            });
        }
        const sectionOf = plan.owners;
        for (let v = 0; v < count; v++) {
            const s = sectionOf[v];
            if (s >= 0 && s < sections.length)
                sections[s].indices.push(v);
        }
        return {
            count: count,
            rest: rest,
            pos: positions,
            sectionOf: sectionOf,
            sections: sections,
            drivebasePoints: model.drivebasePoints,
            add: new Float32Array(positions.length)
        };
    }

    function attributesArePlain(geometry) {
        const attributes = geometry.attributes;
        if (!attributes)
            return false;
        for (const name in attributes) {
            const attr = attributes[name];
            if (!attr || !attr.array || attr.isInterleavedBufferAttribute || !attr.itemSize)
                return false;
        }
        return true;
    }

    function copyAttributeVerts(attr, sources) {
        const item = attr.itemSize;
        const next = new attr.array.constructor(sources.length * item);
        const src = attr.array;
        for (let v = 0; v < sources.length; v++) {
            const from = sources[v] * item;
            const to = v * item;
            for (let k = 0; k < item; k++)
                next[to + k] = src[from + k];
        }
        attr.array = next;
        attr.count = sources.length;
        attr.needsUpdate = true;
    }

    function rewriteGeometry(geometry, plan) {
        if (!attributesArePlain(geometry))
            return false;
        const sources = plan.sources;
        const attributes = geometry.attributes;
        for (const name in attributes)
            copyAttributeVerts(attributes[name], sources);
        const morph = geometry.morphAttributes;
        if (morph) {
            for (const name in morph) {
                const list = morph[name];
                if (!list)
                    continue;
                for (let m = 0; m < list.length; m++) {
                    const morphAttr = list[m];
                    if (!morphAttr || !morphAttr.array || morphAttr.isInterleavedBufferAttribute)
                        continue;
                    copyAttributeVerts(morphAttr, sources);
                }
            }
        }
        const index = geometry.index;
        if (!index || !index.array)
            return false;
        const IndexArray = sources.length > 65535 ? Uint32Array : index.array.constructor;
        const nextIndex = new IndexArray(plan.index.length);
        for (let i = 0; i < plan.index.length; i++)
            nextIndex[i] = plan.index[i];
        index.array = nextIndex;
        index.count = nextIndex.length;
        index.needsUpdate = true;
        return true;
    }

    function rotateAround(x, y, z, ax, ay, az, angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const oc = 1 - c;
        return [
            x * (c + ax * ax * oc) + y * (ax * ay * oc - az * s) + z * (ax * az * oc + ay * s),
            x * (ay * ax * oc + az * s) + y * (c + ay * ay * oc) + z * (ay * az * oc - ax * s),
            x * (az * ax * oc - ay * s) + y * (az * ay * oc + ax * s) + z * (c + az * az * oc)
        ];
    }

    function applyContacts(model, contacts) {
        if (!contacts || contacts.length === 0)
            return false;
        const rest = model.rest;
        const pos = model.pos;
        const add = model.add;
        add.fill(0);
        let any = false;
        for (let c = 0; c < contacts.length; c++) {
            const contact = contacts[c];
            if (!contact || !(contact.impulse > IMPULSE_MIN))
                continue;
            if (Math.abs(contact.x) > 3 || Math.abs(contact.y) > 3 || Math.abs(contact.z) > 4)
                continue;
            const dir = impactDirection(contact);
            if (!dir)
                continue;
            const extra = contact.impulse - IMPULSE_MIN;
            const strength = Math.min(STEP_CAP, extra * extra * IMPULSE_SCALE);
            if (!(strength > 0))
                continue;
            for (let s = 0; s < model.sections.length; s++) {
                const section = model.sections[s];
                if (section.used >= SECTION_CAP)
                    continue;
                const indices = section.indices;
                let nearest = Infinity;
                for (let k = 0; k < indices.length; k++) {
                    const i = indices[k] * 3;
                    const dist = lengthOf(rest[i] - contact.x, rest[i + 1] - contact.y, rest[i + 2] - contact.z);
                    if (dist < nearest)
                        nearest = dist;
                }
                if (nearest > RADIUS)
                    continue;
                const room = SECTION_CAP - section.used;
                const exposure = 1 - nearest / RADIUS;
                // One shift for the whole panel, thrown off the car. Vertices that
                // would land in the drivebase are pushed back out in constrainPoint.
                const blast = blastDirection(dir, centroid(rest, indices), s);
                const depth = Math.min(strength, room) * (0.72 + 0.28 * exposure);
                for (let k = 0; k < indices.length; k++) {
                    const i = indices[k] * 3;
                    add[i] += blast[0] * depth;
                    add[i + 1] += blast[1] * depth;
                    add[i + 2] += blast[2] * depth;
                }
                if (!section.hasAxis) {
                    let ax = blast[2];
                    let ay = 0.45 * ((s % 2) === 0 ? 1 : -1);
                    let az = -blast[0];
                    const axisLen = lengthOf(ax, ay, az);
                    if (axisLen > 1e-4) {
                        section.ax = ax / axisLen;
                        section.ay = ay / axisLen;
                        section.az = az / axisLen;
                        section.hasAxis = true;
                    }
                }
                const spinRoom = SPIN_CAP - (section.spun || 0);
                if (spinRoom > 0) {
                    const delta = Math.min(spinRoom, depth * 0.55);
                    section.spin = (section.spin || 0) + delta;
                    section.spun = (section.spun || 0) + delta;
                }
                section.used = Math.min(SECTION_CAP, section.used + strength);
            }
            any = true;
        }
        if (!any)
            return false;
        let changed = false;
        for (let s = 0; s < model.sections.length; s++) {
            const section = model.sections[s];
            const indices = section.indices;
            const spin = section.spin || 0;
            if (!indices.length)
                continue;
            let cx = 0, cy = 0, cz = 0;
            let active = spin > 1e-6;
            for (let k = 0; k < indices.length; k++) {
                const i = indices[k] * 3;
                cx += pos[i];
                cy += pos[i + 1];
                cz += pos[i + 2];
                if (!active && (add[i] !== 0 || add[i + 1] !== 0 || add[i + 2] !== 0))
                    active = true;
            }
            if (!active)
                continue;
            const n = indices.length;
            cx /= n;
            cy /= n;
            cz /= n;
            const hasSpin = spin > 1e-6 && section.hasAxis;
            for (let k = 0; k < indices.length; k++) {
                const i = indices[k] * 3;
                let x = pos[i], y = pos[i + 1], z = pos[i + 2];
                if (hasSpin) {
                    const rot = rotateAround(x - cx, y - cy, z - cz, section.ax, section.ay, section.az, spin);
                    x = cx + rot[0];
                    y = cy + rot[1];
                    z = cz + rot[2];
                }
                let ax = add[i], ay = add[i + 1], az = add[i + 2];
                const span = lengthOf(ax, ay, az);
                if (span > STEP_CAP) {
                    const scale = STEP_CAP / span;
                    ax *= scale;
                    ay *= scale;
                    az *= scale;
                }
                const next = constrainPoint(rest[i], rest[i + 1], rest[i + 2], x + ax, y + ay, z + az, model);
                if (next.x !== pos[i] || next.y !== pos[i + 1] || next.z !== pos[i + 2]) {
                    pos[i] = next.x;
                    pos[i + 1] = next.y;
                    pos[i + 2] = next.z;
                    changed = true;
                }
            }
            section.spin = 0;
        }
        return changed;
    }

    let failed = false;

    function suspensionSamples(suspension) {
        if (!suspension || !suspension.geometry || !suspension.geometry.attributes || !suspension.geometry.attributes.position)
            return [];
        const attr = suspension.geometry.attributes.position;
        const samples = [];
        const step = Math.max(1, Math.floor(attr.count / 70));
        for (let i = 0; i < attr.count; i += step)
            samples.push([attr.getX(i), attr.getY(i), attr.getZ(i)]);
        return samples;
    }

    function prepare(body, suspension) {
        if (body.userData && body.userData.trackpoly)
            return body.userData.trackpoly;
        if (!body.geometry || !body.geometry.attributes || !body.geometry.attributes.position)
            return null;
        const source = body.geometry.attributes.position;
        if (source.itemSize !== 3)
            return null;
        body.geometry = body.geometry.clone();
        let attr = body.geometry.attributes.position;
        let live = attr.array;
        if (live.length !== attr.count * 3) {
            live = new Float32Array(attr.count * 3);
            for (let i = 0; i < attr.count; i++) {
                live[i * 3] = attr.getX(i);
                live[i * 3 + 1] = attr.getY(i);
                live[i * 3 + 2] = attr.getZ(i);
            }
        }
        let model = createDamageModel(live, suspensionSamples(suspension));
        const index = body.geometry.index;
        if (index && index.array && attributesArePlain(body.geometry)) {
            const plan = planDetach(model.sectionOf, index.array, model.count);
            if (rewriteGeometry(body.geometry, plan)) {
                const posAttr = body.geometry.attributes.position;
                model = adoptDetach(model, plan, posAttr.array);
                live = posAttr.array;
                attr = posAttr;
            }
        }
        const mats = Array.isArray(body.material) ? body.material : [body.material];
        for (let m = 0; m < mats.length; m++) {
            if (mats[m])
                mats[m].side = 2;
        }
        body.userData.trackpoly = {
            model: model,
            attr: attr,
            packed: live !== attr.array
        };
        return body.userData.trackpoly;
    }

    function apply(body, suspension, state) {
        if (failed || !body || !state || !state.collisionContacts || state.collisionContacts.length === 0)
            return;
        try {
            const prepared = prepare(body, suspension);
            if (!prepared)
                return;
            const changed = applyContacts(prepared.model, state.collisionContacts);
            if (!changed)
                return;
            if (prepared.packed) {
                const live = prepared.model.pos;
                for (let i = 0; i < prepared.attr.count; i++)
                    prepared.attr.setXYZ(i, live[i * 3], live[i * 3 + 1], live[i * 3 + 2]);
            }
            prepared.attr.needsUpdate = true;
            if (body.geometry.computeVertexNormals)
                body.geometry.computeVertexNormals();
            const normals = body.geometry.attributes && body.geometry.attributes.normal;
            if (normals)
                normals.needsUpdate = true;
            if (body.geometry.computeBoundingSphere)
                body.geometry.computeBoundingSphere();
            if (body.geometry.computeBoundingBox)
                body.geometry.computeBoundingBox();
        } catch (error) {
            failed = true;
            console.error("Trackpoly body damage disabled", error);
        }
    }

    return {
        apply: apply,
        createDamageModel: createDamageModel,
        applyContacts: applyContacts,
        constrainPoint: constrainPoint,
        describe: describe,
        isDrivebase: isDrivebase,
        impactDirection: impactDirection,
        planDetach: planDetach,
        SPINE: SPINE,
        SPINE_GAP: SPINE_GAP,
        WHEELS: WHEELS,
        MAX_TRAVEL: MAX_TRAVEL
    };
});
