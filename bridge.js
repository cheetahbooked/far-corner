// The imports behind `foreign import "far_corner"` in app/bridge.odin.
// build.ps1 overwrites odin.js on every build, so all of our JS lives here.
//
// What is kept: one record per rep, the JSON text exactly as src/library
// encoded it, under the rep's id. The id starts with the rep's start time in ms
// (13 digits until the year 2286), so sorting ids as strings sorts the reps by
// time.
//
// Where: IndexedDB, database "dabo", object store "reps", the id as the key and
// the text as the value. localStorage has about 5 MB an origin, a few thousand
// reps; IndexedDB has what the disk has. But wasm imports are synchronous calls
// and IndexedDB answers only through callbacks, and the one thing the app must
// know in the frame it matters is whether the save it just made is safe. So:
//
//   - Every rep is also held here in memory, read in before the module starts
//     (`farCornerStore.open`, which index.html awaits), and every read the
//     app makes is answered from memory, synchronously.
//   - A save goes first to localStorage, "dabo/rep/<id>", which is synchronous,
//     and that write is what `store_put` answers. Then to IndexedDB, and when
//     that transaction completes the localStorage key is removed if it still
//     holds the same text. localStorage is an outbox: what is in it is never
//     older than IndexedDB's copy, so a load merges it in over IndexedDB and
//     sends it on. Reps kept before IndexedDB are an outbox nobody drained,
//     and move across the same way.
//   - Where IndexedDB cannot be had (missing, refused, or never answering, as
//     some Safari versions do), localStorage is the store.
//
// The problem editor's settings ("dabo/settings") and the settings sheet's
// preferences ("dabo/prefs": Tips, the 3D view's tilt, what the learner has
// learned) stay in localStorage, outside the rep prefix, so that export and
// the rep count never see them. Neither is part of a record.
//
// Nothing here throws into wasm: storage that is missing or refuses (private
// mode, quota) is a `false`, a zero or a -1.
"use strict";

