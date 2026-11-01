import { readdirSync, statSync, unlinkSync, mkdirSync, readFileSync, createReadStream } from "node:fs";
import { sqlite } from "./db.ts";
import { CONFIG } from "./config.ts";
import { route, ok, created, startHttp } from "./http.ts";
import { HttpError } from "./util.ts";
import "./routes.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url), "utf8");

route("GET", "/", ({ res }) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(UI); }, "public");
route("GET", "/api/health", () => ok({ status: "ok", version: VERSION, public_read: CONFIG.publicRead }), "public");
route("GET", "/api/openapi.json", ({ res }) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(OPENAPI); }, "public");
route("GET", "/api/auth/check", () => ok({ authed: true }), "auth");

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
