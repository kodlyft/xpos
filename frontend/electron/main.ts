import { app, BrowserWindow, ipcMain, shell, session, Menu } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { initDatabase, closeDatabase } from "./database/dbService";
import { registerDbHandlers } from "./database/ipcHandlers";
import { initRealtimeStock, disconnectRealtime } from "./sync/realtimeStock";
import { initSyncEngine, stopSyncEngine, updateSyncContext, runSyncCyclePublic } from "./sync/syncEngine";
import { initAutoUpdater, stopAutoUpdater } from "./autoUpdater";
import { startHubServer, stopHubServer, getHubApiSecret } from "./hub/hubServer";
import { initTillClient, runTillSync, pingHub } from "./hub/tillClient";
import { type NodeRole } from "./hub/nodeConfig";
import { getMeta, setMeta } from "./database/dbService";
import { createLogger, getLogDir } from "./logger";

const log = createLogger("Main");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function sendMainError(message: string, stack?: string): void {
	try {
		mainWindow?.webContents.send("main-process-error", { message, stack });
	} catch {
		// Window may be gone or not yet created file log above still captured it.
	}
}

process.on("uncaughtException", (err) => {
	log.error("Uncaught exception", { message: err.message, stack: err.stack });
	sendMainError(err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
	log.error("Unhandled rejection", { reason: String(reason) });
	sendMainError(
		reason instanceof Error ? reason.message : String(reason),
		reason instanceof Error ? reason.stack : undefined,
	);
});

const SERVER_URL = process.env.XPOS_SERVER_URL || "http://localhost:8000";

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 1024,
		minHeight: 600,
		title: "X POS",
		...(process.platform === "linux"
			? {
					icon: path.join(__dirname, "../build/icon.png"),
				}
			: {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
		autoHideMenuBar: false,
		show: false,
	});

	// Remove the native menu bar entirely - we use our own in-app menu
	mainWindow.setMenu(null);

	mainWindow.once("ready-to-show", () => {
		mainWindow?.maximize();
		mainWindow?.show();
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http")) {
			shell.openExternal(url);
		}
		return { action: "deny" };
	});

	if (process.env.VITE_DEV_SERVER_URL) {
		mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
		mainWindow.webContents.openDevTools({ mode: "detach" });
	} else {
		mainWindow.loadFile(path.join(__dirname, "../dist/index.electron.html"));
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

ipcMain.handle("app:is-first-run", async () => {
	try {
		const role = await getMeta("node_role");
		return !role;
	} catch {
		return true;
	}
});

ipcMain.handle(
	"app:test-erpnext",
	async (
		_event,
		config: {
			url: string;
			apiKey?: string;
			apiSecret?: string;
		},
	) => {
		try {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (config.apiKey && config.apiSecret) {
				headers["Authorization"] = `token ${config.apiKey}:${config.apiSecret}`;
			}
			const resp = await fetch(`${config.url}/api/method/frappe.ping`, { headers });
			if (resp.ok) return { success: true };
			return { success: false, error: `Server returned status ${resp.status}` };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : "Connection failed" };
		}
	},
);

ipcMain.handle("get-server-url", async () => {
	if (process.env.XPOS_SERVER_URL && process.env.XPOS_SERVER_URL !== "http://localhost:8000") {
		return process.env.XPOS_SERVER_URL;
	}
	try {
		const saved = await getMeta("server_url");
		if (saved) {
			process.env.XPOS_SERVER_URL = saved;
			return saved;
		}
	} catch {
		/* DB not ready yet */
	}
	return SERVER_URL;
});

ipcMain.handle("get-platform-info", () => ({
	platform: process.platform,
	arch: process.arch,
	version: app.getVersion(),
	isElectron: true,
	logDir: getLogDir(),
}));

ipcMain.handle("logs:list", () => {
	try {
		return fs
			.readdirSync(getLogDir())
			.filter((f) => f.startsWith("xpos-") && f.endsWith(".log"))
			.sort()
			.reverse();
	} catch {
		return [];
	}
});

