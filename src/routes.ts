import { route, ok, created } from "./http.ts";
import { db } from "./db.ts";
import { HttpError } from "./util.ts";
import * as S from "./store.ts";
import * as IO from "./io.ts";

const int = (v: string | null, d: number, min = 0, max = 10_000) => {
	if (v == null || v === "") return d;
	const n = Number(v); if (!Number.isInteger(n) || n < min) throw new HttpError(400, `参数必须是 >=${min} 的整数`);
	return Math.min(n, max);
};
const page = (q: URLSearchParams, def = 100) => ({ limit: int(q.get("limit"), def, 1, 5000), offset: int(q.get("offset"), 0) });
const fileName = (s: string) => encodeURIComponent(s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "export");

/* -------------------------------- projects -------------------------------- */
route("GET", "/api/projects", ({ query }) => {
	const r = S.listProjects({ q: query.get("q") ?? undefined, tag: query.get("tag") ?? undefined, archived: query.get("archived") ?? undefined, ...page(query) });
	return ok(r.items, { total: r.total });
});

// Create a project; optionally include `messages` to create + fill in one call.
route("POST", "/api/projects", async ({ body }) => {
	const b = await body();
	return db.tx(() => {
		const p = S.createProject(b);
		const ins = Array.isArray(b.messages) && b.messages.length ? S.insertMessages(p.id, b.messages, { on_duplicate: b.on_duplicate }) : null;
		return created({ ...S.outProject(S.projectWithStats(p.id)), ...(ins ? { inserted: { created: ins.created, skipped: ins.skipped, updated: ins.updated } } : {}) });
	});
});
route("GET", "/api/projects/:id", ({ params }) => ok(S.outProject(S.projectWithStats(S.getProject(params.id).id))));
route("PATCH", "/api/projects/:id", async ({ params, body }) => { const p = S.updateProject(params.id, await body()); return ok(S.outProject(S.projectWithStats(p.id))); });
route("DELETE", "/api/projects/:id", ({ params }) => ok(S.deleteProject(params.id)));

/* -------------------------------- messages -------------------------------- */
route("GET", "/api/projects/:id/messages", ({ params, query }) => {
	const r = S.listMessages(params.id, {
		role: query.get("role") ?? undefined, author: query.get("author") ?? undefined, q: query.get("q") ?? undefined,
		turn: query.get("turn") != null ? int(query.get("turn"), 0, 0, 1e9) : undefined,
		from_seq: query.get("from_seq") ? int(query.get("from_seq"), 1, 1, 1e9) : undefined, ...page(query, 500),
	});
	return ok(r.items, { total: r.total });
});
route("GET", "/api/projects/:id/turns", ({ params }) => ok(S.listTurns(params.id)));

// Append one message ({role, content, ...}) or many ({messages:[...]} or a bare array).
// Position: ?position=N / ?after_id= / ?before_id= (query or body). Idempotent with ext_id.
route("POST", "/api/projects/:id/messages", async ({ params, body, query }) => {
	const b = await body();
	const list = Array.isArray(b) ? b : Array.isArray(b.messages) ? b.messages : [b];
	const opt = (k: string) => (Array.isArray(b) ? undefined : b[k]) ?? query.get(k) ?? undefined;
	const r = S.insertMessages(params.id, list, { position: opt("position"), after_id: opt("after_id"), before_id: opt("before_id"), on_duplicate: opt("on_duplicate") });
	const single = !Array.isArray(b) && !Array.isArray(b.messages);
	if (single) return { __status: r.created ? 201 : 200, success: true, data: S.getMessage(r.items[0].id), status: r.items[0].status };
	return created(r);
});
route("PUT", "/api/projects/:id/order", async ({ params, body }) => ok(S.reorder(params.id, (await body()).ids)));
route("POST", "/api/projects/:id/messages/delete", async ({ params, body }) => ok(S.deleteMessages(params.id, ((await body()).ids ?? []).map(String))));
route("POST", "/api/projects/:id/messages/bulk-update", async ({ params, body }) => ok(S.bulkUpdate(params.id, await body())));
// Replace every message of the project (useful when an organizing AI re-does a whole log).
route("PUT", "/api/projects/:id/messages", async ({ params, body }) => {
	const b = await body();
	const list = Array.isArray(b) ? b : b.messages;
	if (!Array.isArray(list)) throw new HttpError(400, "需要 messages 数组");
	return ok(db.tx(() => {
		const p = S.getProject(params.id);
		db.run("DELETE FROM messages WHERE project_id=?", p.id);
		return list.length ? S.insertMessages(p.id, list) : { project_id: p.id, created: 0, updated: 0, skipped: 0, items: [] };
	}));
});

