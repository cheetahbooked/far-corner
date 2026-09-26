// Far Corner's service worker: the app with no network, and a new build all at
// once or not at all.
//
// The app is used five minutes at a time on a train, so once installed it has
// to start offline. And it is a set of files that must match each other: a new
// far-corner.wasm meeting an old bridge.js fails to start on an import the old
// bridge does not have (serve.ps1). So what this keeps is not whatever was
// fetched last but whole builds, each file checked byte for byte against the
// build.json that build.ps1 writes beside them:
//
//   {"id": "<16 hex>", "files": {"<name>": "<sha-256 hex>", ...}}
//
// One build is current, and every launch is answered from it. Each launch also
// asks for build.json; when it names another build, that build is downloaded
// and checked in the background and marked ready, and the next launch switches
// to it before answering. A page never changes build while it is open.
//
// This file does not change when the app does. A browser decides whether a
// service worker was updated by comparing its bytes, and what it does with
// importScripts and its HTTP cache while comparing differs between browsers,
// iOS above all; so which build is served is data, never this script. Change it
// only to change how it works.
//
// Everything is kept in Cache Storage, because a service worker is stopped when
// idle and starts again with no variables. Cache Storage is per origin and a
// GitHub Pages origin holds every site of its owner, so each name carries this
// worker's scope, and nothing without it is touched:
//
//   "dabo <scope path> build <id>"  a build: its files under their URLs, then
//                                   its build.json, put last as the mark that
//                                   every file is in
//   "dabo <scope path> state"       one entry, sw-state:
//                                   {"current": <id> | null, "ready": <id> | null}
//
// Registered by index.html once the app has started, and not on a dev host
// unless the URL has ?dev=sw (index.html says why).
"use strict";

const SCOPE = self.registration.scope; // ends in "/"
const SCOPE_PATH = new URL(SCOPE).pathname;
const NS = "dabo " + SCOPE_PATH;
const STATE = NS + " state";
const STATE_URL = new URL("sw-state", SCOPE).href;
const MANIFEST = "build.json";

const buildName = (id) => NS + " build " + id;
const at = (name) => new URL(name, SCOPE).href;

self.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		// A failure anywhere fails the install, and the page registers again at
		// its next launch. Files already checked are kept for that attempt.
		const m = await latest();
		await prepare(m);
		await adopt(m);
		// A newer worker takes over from an older one at once, rather than when
		// every page the older one serves has closed, which on a phone may be
		// never. The build a page runs does not change with it: the new worker
		// reads the same state, and adopt() only marks a different build ready.
		await self.skipWaiting();
	})());
});

// No clients.claim(): the page that registered this came from the network, it
// runs, and the next launch is served from the build.

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET" || !req.url.startsWith(SCOPE)) return;
	const name = new URL(req.url).pathname.slice(SCOPE_PATH.length);

	// A launch, whatever its query (the app reads ?dev=). Storage that fails
	// here sends the launch to the network rather than to an error page.
	if (req.mode === "navigate" && (name === "" || name === "index.html")) {
		const current = launch().catch(() => null);
		event.respondWith(current.then((id) => answer(id, "index.html", req)));
		event.waitUntil(current.then(refresh).catch((e) => console.warn("far corner sw: no update:", e.message)));
		return;
	}
	event.respondWith(readState().then((s) => answer(s.current, name, req)));
});

// The file `name` from build `id` if it is one of its files, else the network.
// A build's build.json is its mark, not one of its files: a page asking for
// build.json gets the network's.
async function answer(id, name, req) {
	if (id && name !== MANIFEST) {
		const hit = await caches.match(at(name), { cacheName: buildName(id) }).catch(() => null);
		if (hit) return hit;
	}
	return fetch(req);
}

// The build a launch is answered from: the ready one, if there is one, which
// becomes current here.
async function launch() {
	const s = await readState();
	if (!s.ready || s.ready === s.current) return s.current;
	return (await locked(swap)).current;
}

async function swap() {
	const s = await readState();
	if (!s.ready || s.ready === s.current) return s;
	const next = { current: (await complete(s.ready)) ? s.ready : s.current, ready: null };
	await writeState(next);
	// The only place builds are deleted: the one just left, a ready build that
	// was overtaken by a later one, and any download that failed halfway.
	// Known race: a page launched a moment earlier in another window may get
	// the rest of its files from the new build and fail to start; a reload
	// mends it.
	const keep = new Set([STATE, buildName(next.current), buildName(next.ready)]);
	for (const id of preparing.keys()) keep.add(buildName(id));
	for (const name of await caches.keys()) {
		if (name.startsWith(NS + " ") && !keep.has(name)) await caches.delete(name);
	}
	return next;
}

