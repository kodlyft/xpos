/**
 * File-based logger for Electron main process.
 *
 * Writes to {userData}/logs/xpos-{date}.log with rotation.
 * Falls back to console if file writing fails.
 */

import { app } from "electron";
import fs from "fs";
import path from "path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let logDir: string | null = null;
let currentLogFile: string | null = null;
let currentDate: string = "";
let minLevel: LogLevel = "info";
const MAX_LOG_FILES = 7; // Keep 7 days of logs

function ensureLogDir(): string {
	if (logDir) return logDir;
	logDir = path.join(app.getPath("userData"), "logs");
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}
	return logDir;
}

function getLogFile(): string {
	const today = new Date().toISOString().slice(0, 10);
	if (today !== currentDate || !currentLogFile) {
		currentDate = today;
		currentLogFile = path.join(ensureLogDir(), `xpos-${today}.log`);
		cleanOldLogs();
	}
	return currentLogFile;
}

function cleanOldLogs(): void {
	try {
		const dir = ensureLogDir();
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith("xpos-") && f.endsWith(".log"))
			.sort()
			.reverse();

		for (let i = MAX_LOG_FILES; i < files.length; i++) {
			fs.unlinkSync(path.join(dir, files[i]));
		}
	} catch {
		// Non-critical - ignore cleanup failures
	}
}

function formatMessage(level: LogLevel, tag: string, msg: string, data?: unknown): string {
	const ts = new Date().toISOString();
	let line = `${ts} [${level.toUpperCase()}] [${tag}] ${msg}`;
	if (data !== undefined) {
		try {
			line += " " + JSON.stringify(data);
		} catch {
			line += " [unserializable]";
		}
	}
	return line;
}

function write(level: LogLevel, tag: string, msg: string, data?: unknown): void {
	if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

	const line = formatMessage(level, tag, msg, data);

	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);

	try {
		fs.appendFileSync(getLogFile(), line + "\n");
	} catch {}
}

/**
 * Create a tagged logger instance.
 */
export function createLogger(tag: string) {
	return {
		debug: (msg: string, data?: unknown) => write("debug", tag, msg, data),
		info: (msg: string, data?: unknown) => write("info", tag, msg, data),
		warn: (msg: string, data?: unknown) => write("warn", tag, msg, data),
		error: (msg: string, data?: unknown) => write("error", tag, msg, data),
	};
}

/**
 * Set minimum log level ("debug", "info", "warn", "error").
 */
export function setLogLevel(level: LogLevel): void {
	minLevel = level;
}

/**
 * Get the log directory path.
 */
export function getLogDir(): string {
	return ensureLogDir();
}
