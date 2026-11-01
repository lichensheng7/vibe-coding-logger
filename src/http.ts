import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { HttpError, now, timingSafeEqual } from "./util.ts";
import { db } from "./db.ts";

export type Ctx = {
	req: IncomingMessage; res: ServerResponse; url: URL;
	params: Record<string, string>; query: URLSearchParams;
	body: () => Promise<any>; raw: () => Promise<string>; token: string;
};
type Handler = (c: Ctx) => Promise<any> | any;
type Access = "auth" | "read" | "public";
const routes: { method: string; re: RegExp; keys: string[]; h: Handler; access: Access }[] = [];

/** access: "auth" = token required; "read" = token required unless PUBLIC_READ; "public" = never. */
export const route = (method: string, path: string, h: Handler, access?: Access) => {
	const keys: string[] = [];
	const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
	routes.push({ method, re, keys, h, access: access ?? (method === "GET" ? "read" : "auth") });
};

const CORS = {
	"access-control-allow-origin": CONFIG.corsOrigin,
	"access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
	"access-control-allow-headers": "authorization,content-type,x-api-token",
	"access-control-expose-headers": "content-disposition,x-total-count",
};

/* ------------------------------- API tokens -------------------------------- */
const tokenFile = `${CONFIG.dataDir}/api_token`;
export const TOKENS: string[] = [...CONFIG.apiTokens];
if (!TOKENS.length) {
	if (!existsSync(tokenFile)) writeFileSync(tokenFile, "vcl_" + randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
	TOKENS.push(readFileSync(tokenFile, "utf8").trim());
	console.log(`ℹ  API_TOKEN 未设置，已使用自动生成的 Token（见 ${tokenFile}）`);
}
const tokenOf = (req: IncomingMessage, url: URL) =>
	(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim() || String(req.headers["x-api-token"] ?? "") || url.searchParams.get("token") || "";
export const isApiToken = (t: string) => !!t && TOKENS.some((k) => timingSafeEqual(t, k));
/* ------------------------- admin password sessions ------------------------- */
export const checkPassword = (pw: string) => !!CONFIG.adminPassword && timingSafeEqual(pw, CONFIG.adminPassword);
export function createSession() {
	const token = "sess_" + randomBytes(24).toString("hex");
	const expires_at = now() + CONFIG.sessionDays * 86400_000;
	db.run("INSERT INTO sessions (token, expires_at, created_at) VALUES (?,?,?)", token, expires_at, now());
	db.run("DELETE FROM sessions WHERE expires_at < ?", now());
	return { token, expires_at };
}
export function validSession(t: string) {
	if (!t.startsWith("sess_")) return false;
	const s = db.get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE token=?", t);
	return !!s && s.expires_at > now();
}
export const dropSession = (t: string) => db.run("DELETE FROM sessions WHERE token=?", t);
export const isAuthed = (t: string) => isApiToken(t) || validSession(t);

/* -------------------------------- plumbing --------------------------------- */
const readRaw = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
	const chunks: Buffer[] = []; let size = 0; const max = CONFIG.maxBodyMb * 1024 * 1024;
	req.on("data", (c) => { size += c.length; if (size > max) { reject(new HttpError(413, "请求体过大")); req.destroy(); } else chunks.push(c); });
	req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "")));
	req.on("error", reject);
});
const parseJson = (s: string) => { if (!s.trim()) return {}; try { return JSON.parse(s); } catch { throw new HttpError(400, "请求体不是合法 JSON"); } };

export const ok = (data: unknown = null, extra: Record<string, unknown> = {}) => ({ success: true, data, ...extra });
export const created = (data: unknown) => ({ __status: 201, success: true, data });

export function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
	if (data instanceof Buffer || typeof data === "string") { res.writeHead(status, { ...CORS, ...headers }); res.end(data); return; }
	const { __status, ...rest } = (data ?? {}) as any;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...CORS, ...headers });
	res.end(JSON.stringify(rest));
}

export function startHttp() {
	const server = createServer(async (req, res) => {
		if (req.method === "OPTIONS") return send(res, 204, "");
		const url = new URL(req.url!, "http://x");
		try {
			let pathMatched = false;
			for (const r of routes) {
				const m = url.pathname.match(r.re);
				if (!m) continue;
				pathMatched = true;
				if (r.method !== req.method) continue;
				const needAuth = r.access === "auth" || (r.access === "read" && !CONFIG.publicRead);
				const tok = tokenOf(req, url);
				if (needAuth && !isAuthed(tok)) throw new HttpError(401, "未授权：请登录，或提供 API Token（Authorization: Bearer <token>）");
				let rawP: Promise<string> | undefined;
				const ctx: Ctx = {
					req, res, url, query: url.searchParams, token: tok,
					params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
					raw: () => (rawP ??= readRaw(req)),
					body: async () => parseJson(await (rawP ??= readRaw(req))),
				};
				const out = await r.h(ctx);
				if (res.headersSent) return;
				if (out === undefined) send(res, 204, "");
				else send(res, out?.__status ?? 200, out);
				return;
			}
			throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed" : "Not found");
		} catch (e: any) {
			if (res.headersSent) { try { res.end(); } catch {} return; }
			const status = e instanceof HttpError ? e.status : 500;
			if (status === 500) console.error(e);
			send(res, status, { success: false, message: e?.message ?? "Internal error", details: e?.details });
		}
	});
	server.listen(CONFIG.port, CONFIG.host, () => console.log(`vibe-coding-logger listening on http://${CONFIG.host}:${CONFIG.port}`));
	return server;
}