// After a launch has been answered: whether build.json names another build, and
// if so, that build downloaded and marked ready. Offline, or with build.json
// missing, this fails and nothing changes; the next launch asks again.
async function refresh() {
	const m = await latest();
	const s = await readState();
	if (m.id === s.ready) return;
	const have = m.id === s.current && (await complete(s.current));
	if (have && !s.ready) return;
	if (!have) await prepare(m);
	await adopt(m);
}

// Build `m`, which prepare() has made complete, as the one the next launch
// runs: marked ready, or current if there is no current build to be served
// (the first install, or a store the browser emptied), since then no page is
// running from one. If `m` is current already, a build marked ready is
// forgotten: build.json went back to the build before it.
function adopt(m) {
	return locked(async () => {
		const s = await readState();
		if (m.id === s.ready) return;
		if (m.id === s.current) {
			if (s.ready) await writeState({ current: s.current, ready: null });
			return;
		}
		// A sweep in another worker can delete a download before it is marked.
		if (!(await complete(m.id))) throw new Error(`build ${m.id} is no longer complete`);
		await writeState((await complete(s.current)) ? { current: s.current, ready: m.id } : { current: m.id, ready: null });
	});
}

// build.json as the server has it now, never the HTTP cache's: GitHub Pages
// lets a browser keep any file for ten minutes.
async function latest() {
	const r = await fetch(at(MANIFEST), { cache: "no-store" });
	if (!r.ok) throw new Error(`${MANIFEST}: HTTP ${r.status}`);
	const m = await r.json();
	// It names the URLs this fetches, so it must name files beside it and
	// nothing else; and the build must have a page to launch.
	const ok = typeof m.id === "string" && /^[0-9a-f]{16}$/.test(m.id) && m.files && typeof m.files === "object" &&
		"index.html" in m.files &&
		Object.entries(m.files).every(([n, h]) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(n) && /^[0-9a-f]{64}$/.test(h));
	if (!ok) throw new Error(`${MANIFEST} is malformed`);
	return m;
}

// Downloads in progress in this worker, by build id: two launches close
// together download a build once, and swap() leaves it alone.
const preparing = new Map();

function prepare(m) {
	let p = preparing.get(m.id);
	if (!p) {
		p = download(m).finally(() => preparing.delete(m.id));
		preparing.set(m.id, p);
	}
	return p;
}

// Every file of `m` into its build, each checked against its hash, then the
// mark. A file already there under the same hash, from an attempt that failed
// halfway or from an older worker, is kept rather than fetched again.
async function download(m) {
	if (await complete(m.id)) return;
	const cache = await caches.open(buildName(m.id));
	await Promise.all(Object.entries(m.files).map(async ([name, hash]) => {
		const have = await cache.match(at(name));
		if (have && have.headers.get("X-Dabo-Sha256") === hash) return;
		// "reload": from the server, never the HTTP cache, which may hold this
		// file from another build.
		const r = await fetch(at(name), { cache: "reload" });
		if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
		const bytes = await r.arrayBuffer();
		const got = await sha256(bytes);
		if (got !== hash) throw new Error(`${name} has sha-256 ${got}; ${MANIFEST} says ${hash}`);
		await cache.put(at(name), new Response(bytes, {
			headers: {
				"Content-Type": r.headers.get("Content-Type") || "application/octet-stream",
				// Which build answered, for tools/headless/pwa_check.py.
				"X-Dabo-Build": m.id,
				"X-Dabo-Sha256": hash,
			},
		}));
	}));
	await cache.put(at(MANIFEST), new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json" } }));
}

// Whether build `id` has every file: whether its mark is there.
async function complete(id) {
	return !!id && !!(await caches.match(at(MANIFEST), { cacheName: buildName(id) }));
}

async function sha256(bytes) {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readState() {
	try {
		const r = await caches.match(STATE_URL, { cacheName: STATE });
		const s = r ? await r.json() : {};
		return { current: s.current || null, ready: s.ready || null };
	} catch (e) {
		return { current: null, ready: null };
	}
}

async function writeState(s) {
	const cache = await caches.open(STATE);
	await cache.put(STATE_URL, new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } }));
}

// Changes to the state, and swap()'s deletions, one at a time. Two workers can
// run at once, one installing while another serves, so where the browser has
// a lock that both can see (Web Locks), that is the one taken.
let queue = Promise.resolve();

function locked(fn) {
	if (self.navigator && navigator.locks) return navigator.locks.request(NS + " lock", fn);
	const run = queue.then(fn);
	queue = run.catch(() => {});
	return run;
}