route("GET", "/api/messages/:id", ({ params }) => ok(S.getMessage(params.id)));
route("PATCH", "/api/messages/:id", async ({ params, body }) => ok(S.updateMessage(params.id, await body())));
route("POST", "/api/messages/:id/move", async ({ params, body }) => ok(S.moveMessage(params.id, await body())));
route("DELETE", "/api/messages/:id", ({ params }) => {
	const r = S.deleteMessages(null, [params.id]);
	if (!r.deleted) throw new HttpError(404, `消息不存在: ${params.id}`);
	return ok(r);
});

/* ----------------------------- import / export ----------------------------- */
route("GET", "/api/projects/:id/export", ({ params, query, res }) => {
	const p = S.getProject(params.id);
	const fmt = (query.get("format") ?? "json").toLowerCase();
	const dl = query.get("download") !== "0";
	const head = (type: string, ext: string) => ({ "content-type": type, ...(dl ? { "content-disposition": `attachment; filename*=UTF-8''${fileName(p.name)}.${ext}` } : {}) });
	let body: string, h: Record<string, string>;
	if (fmt === "json") { body = JSON.stringify(IO.exportJson([p.id]), null, 2); h = head("application/json; charset=utf-8", "json"); }
	else if (fmt === "jsonl") { body = IO.exportJsonl(p.id); h = head("application/x-ndjson; charset=utf-8", "jsonl"); }
	else if (fmt === "md" || fmt === "markdown") { body = IO.exportMarkdown(p.id); h = head("text/markdown; charset=utf-8", "md"); }
	else throw new HttpError(400, "format 只能是 json / jsonl / md");
	res.writeHead(200, { ...h, "access-control-allow-origin": "*", "access-control-expose-headers": "content-disposition" });
	res.end(body);
});
route("GET", "/api/export", ({ res, query }) => {
	const ids = query.get("ids")?.split(",").filter(Boolean);
	const body = JSON.stringify(IO.exportJson(ids), null, 2);
	res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="vibe-coding-logger-${new Date().toISOString().slice(0, 10)}.json"`, "access-control-allow-origin": "*", "access-control-expose-headers": "content-disposition" });
	res.end(body);
});
// Whole-file import (export JSON from this app). ?mode=new|restore|skip
route("POST", "/api/import", async ({ raw, query }) => {
	const text = await raw();
	let data: any; try { data = JSON.parse(text); } catch { throw new HttpError(400, "导入文件不是合法 JSON"); }
	return created(IO.importBundle(data, query.get("mode") ?? "new"));
});
// Append messages from a file into one project. ?format=json|jsonl|md|text (auto-detected when omitted)
route("POST", "/api/projects/:id/import", async ({ params, raw, query }) => {
	const text = await raw();
	let fmt = (query.get("format") ?? "").toLowerCase();
	if (!fmt) fmt = /^\s*[[{]/.test(text) ? (/^\s*\{[^\n]*\}\s*\n\s*\{/.test(text) ? "jsonl" : "json") : text.includes("<!-- vcl:msg") ? "md" : "text";
	let msgs: any[];
	if (fmt === "json") { let d: any; try { d = JSON.parse(text); } catch { throw new HttpError(400, "不是合法 JSON"); } msgs = IO.messagesFromJson(d); }
	else if (fmt === "jsonl") msgs = IO.parseJsonl(text);
	else if (fmt === "md" || fmt === "markdown") msgs = IO.parseMarkdown(text).messages;
	else if (fmt === "text" || fmt === "txt") {
		const speakers = Object.fromEntries((query.get("speakers") ?? "").split(",").filter((s) => s.includes("=")).map((s) => s.split("=").map((x) => x.trim())));
		msgs = IO.parseTranscript(text, speakers);
	} else throw new HttpError(400, "format 只能是 json / jsonl / md / text");
	if (query.get("dry_run") === "1") return ok({ format: fmt, count: msgs.length, preview: msgs.slice(0, 20).map((m, i) => S.normMessage(m, i)) });
	const r = S.insertMessages(params.id, msgs, { position: query.get("position") ?? undefined, after_id: query.get("after_id") ?? undefined, on_duplicate: query.get("on_duplicate") ?? undefined });
	return created({ format: fmt, ...r, items: undefined });
});

/* ------------------------------ search / meta ------------------------------ */
route("GET", "/api/search", ({ query }) => ok(S.search(query.get("q") ?? "", query.get("project_id"), int(query.get("limit"), 50, 1, 500))));
route("GET", "/api/stats", () => ok(db.get(`SELECT (SELECT COUNT(*) FROM projects) projects, (SELECT COUNT(*) FROM messages) messages,
	(SELECT COUNT(*) FROM messages WHERE role='user') prompts, (SELECT COUNT(*) FROM messages WHERE role='assistant') replies`)));
route("GET", "/api/roles", () => ok(S.ROLES), "public");