ipcMain.handle("logs:read", (_event, name: string) => {
	try {
		if (!/^xpos-[\w-]+\.log$/.test(name)) return "";
		const file = path.join(getLogDir(), name);
		const stat = fs.statSync(file);
		const MAX_BYTES = 200 * 1024;
		if (stat.size <= MAX_BYTES) return fs.readFileSync(file, "utf8");
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(MAX_BYTES);
			fs.readSync(fd, buf, 0, MAX_BYTES, stat.size - MAX_BYTES);
			return "…(truncated)…\n" + buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
});

ipcMain.handle("check-mariadb", async () => {
	const bins: string[] =
		process.platform === "win32"
			? ["mariadb", "mysql"]
			: [
					"/usr/bin/mariadb",
					"/usr/local/bin/mariadb",
					"mariadb",
					"/usr/bin/mysql",
					"/usr/local/bin/mysql",
					"mysql",
				];

	if (process.platform === "win32") {
		const pfDirs = [
			process.env["ProgramFiles"] || "C:\\Program Files",
			process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
			process.env["ProgramW6432"] || "C:\\Program Files",
		].filter((v, i, a) => a.indexOf(v) === i);

		for (const base of pfDirs) {
			try {
				const entries = fs.readdirSync(base);
				for (const entry of entries) {
					const lower = entry.toLowerCase();
					if (lower.startsWith("mariadb") || lower.startsWith("mysql")) {
						for (const binName of ["mariadb.exe", "mysql.exe"]) {
							const fullPath = path.join(base, entry, "bin", binName);
							if (fs.existsSync(fullPath)) bins.push(fullPath);
						}
					}
				}
			} catch {
				/* ignore */
			}
		}
	}

	for (const bin of bins) {
		try {
			const version = await new Promise<string>((resolve, reject) => {
				execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
					if (err) reject(err);
					else resolve(stdout.trim());
				});
			});
			return { installed: true, version, binary: bin };
		} catch {
			continue;
		}
	}
	return { installed: false, version: null, binary: null };
});

ipcMain.handle("set-server-url", async (_event, url: string) => {
	process.env.XPOS_SERVER_URL = url;
	try {
		await setMeta("server_url", url); // persist so it survives restarts
	} catch {
		/* DB may not be ready during setup */
	}
	return true;
});

ipcMain.handle(
	"set-auth-cookie",
	async (_event, cookies: { name: string; value: string; domain: string }[]) => {
		const ses = session.defaultSession;
		for (const cookie of cookies) {
			await ses.cookies.set({
				url: SERVER_URL,
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
			});
		}
		return true;
	},
);

ipcMain.handle("clear-auth", async () => {
	const ses = session.defaultSession;
	const cookies = await ses.cookies.get({ url: SERVER_URL });
	for (const cookie of cookies) {
		await ses.cookies.remove(SERVER_URL, cookie.name);
	}
	disconnectRealtime();
	stopSyncEngine();
	return true;
});

let syncEngineStarted = false;

