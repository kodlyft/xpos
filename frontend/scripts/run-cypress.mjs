import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import loadEnv from "./loadEnv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

loadEnv({ root });

const argv = process.argv.slice(2);
const withServer = argv.includes("--with-server");
const demo = argv.includes("--demo");
const cypressArgs = argv.filter((arg) => arg !== "--with-server" && arg !== "--demo");
const mode = cypressArgs[0] === "open" ? "open" : "run";

const BASE_URL = process.env.CYPRESS_BASE_URL || "http://localhost:5174";
const READY_TIMEOUT_MS = 120_000;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const DEFAULT_SLOW_MO = "700";

function demoArgs(args) {
	const configuredSlowMo = env.CYPRESS_SLOW_MO || DEFAULT_SLOW_MO;
	const parsedSlowMo = Number.parseInt(String(configuredSlowMo), 10);
	const safeSlowMo =
		Number.isFinite(parsedSlowMo) && parsedSlowMo > 0
			? parsedSlowMo
			: Number.parseInt(DEFAULT_SLOW_MO, 10);
	env.CYPRESS_SLOW_MO = String(safeSlowMo);

	const extra = [];
	if (mode === "run") {
		if (!args.includes("--headed")) extra.push("--headed");
		if (!args.includes("--browser") && !args.includes("-b")) extra.push("--browser", "chrome");
		if (!args.some((arg) => String(arg).startsWith("--config"))) {
			extra.push("--config", "retries=0,defaultCommandTimeout=20000");
		}
	}

	console.log(`[e2e] demo mode: ${safeSlowMo}ms per action, headed Chrome`);
	return [...args, ...extra];
}

/** Vite serves the app under `base`, so probe the real entry point. */
async function waitForServer(url) {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/xpos/`);
			if (response.ok) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

function run(command, args, options = {}) {
	return spawn(command, args, { cwd: root, env, stdio: "inherit", ...options });
}

let server = null;

async function isServing(url) {
	try {
		const response = await fetch(`${url}/xpos/`, { signal: AbortSignal.timeout(2000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function main() {
	if (withServer) {
		if (await isServing(BASE_URL)) {
			console.log(`[e2e] reusing the dev server already at ${BASE_URL}`);
		} else {
			console.log("[e2e] starting vite dev server...");
			server = run("npx", ["vite", "--port", "5174", "--strictPort"], { stdio: "ignore" });
			server.on("exit", (code) => {
				if (code && code !== 0 && server) {
					console.error(`[e2e] vite exited unexpectedly (${code})`);
					shutdown(1);
				}
			});

			if (!(await waitForServer(BASE_URL))) {
				console.error(`[e2e] vite did not become ready at ${BASE_URL} in time`);
				shutdown(1);
				return;
			}
			console.log(`[e2e] vite ready at ${BASE_URL}`);
		}
	}

	let args = cypressArgs.length ? cypressArgs : [mode];
	if (demo) args = demoArgs(args);

	const cypress = run("npx", ["cypress", ...args]);
	cypress.on("exit", (code) => shutdown(code ?? 1));
}

function shutdown(code) {
	if (server && !server.killed) {
		const child = server;
		server = null;
		child.kill("SIGTERM");
	}
	process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

main().catch((error) => {
	console.error("[e2e]", error);
	shutdown(1);
});
