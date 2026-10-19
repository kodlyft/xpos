/**
 * electron-builder afterPack hook.
 *
 * Runs after the app is packed into the unpacked directory but BEFORE any
 * installer (NSIS) is assembled, so the branding we stamp here ends up inside
 * the shipped installer as well.
 *
 * For Windows it:
 *   1. Embeds the multi-resolution build/icon.ico into the .exe (taskbar,
 *      Explorer, alt-tab, title bar).
 *   2. Sets the Win32 version-info resource - the fields shown on the .exe's
 *      "Details" tab: File description, Company, Product name, Version,
 *      Copyright, etc.
 *   3. Flips the EnableEmbeddedAsarIntegrityValidation fuse OFF.
 *
 * This is done with resedit + @electron/fuses (both pure JS), so it works on
 * Linux/CI without Wine - the reason the previous Linux build shipped a default
 * icon and blank .exe properties.
 */

import * as ResEdit from "resedit";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(__dirname, "..", "build");

const LANG = 1033;
const CODEPAGE = 1200;

function versionTuple(version) {
	const core = String(version || "0.0.0").split("-")[0];
	const [maj = 0, min = 0, pat = 0] = core.split(".").map((n) => parseInt(n, 10) || 0);
	return [maj, min, pat, 0];
}

export default async function afterPack(context) {
	if (context.electronPlatformName !== "win32") return;

	const appInfo = context.packager.appInfo;
	const productName = appInfo.productName;
	const version = appInfo.version;
	const company = "Kodlyft";
	const copyright = appInfo.copyright || `Copyright © ${new Date().getFullYear()} ${company}`;
	const exeName = `${productName}.exe`;
	const exePath = path.join(context.appOutDir, exeName);
	const icoPath = path.join(buildDir, "icon.ico");

	if (!fs.existsSync(exePath)) {
		throw new Error(`[afterPack] Executable not found: ${exePath}`);
	}
	if (!fs.existsSync(icoPath)) {
		throw new Error(`[afterPack] Icon not found: ${icoPath}`);
	}

	console.log(`[afterPack] Branding ${exeName} (v${version}, ${company}) ...`);

	const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
	const res = ResEdit.NtExecutableResource.from(exe);

	const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
	ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
		res.entries,
		1,
		LANG,
		iconFile.icons.map((i) => i.data),
	);

	const existing = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
	const vi = existing.length > 0 ? existing[0] : ResEdit.Resource.VersionInfo.createEmpty();
	const [maj, min, pat, rev] = versionTuple(version);
	vi.setFileVersion(maj, min, pat, rev, LANG);
	vi.setProductVersion(maj, min, pat, rev, LANG);
	vi.setStringValues(
		{ lang: LANG, codepage: CODEPAGE },
		{
			CompanyName: company,
			FileDescription: `${productName} - Point of Sale for ERPNext`,
			ProductName: productName,
			InternalName: productName,
			OriginalFilename: exeName,
			FileVersion: version,
			ProductVersion: version,
			LegalCopyright: copyright,
		},
	);
	vi.outputToResourceEntries(res.entries);

	res.outputResource(exe);
	fs.writeFileSync(exePath, Buffer.from(exe.generate()));
	console.log("[afterPack] Icon + version-info embedded.");

	if (process.platform !== "win32") {
		await flipFuses(exePath, {
			version: FuseVersion.V1,
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
			resetAdHocDarwinSignature: false,
		});
		console.log("[afterPack] ASAR integrity fuse disabled (built on non-Windows host).");
	} else {
		console.log("[afterPack] Native Windows build - ASAR integrity fuse left intact.");
	}
}
