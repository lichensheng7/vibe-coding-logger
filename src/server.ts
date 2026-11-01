import { readdirSync, statSync, unlinkSync, mkdirSync, readFileSync, createReadStream } from "node:fs";
import { sqlite } from "./db.ts";
import { CONFIG } from "./config.ts";
import { route, ok, created, startHttp, checkPassword, createSession, dropSession, TOKENS } from "./http.ts";
import { HttpError } from "./util.ts";
import "./routes.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url), "utf8");

route("GET", "/", ({ res }) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(UI); }, "public");
route("GET", "/api/health", () => ok({ status: "ok", version: VERSION, public_read: CONFIG.publicRead, password_login: !!CONFIG.adminPassword }), "public");
for (const f of ["logo.svg", "favicon.svg"]) {
	const svg = readFileSync(new URL(`./assets/${f}`, import.meta.url));
	route("GET", `/${f}`, ({ res }) => { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }); res.end(svg); }, "public");
}
const PNG = readFileSync(new URL("./assets/favicon.png", import.meta.url));
for (const f of ["/favicon.png", "/favicon.ico", "/apple-touch-icon.png"]) route("GET", f, ({ res }) => { res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }); res.end(PNG); }, "public");
route("GET", "/api/openapi.json", ({ res }) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(OPENAPI); }, "public");
/* ---------------------------------- login ---------------------------------- */
const fails = new Map<string, { n: number; until: number }>();
route("POST", "/api/auth/login", async ({ body, req }) => {
	if (!CONFIG.adminPassword) throw new HttpError(400, "未设置 ADMIN_PASSWORD，密码登录未启用");
	const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
	const f = fails.get(ip);
	if (f && f.n >= 10 && f.until > Date.now()) throw new HttpError(429, "失败次数过多，请 15 分钟后再试");
	const { password } = await body();
	if (!checkPassword(String(password ?? ""))) {
		const n = f && f.until > Date.now() ? f.n + 1 : 1;
		fails.set(ip, { n, until: Date.now() + 15 * 60_000 });
		throw new HttpError(401, "密码错误");
	}
	fails.delete(ip);
	return ok(createSession());
}, "public");
route("POST", "/api/auth/logout", ({ token }) => { dropSession(token); return ok(); }, "auth");
route("GET", "/api/auth/check", () => ok({ authed: true }), "auth");
// Lets the logged-in admin copy the API token to hand to an organizing AI.
route("GET", "/api/auth/api-token", () => ok({ token: TOKENS[0] }), "auth");

/* ------------------------------ automatic backups ------------------------------ */
const backupDir = `${CONFIG.dataDir}/backups`;
function backupNow(): string {
	mkdirSync(backupDir, { recursive: true });
	const file = `${backupDir}/vcl-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.db`;
	sqlite.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
	const files = readdirSync(backupDir).filter((f) => f.endsWith(".db")).sort();
	for (const f of files.slice(0, Math.max(0, files.length - CONFIG.backupKeep))) unlinkSync(`${backupDir}/${f}`);
	return file;
}
route("GET", "/api/backups", () => {
	mkdirSync(backupDir, { recursive: true });
	return ok(readdirSync(backupDir).filter((f) => f.endsWith(".db")).sort().reverse().map((f) => ({ name: f, size: statSync(`${backupDir}/${f}`).size })));
}, "auth");
route("POST", "/api/backups", () => created({ name: backupNow().split("/").pop() }));
route("GET", "/api/backups/:name", ({ params, res }) => {
	if (!/^[\w.-]+\.db$/.test(params.name)) throw new HttpError(400, "bad name");
	const f = `${backupDir}/${params.name}`;
	try { statSync(f); } catch { throw new HttpError(404, "备份不存在"); }
	res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${params.name}"` });
	createReadStream(f).pipe(res);
}, "auth");
if (CONFIG.backupIntervalHours > 0) setInterval(() => { try { backupNow(); } catch (e) { console.error("backup failed", e); } }, CONFIG.backupIntervalHours * 3600_000).unref();

const server = startHttp();
const shutdown = () => { server.close(); try { sqlite.close(); } catch {} process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