(() => {
	const PREFIX = "dabo/rep/";
	const SETTINGS = "dabo/settings";
	const PREFS = "dabo/prefs";
	// The largest id in the last export, so that the settings sheet can say how
	// many reps no export holds yet.
	const EXPORTED = "dabo/exported";
	const DB_NAME = "dabo";
	const DB_STORE = "reps";
	// How long the page waits for IndexedDB before starting without it. Some
	// Safari versions never answer `indexedDB.open`; a phone reading a few
	// thousand reps answers well inside this.
	const OPEN_TIMEOUT_MS = 4000;

	// `store_status`, bit by bit: app/storage.odin's Store_Flag, whose positions
	// these must stay.
	const STATUS = {
		indexedDB: 1 << 0,
		persisted: 1 << 1,
		standalone: 1 << 2,
		appleMobile: 1 << 3,
		secure: 1 << 4,
		writeFailed: 1 << 5,
	};

	const storage = () => {
		try { return window.localStorage; } catch (e) { return null; }
	};

	const safely = (f, otherwise) => {
		try { return f(); } catch (e) { return otherwise; }
	};

	// An iPhone or iPod, or an iPad, which since iPadOS 13 says it is a Mac
	// and gives itself away by its touch points.
	const appleMobile = safely(() => /iPhone|iPod|iPad/.test(navigator.userAgent) ||
		(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1), false);
	const standaloneQueries = safely(() => ["standalone", "fullscreen", "minimal-ui"]
		.map((m) => window.matchMedia("(display-mode: " + m + ")")), []);
	const standalone = () => safely(() => navigator.standalone === true || standaloneQueries.some((q) => q.matches), false);

	// The store the page is using, for the debug accessors.
	let current = null;

	// ---------------------------------------------------------------------
	// IndexedDB
	// ---------------------------------------------------------------------

	// The database, made on first use. Opened at whatever version it is, so
	// that a later version of this file can upgrade it without an older tab
	// being refused; one that has no "reps" store (made by something that only
	// opened it to look) is opened again a version up, and given one. Rejects
	// when IndexedDB is missing or refuses; never settles when it never answers.
	const openDatabase = (version) => new Promise((resolve, reject) => {
		const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
		};
		req.onsuccess = () => {
			const db = req.result;
			if (db.objectStoreNames.contains(DB_STORE)) {
				resolve(db);
				return;
			}
			const next = db.version + 1;
			db.close();
			openDatabase(next).then(resolve, reject);
		};
		req.onerror = () => reject(req.error);
	});

	// Every [id, text] in the database. Anything that is not a string under a
	// string is not ours and is left where it is.
	const readAll = (db) => new Promise((resolve, reject) => {
		const tx = db.transaction(DB_STORE, "readonly");
		const os = tx.objectStore(DB_STORE);
		const keys = os.getAllKeys();
		const values = os.getAll();
		tx.oncomplete = () => {
			const out = [];
			for (let i = 0; i < keys.result.length; i++) {
				const k = keys.result[i], v = values.result[i];
				if (typeof k === "string" && typeof v === "string") out.push([k, v]);
			}
			resolve(out);
		};
		tx.onabort = () => reject(tx.error);
	});

	// ---------------------------------------------------------------------
	// The store
	// ---------------------------------------------------------------------

	// Every rep in memory, `db` behind it (null for localStorage alone),
	// starting from what `db` held, with the outbox merged over it and sent on.
	const makeStore = (database, stored) => {
		let db = database;
		let persisted = false;
		let askedToPersist = false;
		let writeFailed = false;
		let exported = "";
		const texts = new Map();
		const ids = []; // sorted, so an index is a place in time order
		// IndexedDB transactions not yet over, and who is waiting for none.
		let writing = 0;
		let waiting = [];

		// Where `id` is in `ids`, or would go.
		const place = (id) => {
			let lo = 0, hi = ids.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (ids[mid] < id) lo = mid + 1; else hi = mid;
			}
			return lo;
		};

		const remember = (id, text) => {
			if (!texts.has(id)) ids.splice(place(id), 0, id);
			texts.set(id, text);
		};

		const settle = () => {
			if (writing > 0) return;
			const w = waiting;
			waiting = [];
			for (const f of w) f();
		};

		// IndexedDB holds `text` for `id` now, so the outbox copy can go, unless
		// a newer save has landed in it meanwhile.
		const unqueue = (id, text) => {
			try {
				const ls = storage();
				if (ls && ls.getItem(PREFIX + id) === text) ls.removeItem(PREFIX + id);
			} catch (e) { /* still in the outbox: sent again at the next load */ }
		};

		// [id, text, fromOutbox] into IndexedDB, in one transaction. A failure
		// is kept for the status and costs nothing else: what came from the
		// outbox is still in it.
		const write = (entries) => {
			if (!db || entries.length === 0) return;
			writing++;
			let tx = null;
			try {
				// Strict: complete means on disk, not just handed to the OS.
				// Chrome's default is relaxed, and completion is what lets the
				// outbox copy go. Browsers without the option ignore it.
				tx = db.transaction(DB_STORE, "readwrite", { durability: "strict" });
				const os = tx.objectStore(DB_STORE);
				for (const [id, text] of entries) os.put(text, id);
			} catch (e) {
				console.warn("far corner: IndexedDB write failed", e);
				writeFailed = true;
				if (tx) safely(() => tx.abort());
				writing--;
				settle();
				return;
			}
			tx.oncomplete = () => {
				for (const [id, text, outbox] of entries) if (outbox) unqueue(id, text);
				writing--;
				settle();
			};
			// An error aborts the transaction, so this is the one place a
			// failure lands.
			tx.onabort = () => {
				console.warn("far corner: IndexedDB write failed", tx.error);
				writeFailed = true;
				writing--;
				settle();
			};
		};

		// Asked once, after the first save that worked: by then the learner has
		// drawn something worth keeping, and the save is inside their gesture.
		// Chrome answers from how the site is used, without asking; Firefox
		// asks the learner, once.
		const askToPersist = () => {
			if (persisted || askedToPersist) return;
			askedToPersist = true;
			try {
				if (navigator.storage && navigator.storage.persist) {
					navigator.storage.persist().then((p) => { persisted = persisted || p; }, () => {});
				}
			} catch (e) { /* no StorageManager: insecure context, or an old browser */ }
		};

		for (const [id, text] of stored) remember(id, text);
		const outbox = [];
		try {
			const ls = storage();
			if (ls) {
				for (let i = 0; i < ls.length; i++) {
					const k = ls.key(i);
					if (k === null || !k.startsWith(PREFIX)) continue;
					const v = ls.getItem(k);
					if (v === null) continue;
					const id = k.slice(PREFIX.length);
					remember(id, v);
					outbox.push([id, v, true]);
				}
				exported = ls.getItem(EXPORTED) || "";
			}
		} catch (e) { /* no localStorage: IndexedDB alone, or nothing */ }

		if (db) {
			// Another page wants the database deleted or upgraded (the headless
			// checks delete it between runs), or the browser has taken it away:
			// let go, and save to the outbox alone, which the next load sends on.
			db.onversionchange = () => {
				safely(() => db.close());
				db = null;
			};
			db.onclose = () => { db = null; };
			write(outbox);
		}
		try {
			if (navigator.storage && navigator.storage.persisted) {
				navigator.storage.persisted().then((p) => { persisted = persisted || p; }, () => {});
			}
		} catch (e) { /* as in askToPersist */ }

		// Another tab's saves, as they land in its outbox, and its exports. Its
		// removals are its outbox draining into IndexedDB and change nothing
		// here. (A tab is not told of its own writes.)
		window.addEventListener("storage", (e) => {
			try {
				if (e.storageArea !== storage() || e.key === null || e.newValue === null) return;
				if (e.key.startsWith(PREFIX)) remember(e.key.slice(PREFIX.length), e.newValue);
				else if (e.key === EXPORTED && e.newValue > exported) exported = e.newValue;
			} catch (err) { /* nothing of ours */ }
		});

		return {
			// A save from the app. True only when localStorage took it: that is
			// the write that is over when this returns. With IndexedDB in use, a
			// save localStorage refused (full) still goes there, but the app is
			// told false and shows its mark, which can be one warning too many
			// and never one too few.
			put: (id, text) => {
				let saved = false;
				const ls = storage();
				if (ls) {
					try {
						ls.setItem(PREFIX + id, text);
						saved = true;
					} catch (e) {
						// An older copy still in the outbox would win over this one
						// at the next load, and memory and IndexedDB have the newer.
						if (db) safely(() => ls.removeItem(PREFIX + id));
					}
				}
				remember(id, text);
				write([[id, text, saved]]);
				if (saved) askToPersist();
				return saved;
			},

			// A record from an imported file: into memory and IndexedDB, not
			// through the outbox, since the file it came from still exists. Only
			// an outbox copy of the same id already waiting is written over, or
			// it would win over this one at the next load. Without IndexedDB,
			// localStorage is the store, and false means it did not take it.
			take: (id, text) => {
				const ls = storage();
				if (!db) {
					try {
						ls.setItem(PREFIX + id, text);
					} catch (e) {
						return false;
					}
					remember(id, text);
					return true;
				}
				let outbox = false;
				try {
					if (ls && ls.getItem(PREFIX + id) !== null) {
						try {
							ls.setItem(PREFIX + id, text);
							outbox = true;
						} catch (e) {
							ls.removeItem(PREFIX + id);
						}
					}
				} catch (e) { /* no outbox copy to mind */ }
				remember(id, text);
				write([[id, text, outbox]]);
				return true;
			},

			count: () => ids.length,
			idAt: (index) => ids[index],
			get: (id) => (texts.has(id) ? texts.get(id) : null),
			ids: () => ids.slice(),
			indexOf: (id) => {
				const i = place(id);
				return ids[i] === id ? i : -1;
			},

			// Reps newer than the newest in the last export.
			unexported: () => {
				let i = place(exported);
				if (ids[i] === exported) i++;
				return ids.length - i;
			},
			markExported: (id) => {
				if (id <= exported) return;
				exported = id;
				safely(() => storage().setItem(EXPORTED, id));
			},

			status: () => {
				let s = 0;
				if (db) s |= STATUS.indexedDB;
				if (persisted) s |= STATUS.persisted;
				if (standalone()) s |= STATUS.standalone;
				if (appleMobile) s |= STATUS.appleMobile;
				if (safely(() => window.isSecureContext === true, false)) s |= STATUS.secure;
				if (writeFailed) s |= STATUS.writeFailed;
				return s;
			},

			// Every rep's text in time order, for an export. A text that does not
			// parse is left out and counted rather than costing the learner the
			// rest. The texts go in as they are kept, not parsed and printed
			// again: JSON.stringify writes -0 as 0, and a record keeps every
			// float's bits (src/library).
			bundle: () => {
				const parts = [];
				let skipped = 0, last = "";
				for (const id of ids) {
					const v = texts.get(id);
					try {
						JSON.parse(v);
					} catch (e) {
						skipped++;
						continue;
					}
					parts.push(v.trim());
					last = id;
				}
				return { parts, skipped, last };
			},

			// Settles once every IndexedDB write asked for so far is over.
			drained: () => (writing === 0 ? Promise.resolve() : new Promise((r) => waiting.push(r))),
		};
	};

	window.farCornerStore = {
		// Every stored rep, read in, before the module starts. Never rejects:
		// without IndexedDB, or when it takes longer than OPEN_TIMEOUT_MS, the
		// store is localStorage alone.
		open: async () => {
			const opened = await new Promise((resolve) => {
				let over = false;
				const timer = setTimeout(() => {
					over = true;
					console.warn("far corner: IndexedDB did not answer; keeping reps in localStorage");
					resolve(null);
				}, OPEN_TIMEOUT_MS);
				(async () => {
					const db = await openDatabase();
					try {
						const stored = await readAll(db);
						if (over) {
							db.close(); // too late: this page load has started without it
							return;
						}
						over = true;
						clearTimeout(timer);
						resolve({ db, stored });
					} catch (e) {
						db.close();
						throw e;
					}
				})().catch((e) => {
					if (over) return;
					over = true;
					clearTimeout(timer);
					console.warn("far corner: no IndexedDB; keeping reps in localStorage", e);
					resolve(null);
				});
			});
			current = opened ? makeStore(opened.db, opened.stored) : makeStore(null, []);
			return current;
		},

		// Read-only views of the store the page is using, for tools/headless.
		// Nothing here changes what is kept.
		debug: {
			ids: () => (current ? current.ids() : []),
			get: (id) => (current ? current.get(id) : null),
			status: () => (current ? current.status() : 0),
			unexported: () => (current ? current.unexported() : 0),
			drained: () => (current ? current.drained() : Promise.resolve()),
		},
	};

	window.farCornerBridge = (mem, store) => {
		// A page that did not open a store first gets localStorage alone.
		if (!store) store = current = makeStore(null, []);

		// One per page load. Opaque to everything that reads it.
		const session = (() => {
			try {
				if (crypto.randomUUID) return crypto.randomUUID();
			} catch (e) { /* insecure context: fall through */ }
			let s = "";
			for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
			return s;
		})();

		// Copies `text` as UTF-8 into wasm memory; the byte count, or -1 if it does
		// not fit in `cap`. Nothing is written when it does not fit.
		const copyOut = (text, buf, cap) => {
			const bytes = new TextEncoder().encode(text);
			if (bytes.length > Number(cap)) return -1;
			mem.loadBytes(buf, bytes.length).set(bytes);
			return bytes.length;
		};

		// The bytes measured by the last `*_len` call, kept for the call that
		// copies them, so that the two cannot see different strings.
		let pending = null;
		const takePending = (buf, cap) => {
			const bytes = pending;
			pending = null;
			if (bytes === null || bytes.length > Number(cap)) return -1;
			mem.loadBytes(buf, bytes.length).set(bytes);
			return bytes.length;
		};

		const download = (blob, name) => {
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.style.display = "none";
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 10000);
		};

		// Records read from the files the learner picked, waiting for the app
		// to take them one at a time, and the files that held nothing that
		// could be one.
		const incoming = [];
		let unreadable = 0;
		let picker = null;

		// The text of each element of the array under `key` in the JSON object
		// `text`, which JSON.parse has already accepted, so the scan can trust
		// its shape. Kept as text for the reason `bundle` keeps it.
		const rawElements = (text, key) => {
			const out = [];
			let depth = 0, str = null, name = null, collecting = false, from = 0;
			for (let i = 0; i < text.length; i++) {
				const c = text[i];
				if (c === '"') {
					const s = i;
					for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
					str = text.slice(s, i + 1);
				} else if (c === ":" && depth === 1) {
					name = JSON.parse(str);
				} else if (c === "[" || c === "{") {
					depth++;
					if (depth === 2 && c === "[" && name === key) {
						collecting = true;
						from = i + 1;
					}
				} else if (c === "]" || c === "}") {
					if (collecting && depth === 2) {
						const last = text.slice(from, i).trim();
						if (last !== "") out.push(last);
						return out;
					}
					depth--;
				} else if (c === "," && collecting && depth === 2) {
					out.push(text.slice(from, i).trim());
					from = i + 1;
				}
			}
			return null;
		};

		// A picked file: an export (see src/library's header), each of whose
		// reps is queued, or any other object, queued as a record. Only the
		// file's shape is judged here; what is a record is src/library's to say.
		const readFile = (text) => {
			let doc;
			try {
				doc = JSON.parse(text);
			} catch (e) {
				unreadable++;
				return;
			}
			if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
				unreadable++;
				return;
			}
			if (!("dabo_export" in doc)) {
				incoming.push(text);
				return;
			}
			if (doc.dabo_export !== 1 || !Array.isArray(doc.reps)) {
				unreadable++;
				return;
			}
			let raw = safely(() => rawElements(text, "reps"), null);
			if (raw === null || raw.length !== doc.reps.length) raw = doc.reps.map((r) => JSON.stringify(r));
			for (const r of raw) incoming.push(r);
		};

		return {
			far_corner: {
				now_ms: () => Date.now(),

				// Whether the URL has `?dev=<name>` (the parameter may be
				// repeated). Only debug builds call it.
				dev_flag: (name_ptr, name_len) => {
					try {
						return new URLSearchParams(location.search).getAll("dev").includes(mem.loadString(name_ptr, name_len));
					} catch (e) {
						return false;
					}
				},

				session_id: (buf, cap) => copyOut(session, buf, cap),

				// The problem editor's settings (app/setup.odin): one value under
				// "dabo/settings". It holds both what the editor is setting and
				// what Start put in use, so the two are written together. False
				// when it was NOT stored.
				settings_put: (value_ptr, value_len) => {
					try {
						const ls = storage();
						if (!ls) return false;
						ls.setItem(SETTINGS, mem.loadString(value_ptr, value_len));
						return true;
					} catch (e) {
						return false;
					}
				},
				// The stored settings as UTF-8 into `buf`: the byte count, 0 for none,
				// -1 when they do not fit in `cap`.
				settings_get: (buf, cap) => {
					try {
						const ls = storage();
						const v = ls ? ls.getItem(SETTINGS) : null;
						return v === null ? 0 : copyOut(v, buf, cap);
					} catch (e) {
						return 0;
					}
				},

				// The settings sheet's preferences (`Prefs`), one value under
				// "dabo/prefs". Returns as `settings_put` and `settings_get` do.
				prefs_put: (value_ptr, value_len) => {
					try {
						const ls = storage();
						if (!ls) return false;
						ls.setItem(PREFS, mem.loadString(value_ptr, value_len));
						return true;
					} catch (e) {
						return false;
					}
				},
				prefs_get: (buf, cap) => {
					try {
						const ls = storage();
						const v = ls ? ls.getItem(PREFS) : null;
						return v === null ? 0 : copyOut(v, buf, cap);
					} catch (e) {
						return 0;
					}
				},

				// One record per rep; putting the same id again overwrites. False
				// when the save is NOT safe yet: localStorage refused it (quota,
				// or none at all). See `put`.
				store_put: (key_ptr, key_len, value_ptr, value_len) => {
					try {
						return store.put(mem.loadString(key_ptr, key_len), mem.loadString(value_ptr, value_len));
					} catch (e) {
						return false;
					}
				},

				store_count: () => store.count(),

				// Two-call read, by position in time order (0 is the oldest): the
				// UTF-8 byte length first, so the caller can allocate, then the
				// bytes. -1 when there is no such rep.
				store_get_len: (index) => {
					pending = null;
					try {
						const id = store.idAt(Number(index));
						if (id === undefined) return -1;
						pending = new TextEncoder().encode(store.get(id));
						return pending.length;
					} catch (e) {
						return -1;
					}
				},
				store_get: takePending,

				// Where the rep `id` is in time order, -1 when it is not kept.
				store_index_of: (id_ptr, id_len) => {
					try {
						return store.indexOf(mem.loadString(id_ptr, id_len));
					} catch (e) {
						return -1;
					}
				},

				// Store_Flag bits (app/storage.odin): where reps are kept and
				// what the browser has said about keeping them.
				store_status: () => {
					try {
						return store.status();
					} catch (e) {
						return 0;
					}
				},

				// Reps newer than the newest in the last export.
				store_unexported: () => {
					try {
						return store.unexported();
					} catch (e) {
						return 0;
					}
				},

				// A record from an import, over whatever is kept under its id. See
				// `take`.
				store_import: (key_ptr, key_len, value_ptr, value_len) => {
					try {
						return store.take(mem.loadString(key_ptr, key_len), mem.loadString(value_ptr, value_len));
					} catch (e) {
						return false;
					}
				},

				// Every kept rep as one file, off the phone. Must be reached from
				// a user gesture (the app calls it inside its pointer-up handler,
				// which odin.js runs synchronously inside the DOM event): the share
				// sheet refuses otherwise. Returns the number of reps in the bundle,
				// 0 when there was nothing to export, -1 when it could not be built.
				// Once the file is out of the page (shared, or downloaded) the
				// newest id in it is the export watermark.
				export_all: () => {
					try {
						const { parts, skipped, last } = store.bundle();
						if (parts.length === 0) return 0;
						let text = '{"dabo_export": 1, "exported_at": ' + Date.now();
						if (skipped > 0) text += ', "skipped": ' + skipped;
						text += ', "reps": [\n' + parts.join(",\n") + "\n]}\n";
						const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
						const name = "far-corner-export-" + stamp + ".json";
						const out = () => store.markExported(last);

						let shared = false;
						try {
							const file = new File([text], name, { type: "application/json" });
							if (navigator.canShare && navigator.canShare({ files: [file] })) {
								shared = true;
								navigator.share({ files: [file], title: name }).then(out, (e) => {
									// Dismissing the sheet is an answer, not a failure.
									if (e && e.name === "AbortError") return;
									download(new Blob([text], { type: "application/json" }), name);
									out();
								});
							}
						} catch (e) {
							shared = false;
						}
						if (!shared) {
							download(new Blob([text], { type: "application/json" }), name);
							out();
						}
						return parts.length;
					} catch (e) {
						console.warn("far corner export failed", e);
						return -1;
					}
				},

				// The file picker, for exports to read back in. Like `export_all`,
				// only from inside a user gesture: browsers open it for no one
				// else. What the learner picks arrives later, a record at a time,
				// through `import_next_len` and `import_next`. False when there
				// is no picker to open.
				import_open: () => {
					try {
						if (!picker) {
							picker = document.createElement("input");
							picker.type = "file";
							picker.accept = ".json,application/json";
							picker.multiple = true;
							// Out of sight rather than display:none, which some
							// WebKit versions will not open a picker for.
							picker.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0";
							picker.addEventListener("change", () => {
								const files = Array.from(picker.files || []);
								picker.value = ""; // the same file picked again is a change too
								for (const f of files) {
									(f.text ? f.text() : new Response(f).text()).then(readFile, () => { unreadable++; });
								}
							});
							document.body.appendChild(picker);
						}
						picker.value = "";
						picker.click();
						return true;
					} catch (e) {
						console.warn("far corner import failed", e);
						return false;
					}
				},

				// Two-call read of the next record waiting from an import, as
				// `store_get_len` and `store_get`: its UTF-8 byte length, taking it
				// off the queue, then its bytes. -1 when none is waiting.
				import_next_len: () => {
					pending = null;
					if (incoming.length === 0) return -1;
					try {
						pending = new TextEncoder().encode(incoming.shift());
						return pending.length;
					} catch (e) {
						return -1;
					}
				},
				import_next: takePending,

				// Picked files that were not JSON, or neither an export nor an
				// object, since the last call.
				import_unreadable: () => {
					const n = unreadable;
					unreadable = 0;
					return n;
				},
			},
		};
	};
})();