ipcMain.handle(
	"start-sync-engine",
	async (
		_event,
		opts?: {
			csrfToken?: string;
			sessionCookies?: string;
		},
	) => {
		if (currentRole !== "hub") return { success: false, error: "Sync engine is hub-only" };
		try {
			const savedUrl = await getMeta("server_url");
			const serverUrl = savedUrl || process.env.XPOS_SERVER_URL || SERVER_URL;

			const storedApiKey = await getMeta("api_key");
			const storedApiSecret = await getMeta("api_secret");

			log.info(
				`Sync engine start - url: ${serverUrl}, apiKey: ${storedApiKey ? "set" : "missing"}, apiSecret: ${storedApiSecret ? "set" : "missing"}`,
			);

			let cookieStr = opts?.sessionCookies || "";
			let csrfToken = opts?.csrfToken || "";
			if (!storedApiKey && !cookieStr) {
				const ses = session.defaultSession;
				const cookies = await ses.cookies.get({ url: serverUrl });
				cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
			}

			const ctx = {
				serverUrl,
				csrfToken,
				sessionCookies: cookieStr,
				apiKey: storedApiKey || undefined,
				apiSecret: storedApiSecret || undefined,
			};

			if (syncEngineStarted) {
				updateSyncContext(ctx);
			} else {
				initSyncEngine(ctx);
				syncEngineStarted = true;
			}

			setTimeout(() => {
				runSyncCyclePublic();
			}, 1000);

			return { success: true };
		} catch (err) {
			log.error("start-sync-engine failed", err);
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
);

ipcMain.handle("start-realtime", async () => {
	try {
		await initRealtimeStock(process.env.XPOS_SERVER_URL || SERVER_URL);
		return true;
	} catch {
		return false;
	}
});

let currentRole: NodeRole = "hub";
let tillSyncInterval: ReturnType<typeof setInterval> | null = null;

ipcMain.handle("node:get-role", () => currentRole);

ipcMain.handle(
	"node:set-role",
	async (
		_event,
		config: {
			role: NodeRole;
			hubUrl?: string;
			tillId?: string;
			hubApiPort?: number;
			hubSecret?: string;
		},
	) => {
		try {
			currentRole = config.role;
			await setMeta("node_role", config.role);

			if (config.role === "hub") {
				if (tillSyncInterval) {
					clearInterval(tillSyncInterval);
					tillSyncInterval = null;
				}
				const port = config.hubApiPort || 6789;
				await setMeta("hub_api_port", String(port));
				await startHubServer(port);
			} else {
				await stopHubServer();
				const hubUrl = config.hubUrl || "http://localhost:6789";
				const tillId = config.tillId || "TILL-01";
				await setMeta("hub_url", hubUrl);
				await setMeta("till_id", tillId);
				if (config.hubSecret) {
					await setMeta("hub_api_secret", config.hubSecret);
				}
				await initTillClient(hubUrl, tillId);
				if (tillSyncInterval) clearInterval(tillSyncInterval);
				tillSyncInterval = setInterval(async () => {
					try {
						await runTillSync();
					} catch (e) {
						log.error("Till sync failed", e instanceof Error ? e.message : e);
					}
				}, 30_000);
			}
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
);

ipcMain.handle("node:get-hub-secret", async () => {
	if (currentRole !== "hub") return null;
	return getHubApiSecret();
});

ipcMain.handle("node:ping-hub", async () => pingHub());

ipcMain.handle("node:trigger-till-sync", async () => {
	try {
		const result = await runTillSync();
		return { success: true, ...result };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
});

ipcMain.handle(
	"print:invoice",
	async (
		_event,
		data: {
			localId: number;
			data: unknown;
			customerName: string;
			grandTotal: number;
			isReturn: boolean;
			printFormat: string;
			letterHead: string;
			companyName: string;
		},
	) => {
		try {
			const win = BrowserWindow.getFocusedWindow();
			if (!win) {
				return { success: false, error: "No active window" };
			}

			// Generate print HTML from invoice data
			const invoiceData = data.data as Record<string, unknown>;
			const items = (invoiceData.items || []) as Array<{
				item_code: string;
				item_name: string;
				qty: number;
				rate: number;
				amount: number;
			}>;

			const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Invoice #${data.localId}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; font-size: 12px; }
          .header { text-align: center; margin-bottom: 20px; }
          .company { font-size: 16px; font-weight: bold; }
          .divider { border-top: 1px dashed #000; margin: 10px 0; }
          .row { display: flex; justify-content: space-between; margin: 5px 0; }
          .items { margin: 10px 0; }
          .item { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 5px; margin: 5px 0; }
          .total { font-weight: bold; font-size: 14px; }
          .footer { text-align: center; margin-top: 20px; font-size: 10px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="company">${data.companyName || "XPOS"}</div>
          <div>${data.isReturn ? "RETURN" : "INVOICE"}</div>
          <div>Local #${data.localId}</div>
          <div>${new Date().toLocaleString()}</div>
        </div>
        <div class="divider"></div>
        <div class="row">
          <span>Customer:</span>
          <span>${data.customerName || "Walk-in Customer"}</span>
        </div>
        <div class="divider"></div>
        <div class="items">
          <div class="item" style="font-weight: bold;">
            <span>Item</span><span>Qty</span><span>Rate</span><span>Amount</span>
          </div>
          ${items
				.map(
					(item) => `
            <div class="item">
              <span>${item.item_name || item.item_code}</span>
              <span>${item.qty}</span>
              <span>${item.rate?.toFixed(2)}</span>
              <span>${item.amount?.toFixed(2)}</span>
            </div>
          `,
				)
				.join("")}
        </div>
        <div class="divider"></div>
        <div class="row total">
          <span>Grand Total:</span>
          <span>${data.grandTotal?.toFixed(2)}</span>
        </div>
        <div class="footer">
          <p>Thank you for your business!</p>
          <p>This invoice will sync to server automatically.</p>
        </div>
      </body>
      </html>
    `;

			const printWin = new BrowserWindow({
				show: false,
				webPreferences: { nodeIntegration: false, contextIsolation: true },
			});

			await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

			return new Promise((resolve) => {
				printWin.webContents.print(
					{ silent: false, printBackground: true },
					(success, failureReason) => {
						printWin.close();
						if (success) {
							resolve({ success: true });
						} else {
							resolve({ success: false, error: failureReason || "Print failed" });
						}
					},
				);
			});
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
);

ipcMain.handle(
	"print:report",
	async (
		_event,
		html: string,
		options?: {
			landscape?: boolean;
			margins?: Record<string, number>;
		},
	) => {
		try {
			const printWin = new BrowserWindow({
				show: false,
				webPreferences: { nodeIntegration: false, contextIsolation: true },
			});

			await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

			return new Promise((resolve) => {
				printWin.webContents.print(
					{
						silent: false,
						printBackground: true,
						landscape: options?.landscape ?? false,
						margins: options?.margins
							? {
									marginType: "custom",
									top: options.margins.top ?? 10,
									bottom: options.margins.bottom ?? 10,
									left: options.margins.left ?? 10,
									right: options.margins.right ?? 10,
								}
							: undefined,
					},
					(success, failureReason) => {
						printWin.close();
						if (success) {
							resolve({ success: true });
						} else {
							resolve({ success: false, error: failureReason || "Print failed" });
						}
					},
				);
			});
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
);

ipcMain.handle("fbr:fiscalize-local", async (_event, url: string, payload: Record<string, unknown>) => {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 12000);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!response.ok) {
				return { success: false, error: `Local FBR service responded with HTTP ${response.status}.` };
			}
			const data = await response.json();
			return { success: true, data };
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
});

app.whenReady().then(async () => {
	Menu.setApplicationMenu(null);

	if (process.platform === "win32") {
		app.setAppUserModelId("com.xpos.app");
	}

	try {
		const ses = session.defaultSession;
		await ses.clearStorageData({ storages: ["cookies"] });
	} catch {
		/* ignore */
	}

	try {
		await initDatabase();
		log.info("Local MariaDB initialized");
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.error(`MariaDB init failed: ${errMsg}`);
	}

	registerDbHandlers();

	initAutoUpdater();

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});

	try {
		const savedRole = await getMeta("node_role");
		currentRole = (savedRole === "till" ? "till" : "hub") as NodeRole;

		if (currentRole === "hub") {
			const portStr = await getMeta("hub_api_port");
			const port = portStr ? Number(portStr) : 6789;
			startHubServer(port).catch((e) => log.error("Hub server failed to start", e));

			const apiKey = await getMeta("api_key");
			const apiSecret = await getMeta("api_secret");
			const serverUrl = await getMeta("server_url");
			if (apiKey && apiSecret && serverUrl) {
				log.info("Auto-starting sync engine with saved credentials");
				initSyncEngine({ serverUrl, csrfToken: "", sessionCookies: "", apiKey, apiSecret });
				syncEngineStarted = true;
				setTimeout(() => {
					runSyncCyclePublic();
				}, 3000);
			} else {
				log.info(
					`Sync engine not auto-started - missing: ${!apiKey ? "api_key " : ""}${!apiSecret ? "api_secret " : ""}${!serverUrl ? "server_url" : ""}`,
				);
			}
		} else {
			const hubUrl = (await getMeta("hub_url")) || "http://localhost:6789";
			const tillId = (await getMeta("till_id")) || "TILL-01";
			await initTillClient(hubUrl, tillId);
			tillSyncInterval = setInterval(async () => {
				try {
					await runTillSync();
				} catch {
					/* logged inside */
				}
			}, 30_000);
		}
	} catch (err) {
		log.error("Post-DB init setup failed", err);
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("will-quit", async () => {
	stopAutoUpdater();
	stopSyncEngine();
	if (tillSyncInterval) {
		clearInterval(tillSyncInterval);
		tillSyncInterval = null;
	}
	await stopHubServer();
	await closeDatabase();
});

app.on("web-contents-created", (_event, contents) => {
	contents.on("will-navigate", (event, url) => {
		const allowed = [SERVER_URL, process.env.VITE_DEV_SERVER_URL || "", "file://"].filter(Boolean);

		if (!allowed.some((origin) => url.startsWith(origin))) {
			event.preventDefault();
		}
	});
});
