import { describe, expect, it } from "vitest";
import {
	classifyLoginResponse,
	isCleartext,
	supportedVersion,
	validateServerOrigin,
} from "../src/domain/origin";

describe("server origin + login classification", () => {
	it("accepts https and http origins, normalised, with no path or credentials", () => {
		expect(validateServerOrigin("https://shop.example.com")).toEqual({
			ok: true,
			origin: "https://shop.example.com",
			secure: true,
		});
		expect(validateServerOrigin("http://192.168.1.20:8000/")).toEqual({
			ok: true,
			origin: "http://192.168.1.20:8000",
			secure: false,
		});
		for (const bad of [
			"shop.example.com",
			"ftp://shop.example.com",
			"ws://shop.example.com",
			"https://u:p@shop.example.com",
			"http://shop.example.com/app",
			"https://x.com?a=1",
		])
			expect(validateServerOrigin(bad).ok).toBe(false);
	});
	it("flags http origins as cleartext so the UI can warn", () => {
		expect(isCleartext("http://shop.example.com")).toBe(true);
		expect(isCleartext("https://shop.example.com")).toBe(false);
		expect(isCleartext(null)).toBe(false);
	});
	it("classifies MFA/SSO as unsupported and never as success", () => {
		expect(classifyLoginResponse(200, { message: "Logged In", full_name: "A" })).toEqual({
			kind: "ok",
			user: "A",
		});
		expect(classifyLoginResponse(200, { verification: { method: "OTP" }, tmp_id: "x" }).kind).toBe(
			"mfa_unsupported",
		);
		expect(
			classifyLoginResponse(200, {
				redirect_to: "/api/method/frappe.integrations.oauth2_logins.login_via_google",
			}).kind,
		).toBe("sso_unsupported");
		expect(classifyLoginResponse(401, { message: "Incorrect" }).kind).toBe("invalid_credentials");
		expect(classifyLoginResponse(500, null).kind).toBe("unexpected");
	});
	it("accepts ERPNext/Frappe 16 only", () => {
		expect(supportedVersion("16.4.1")).toBe(true);
		expect(supportedVersion("15.9.0")).toBe(false);
		expect(supportedVersion("17.0.0")).toBe(false);
		expect(supportedVersion("")).toBe(false);
	});
});
