const fs = require("fs");
const path = require("path");
const sparks = require("../car_sparks.js");

let failed = 0;
function ensure(condition, message) {
    if (!condition) {
        failed++;
        console.error("FAIL", message);
    }
}

function alive(pool) {
    let n = 0;
    const points = [];
    for (let i = 0; i < pool.count; i++) {
        if (pool.life[i] > 0) {
            n++;
            points.push({
                x: pool.pos[i * 3],
                y: pool.pos[i * 3 + 1],
                z: pool.pos[i * 3 + 2],
                vx: pool.vel[i * 3],
                vy: pool.vel[i * 3 + 1],
                vz: pool.vel[i * 3 + 2]
            });
        }
    }
    return { n, points };
}

const car = {};
const identity = { x: 0, y: 0, z: 0, w: 1 };
const origin = { x: 10, y: 2, z: -4 };

const resting = sparks.step(car, {
    frames: 0,
    speedKmh: 0,
    quaternion: identity,
    position: origin,
    collisionContacts: [{ impulse: 1.2, x: 0, y: -0.35, z: 0, nx: 0, ny: 1, nz: 0 }],
    wheelContact: [null, null, null, null],
    wheelSkidInfo: [1, 1, 1, 1]
});
ensure(alive(resting).n === 0, "a parked belly contact should not spark");

const scrapeCar = {};
const scrape = sparks.step(scrapeCar, {
    frames: 0,
    speedKmh: 72,
    quaternion: identity,
    position: origin,
    collisionContacts: [{ impulse: 3, x: 0.2, y: -0.34, z: 0.5, nx: 0, ny: 1, nz: 0 }],
    wheelContact: [null, null, null, null],
    wheelSkidInfo: [1, 1, 1, 1]
});
const scraped = alive(scrape);
ensure(scraped.n === 1, "a moving belly scrape should throw a spark, got " + scraped.n);
const spark = scraped.points[0];
ensure(Math.abs(spark.x - (10 + 0.2)) < 0.08, "spark x should sit on the contact");
ensure(Math.abs(spark.z - (-4 + 0.5)) < 0.08, "spark z should sit on the contact");
ensure(spark.y > 2 + (-0.34 + 0.6), "spark should clear the road");
ensure(spark.vy > 0, "ground sparks should kick upward");
ensure(spark.vz < 0, "sparks should trail opposite the forward slide");

const wallCar = {};
const wall = sparks.step(wallCar, {
    frames: 0,
    speedKmh: 10,
    quaternion: identity,
    position: origin,
    collisionContacts: [{ impulse: 40, x: 0.75, y: 0, z: 0.2, nx: 1, ny: 0.1, nz: 0 }],
    wheelContact: [null, null, null, null],
    wheelSkidInfo: [1, 1, 1, 1]
});
const hit = alive(wall);
ensure(hit.n === 1, "a wall hit should spark");
ensure(hit.points[0].vx > 0, "wall sparks should spray off the wall");

const tireCar = {};
const tire = sparks.step(tireCar, {
    frames: 4,
    speedKmh: 80,
    quaternion: identity,
    position: origin,
    collisionContacts: [],
    wheelContact: [
        { position: { x: 3, y: 1, z: 5 }, normal: { x: 0, y: 1, z: 0 } },
        null,
        null,
        null
    ],
    wheelSkidInfo: [0.2, 1, 1, 1]
});
const locked = alive(tire);
ensure(locked.n === 1, "a sliding tire should spark");
ensure(Math.abs(locked.points[0].x - 3) < 0.1 && Math.abs(locked.points[0].z - 5) < 0.1, "tire spark starts at the contact");

const gripCar = {};
sparks.step(gripCar, {
    frames: 4,
    speedKmh: 80,
    quaternion: identity,
    position: origin,
    collisionContacts: [],
    wheelContact: [{ position: { x: 1, y: 1, z: 1 }, normal: { x: 0, y: 1, z: 0 } }, null, null, null],
    wheelSkidInfo: [0.95, 1, 1, 1]
});
ensure(alive(gripCar).n === 0, "a gripping tire should not spark");

let faded = false;
for (let n = 0; n < 400; n++) {
    sparks.step(scrapeCar, {
        frames: n + 1,
        speedKmh: 0,
        quaternion: identity,
        position: origin,
        collisionContacts: [],
        wheelContact: [null, null, null, null],
        wheelSkidInfo: [1, 1, 1, 1]
    });
    if (alive(scrapeCar).n === 0) {
        faded = true;
        break;
    }
}
ensure(faded, "sparks should burn out");

const source = fs.readFileSync(path.join(__dirname, "../car_sparks.js"), "utf8");
ensure(!source.includes("Math.random"), "sparks must not call Math.random");
ensure(!source.includes("Math.hypot"), "sparks must not call Math.hypot");
const bundle = fs.readFileSync(path.join(__dirname, "../main.bundle.js"), "utf8");
const worker = fs.readFileSync(path.join(__dirname, "../simulation_worker.bundle.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
ensure(html.includes('src="./car_sparks.js"'), "page should load car_sparks.js");
ensure(bundle.includes("trackpolySyncSparks(this, e)"), "the car should step sparks");
ensure(bundle.includes("trackpolyDropSparks(this)"), "leaving a race should drop sparks");
ensure(worker.includes("impulse > .5"), "light scrapes should be sent to the renderer");
ensure(bundle.includes("window.TrackpolyDamage.apply"), "damage hook stays in place");

if (failed) {
    console.error(failed + " spark checks failed");
    process.exit(1);
}
console.log("spark checks passed");
