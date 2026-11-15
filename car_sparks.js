// Sparks where the car scrapes the ground, a wall, or locks a tire.
//
// Contacts arrive in mesh space (the same frame as the body mesh, with the
// 0.6 mass offset already removed). Wheel contacts are already in world space.
// The render thread steps this once per physics tick. Spread comes from the
// frame counter, because the game build has no random source.

(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports)
        module.exports = api;
    root.TrackpolySparks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const COUNT = 480;
    const MASS_OFFSET = 0.6;
    const DT = 0.001;
    const pools = new WeakMap();

    function lengthOf(x, y, z) {
        return Math.sqrt(x * x + y * y + z * z);
    }

    function rotate(qx, qy, qz, qw, x, y, z, out) {
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        out[0] = x + qw * tx + (qy * tz - qz * ty);
        out[1] = y + qw * ty + (qz * tx - qx * tz);
        out[2] = z + qw * tz + (qx * ty - qy * tx);
        return out;
    }

    function createPool() {
        return {
            count: COUNT,
            pos: new Float32Array(COUNT * 3),
            vel: new Float32Array(COUNT * 3),
            life: new Float32Array(COUNT),
            maxLife: new Float32Array(COUNT),
            color: new Float32Array(COUNT * 3),
            cursor: 0,
            dirty: false
        };
    }

    function spawn(pool, x, y, z, vx, vy, vz, life) {
        let slot = -1;
        for (let n = 0; n < pool.count; n++) {
            const i = (pool.cursor + n) % pool.count;
            if (pool.life[i] <= 0) {
                slot = i;
                pool.cursor = (i + 1) % pool.count;
                break;
            }
        }
        if (slot < 0)
            return;
        const i3 = slot * 3;
        pool.pos[i3] = x;
        pool.pos[i3 + 1] = y;
        pool.pos[i3 + 2] = z;
        pool.vel[i3] = vx;
        pool.vel[i3 + 1] = vy;
        pool.vel[i3 + 2] = vz;
        pool.life[slot] = life;
        pool.maxLife[slot] = life;
        pool.color[i3] = 1;
        pool.color[i3 + 1] = 0.92;
        pool.color[i3 + 2] = 0.55;
        pool.dirty = true;
    }

    // A resting belly contact is a small impulse with no speed. A scrape is
    // either moving or a real hit.
    function bodyShouldSpark(contact, speedKmh) {
        if (!contact || !(contact.impulse > 0.5))
            return false;
        if (contact.impulse > 4)
            return true;
        return Math.abs(speedKmh) > 8;
    }

    function due(frame, index, impulse) {
        if (impulse > 18)
            return true;
        return ((frame + index) & 3) === 0;
    }

    function emit(pool, frame, index, impulse, px, py, pz, nx, ny, nz, slideX, slideY, slideZ) {
        const nLen = lengthOf(nx, ny, nz);
        if (!(nLen > 0.2))
            return;
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
        const into = slideX * nx + slideY * ny + slideZ * nz;
        let tx = slideX - nx * into;
        let ty = slideY - ny * into;
        let tz = slideZ - nz * into;
        let tLen = lengthOf(tx, ty, tz);
        if (tLen < 0.25) {
            const ax = Math.abs(nx) < 0.7 ? 1 : 0;
            const ay = Math.abs(nx) < 0.7 ? 0 : 1;
            tx = ay * nz - 0 * ny;
            ty = 0 * nx - ax * nz;
            tz = ax * ny - ay * nx;
            tLen = lengthOf(tx, ty, tz);
            if (!(tLen > 0))
                return;
        }
        tx /= tLen;
        ty /= tLen;
        tz /= tLen;
        const bx = ny * tz - nz * ty;
        const by = nz * tx - nx * tz;
        const bz = nx * ty - ny * tx;
        const wobble = Math.sin(frame * 0.37 + index * 1.7);
        const wobble2 = Math.sin(frame * 0.19 + index * 4.1);
        const punch = Math.min(9, Math.sqrt(impulse) * 0.7);
        const outward = 2.4 + punch + Math.abs(wobble) * 2.2;
        const along = tLen * (0.75 + 0.2 * wobble2);
        const side = wobble * (2.4 + punch * 0.2);
        const life = 0.16 + 0.22 * (0.5 + 0.5 * wobble2);
        spawn(
            pool,
            px + nx * 0.045,
            py + ny * 0.045,
            pz + nz * 0.045,
            nx * outward - tx * along + bx * side,
            ny * outward - ty * along + by * side,
            nz * outward - tz * along + bz * side,
            life
        );
    }

    // A hard hit pops a handful of sparks off the contact. Gated so a crash
    // reads as a burst instead of refilling the pool every physics tick.
    function burst(pool, frame, index, impulse, px, py, pz, nx, ny, nz) {
        if (!(impulse > 40) || (frame & 7) !== 0)
            return;
        const nLen = lengthOf(nx, ny, nz);
        if (!(nLen > 0.2))
            return;
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
        const ax = Math.abs(nx) < 0.7 ? 1 : 0;
        const ay = Math.abs(nx) < 0.7 ? 0 : 1;
        let tx = ay * nz;
        let ty = -ax * nz;
        let tz = ax * ny - ay * nx;
        const tLen = lengthOf(tx, ty, tz);
        if (!(tLen > 0))
            return;
        tx /= tLen;
        ty /= tLen;
        tz /= tLen;
        const bx = ny * tz - nz * ty;
        const by = nz * tx - nx * tz;
        const bz = nx * ty - ny * tx;
        for (let k = 0; k < 5; k++) {
            const wobble = Math.sin(frame * 0.37 + index * 1.7 + k * 2.3);
            const wobble2 = Math.sin(frame * 0.19 + k * 1.9);
            const outward = 4.5 + Math.abs(wobble) * 3.5;
            const side = wobble * 3.2;
            const lift = wobble2 * 2.4;
            const life = 0.22 + 0.16 * (0.5 + 0.5 * wobble2);
            spawn(
                pool,
                px + nx * 0.06 + tx * side * 0.02,
                py + ny * 0.06,
                pz + nz * 0.06 + tz * side * 0.02,
                nx * outward + tx * side + bx * lift,
                ny * outward + ty * side + by * lift,
                nz * outward + tz * side + bz * lift,
                life
            );
        }
    }

    function step(car, state) {
        if (!car || !state)
            return null;
        let pool = pools.get(car);
        if (!pool) {
            pool = createPool();
            pools.set(car, pool);
        }
        for (let i = 0; i < pool.count; i++) {
            if (pool.life[i] <= 0)
                continue;
            pool.life[i] -= DT;
            const i3 = i * 3;
            if (pool.life[i] <= 0) {
                pool.color[i3] = 0;
                pool.color[i3 + 1] = 0;
                pool.color[i3 + 2] = 0;
                pool.dirty = true;
                continue;
            }
            pool.vel[i3 + 1] -= 18 * DT;
            const drag = 1 - 3.2 * DT;
            pool.vel[i3] *= drag;
            pool.vel[i3 + 1] *= drag;
            pool.vel[i3 + 2] *= drag;
            pool.pos[i3] += pool.vel[i3] * DT;
            pool.pos[i3 + 1] += pool.vel[i3 + 1] * DT;
            pool.pos[i3 + 2] += pool.vel[i3 + 2] * DT;
            const hot = pool.life[i] / pool.maxLife[i];
            const fade = hot > 0.22 ? 1 : hot / 0.22;
            pool.color[i3] = fade;
            pool.color[i3 + 1] = fade * (0.42 + 0.5 * hot);
            pool.color[i3 + 2] = fade * 0.08 * hot;
            pool.dirty = true;
        }
        const speed = state.speedKmh || 0;
        const frame = state.frames || 0;
        const quat = state.quaternion;
        const origin = state.position;
        const contacts = state.collisionContacts;
        if (quat && origin && contacts && contacts.length) {
            const fwd = rotate(quat.x, quat.y, quat.z, quat.w, 0, 0, 1, [0, 0, 0]);
            const meters = speed / 3.6;
            const slideX = fwd[0] * meters;
            const slideY = fwd[1] * meters;
            const slideZ = fwd[2] * meters;
            let best = -1;
            let second = -1;
            let third = -1;
            let bestS = -1;
            let secondS = -1;
            let thirdS = -1;
            for (let i = 0; i < contacts.length; i++) {
                const contact = contacts[i];
                if (!bodyShouldSpark(contact, speed) || !due(frame, i, contact.impulse))
                    continue;
                const score = contact.impulse;
                if (score > bestS) {
                    third = second;
                    thirdS = secondS;
                    second = best;
                    secondS = bestS;
                    best = i;
                    bestS = score;
                } else if (score > secondS) {
                    third = second;
                    thirdS = secondS;
                    second = i;
                    secondS = score;
                } else if (score > thirdS) {
                    third = i;
                    thirdS = score;
                }
            }
            const chosen = [best, second, third];
            const tmp = [0, 0, 0];
            const nrm = [0, 0, 0];
            for (let k = 0; k < chosen.length; k++) {
                const index = chosen[k];
                if (index < 0)
                    continue;
                const contact = contacts[index];
                rotate(quat.x, quat.y, quat.z, quat.w, contact.x, contact.y + MASS_OFFSET, contact.z, tmp);
                rotate(quat.x, quat.y, quat.z, quat.w, contact.nx, contact.ny, contact.nz, nrm);
                emit(
                    pool,
                    frame,
                    index,
                    contact.impulse,
                    origin.x + tmp[0],
                    origin.y + tmp[1],
                    origin.z + tmp[2],
                    nrm[0],
                    nrm[1],
                    nrm[2],
                    slideX,
                    slideY,
                    slideZ
                );
                burst(
                    pool,
                    frame,
                    index,
                    contact.impulse,
                    origin.x + tmp[0],
                    origin.y + tmp[1],
                    origin.z + tmp[2],
                    nrm[0],
                    nrm[1],
                    nrm[2]
                );
            }
        }
        const wheels = state.wheelContact;
        const skid = state.wheelSkidInfo;
        if (quat && origin && wheels && skid && Math.abs(speed) > 22) {
            const fwd = rotate(quat.x, quat.y, quat.z, quat.w, 0, 0, 1, [0, 0, 0]);
            const meters = speed / 3.6;
            for (let w = 0; w < wheels.length && w < 4; w++) {
                const contact = wheels[w];
                if (!contact || !contact.position || !contact.normal)
                    continue;
                if (!(skid[w] < 0.5))
                    continue;
                if (!due(frame, w + 4, 1))
                    continue;
                emit(
                    pool,
                    frame,
                    w + 4,
                    2,
                    contact.position.x,
                    contact.position.y,
                    contact.position.z,
                    contact.normal.x,
                    contact.normal.y,
                    contact.normal.z,
                    fwd[0] * meters,
                    fwd[1] * meters,
                    fwd[2] * meters
                );
            }
        }
        return pool;
    }

    function discard(car) {
        pools.delete(car);
    }

    return {
        step: step,
        discard: discard,
        createPool: createPool,
        bodyShouldSpark: bodyShouldSpark,
        COUNT: COUNT
    };
});
