import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PORT = 19000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";
let srv: ChildProcess; let dir: string;

async function api(method: string, path: string, body?: unknown, opts: { raw?: string; token?: string | null } = {}) {
	const headers: Record<string, string> = {};
	if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
	let b: string | undefined;
	if (opts.raw !== undefined) b = opts.raw; else if (body !== undefined) { b = JSON.stringify(body); headers["content-type"] = "application/json"; }
	const r = await fetch(BASE + path, { method, headers, body: b });
	const text = await r.text();
	let json: any; try { json = JSON.parse(text); } catch { json = text; }
	return { status: r.status, json, text, headers: r.headers };
}

before(async () => {
	dir = mkdtempSync(`${tmpdir()}/vcl-test-`);
	srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, API_TOKEN: TOKEN, ADMIN_PASSWORD: "pw-test", HOST: "127.0.0.1" }, stdio: "ignore" });
	for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/api/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
	throw new Error("server did not start");
});
after(() => { srv.kill(); rmSync(dir, { recursive: true, force: true }); });

test("auth required", async () => {
	assert.equal((await api("GET", "/api/projects", undefined, { token: null })).status, 401);
	assert.equal((await api("GET", "/api/projects", undefined, { token: "wrong" })).status, 401);
	assert.equal((await api("GET", "/api/health", undefined, { token: null })).status, 200);
});

test("project lifecycle + isolation", async () => {
	const a = await api("POST", "/api/projects", { name: "Deploy A", tool: "Cursor", tags: ["deploy"] });
	assert.equal(a.status, 201); assert.equal(a.json.data.slug, "deploy-a");
	const b = await api("POST", "/api/projects", { name: "Deploy A" });
	assert.equal(b.json.data.slug, "deploy-a-2");
	await api("POST", `/api/projects/${a.json.data.id}/messages`, { role: "user", content: "only in A" });
	const lb = await api("GET", `/api/projects/${b.json.data.id}/messages`);
	assert.equal(lb.json.total, 0);
	const bySlug = await api("GET", "/api/projects/deploy-a");
	assert.equal(bySlug.json.data.message_count, 1);
	const p = await api("PATCH", `/api/projects/${b.json.data.id}`, { name: "Renamed", description: "d" });
	assert.equal(p.json.data.name, "Renamed");
	assert.equal((await api("DELETE", `/api/projects/${b.json.data.id}`)).status, 200);
	assert.equal((await api("GET", `/api/projects/${b.json.data.id}`)).status, 404);
	assert.equal((await api("POST", "/api/projects", { name: "" })).status, 400);
});

test("sequential push, multi-reply turns, idempotency", async () => {
	const p = (await api("POST", "/api/projects", { name: "Seq" })).json.data;
	const push = (m: any) => api("POST", `/api/projects/${p.id}/messages`, m);
	await push({ role: "system", content: "you are an agent" });
	await push({ role: "user", author: "我", content: "部署 nginx", ext_id: "1" });
	await push({ role: "assistant", author: "Claude Code", content: "先看端口", ext_id: "2" });
	await push({ role: "tool", author: "bash", content: "ss -ltnp", format: "code", ext_id: "3" });
	await push({ role: "assistant", author: "Claude Code", content: "完成", ext_id: "4" });
	const again = await push({ role: "assistant", content: "完成", ext_id: "4" });
	assert.equal(again.status, 200); assert.equal(again.json.status, "skipped");
	await push({ role: "human", content: "再加 https", ext_id: "5" });
	await push({ role: "AI", content: "好", ext_id: "6" });
	const l = await api("GET", `/api/projects/${p.id}/messages`);
	assert.equal(l.json.total, 7);
	assert.deepEqual(l.json.data.map((m: any) => m.seq), [1, 2, 3, 4, 5, 6, 7]);
	assert.deepEqual(l.json.data.map((m: any) => m.turn), [0, 1, 1, 1, 1, 2, 2]);
	assert.equal(l.json.data[5].role, "user"); assert.equal(l.json.data[6].role, "assistant");
	const turns = (await api("GET", `/api/projects/${p.id}/turns`)).json.data;
	assert.equal(turns.length, 3); assert.equal(turns[1].replies.length, 3); assert.equal(turns[0].prompt, null);
	const t1 = await api("GET", `/api/projects/${p.id}/messages?turn=1`);
	assert.equal(t1.json.total, 4);
	assert.equal((await push({ role: "robot", content: "x" })).status, 400);
	const upd = await api("POST", `/api/projects/${p.id}/messages`, { messages: [{ role: "assistant", content: "完成 v2", ext_id: "4" }], on_duplicate: "update" });
	assert.equal(upd.json.data.updated, 1);
});

test("batch insert at position, edit, move, delete, reorder, bulk update", async () => {
	const p = (await api("POST", "/api/projects", { name: "Edit", messages: [
		{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }, { role: "assistant", content: "a2" },
	] })).json.data;
	assert.equal(p.message_count, 4);
	let l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	const ins = await api("POST", `/api/projects/${p.id}/messages`, { after_id: l[1].id, messages: [{ role: "assistant", content: "a1b" }, { role: "note", content: "n" }] });
	assert.equal(ins.json.data.created, 2);
	l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => m.content), ["q1", "a1", "a1b", "n", "q2", "a2"]);
	const e = await api("PATCH", `/api/messages/${l[1].id}`, { role: "assistant", author: "GPT-5", content: "a1 edited" });
	assert.equal(e.json.data.author, "GPT-5"); assert.equal(e.json.data.content, "a1 edited");
	const flip = await api("PATCH", `/api/messages/${l[3].id}`, { role: "user" });
	assert.equal(flip.json.data.turn, 2);
	await api("PATCH", `/api/messages/${l[3].id}`, { role: "note" });
	await api("POST", `/api/messages/${l[5].id}/move`, { position: 1 });
	l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => m.content), ["a2", "q1", "a1 edited", "a1b", "n", "q2"]);
	await api("POST", `/api/messages/${l[0].id}/move`, { after_id: l[5].id });
	l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => m.content), ["q1", "a1 edited", "a1b", "n", "q2", "a2"]);
	await api("DELETE", `/api/messages/${l[3].id}`);
	l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => m.seq), [1, 2, 3, 4, 5]);
	const rev = [...l].reverse().map((m: any) => m.id);
	assert.equal((await api("PUT", `/api/projects/${p.id}/order`, { ids: rev })).status, 200);
	assert.equal((await api("PUT", `/api/projects/${p.id}/order`, { ids: rev.slice(1) })).status, 400);
	const bu = await api("POST", `/api/projects/${p.id}/messages/bulk-update`, { filter: { role: "assistant" }, set: { author: "Claude" } });
	assert.equal(bu.json.data.updated, 3);
	const del = await api("POST", `/api/projects/${p.id}/messages/delete`, { ids: [l[0].id, l[1].id] });
	assert.equal(del.json.data.deleted, 2);
	l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => m.seq), [1, 2, 3]);
	const rep = await api("PUT", `/api/projects/${p.id}/messages`, { messages: [{ role: "user", content: "fresh" }] });
	assert.equal(rep.json.data.created, 1);
	assert.equal((await api("GET", `/api/projects/${p.id}/messages`)).json.total, 1);
});

test("loose input shapes", async () => {
	const p = (await api("POST", "/api/projects", { name: "Loose" })).json.data;
	const r = await api("POST", `/api/projects/${p.id}/messages`, [
		{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url" }], timestamp: "2026-10-01T10:00:00+08:00" },
		{ speaker: "assistant", text: "hi", model: "gpt-5", metadata: { tokens: 12 }, time: 1759284000 },
	]);
	assert.equal(r.status, 201);
	const l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.equal(l[0].content, "hello\n[image_url]"); assert.equal(l[0].sent_at, Date.parse("2026-10-01T02:00:00Z"));
	assert.equal(l[1].author, "gpt-5"); assert.equal(l[1].meta.tokens, 12); assert.equal(l[1].sent_at, 1759284000000);
});

test("export json/jsonl/md and re-import round trip", async () => {
	const p = (await api("POST", "/api/projects", { name: "Round Trip", description: "line1\nline2", tool: "Codex", tags: ["x"], messages: [
		{ role: "system", content: "sys" },
		{ role: "user", author: "我", content: "### looks like a heading\n<!-- vcl:turn -->?\n```js\nx\n```", sent_at: "2026-10-01T00:00:00Z" },
		{ role: "assistant", author: "Codex", content: "ok", meta: { files: ["a.ts"] } },
		{ role: "tool", content: "ls -la", format: "code" },
		{ role: "user", content: "next" },
	] })).json.data;
	const md = await api("GET", `/api/projects/${p.id}/export?format=md`);
	assert.match(md.headers.get("content-disposition") ?? "", /attachment/);
	assert.match(md.text, /## 第 2 轮/);
	const p2 = (await api("POST", "/api/projects", { name: "From MD" })).json.data;
	const imp = await api("POST", `/api/projects/${p2.id}/import`, undefined, { raw: md.text });
	assert.equal(imp.json.data.format, "md"); assert.equal(imp.json.data.created, 5);
	const orig = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	const back = (await api("GET", `/api/projects/${p2.id}/messages`)).json.data;
	for (let i = 0; i < orig.length; i++) for (const k of ["role", "author", "content", "format", "sent_at"]) assert.deepEqual(back[i][k], orig[i][k], `${k} #${i}`);
	assert.deepEqual(back[2].meta, { files: ["a.ts"] });

	const jl = await api("GET", `/api/projects/${p.id}/export?format=jsonl`);
	const p3 = (await api("POST", "/api/projects", { name: "From JSONL" })).json.data;
	assert.equal((await api("POST", `/api/projects/${p3.id}/import?format=jsonl`, undefined, { raw: jl.text })).json.data.created, 5);

	const js = await api("GET", `/api/projects/${p.id}/export?format=json`);
	const asNew = await api("POST", "/api/import", undefined, { raw: js.text });
	assert.equal(asNew.json.data.projects[0].status, "created");
	assert.notEqual(asNew.json.data.projects[0].id, p.id);
	await api("PATCH", `/api/projects/${p.id}`, { name: "changed" });
	const restore = await api("POST", "/api/import?mode=restore", undefined, { raw: js.text });
	assert.equal(restore.json.data.projects[0].status, "restored");
	const after = (await api("GET", `/api/projects/${p.id}`)).json.data;
	assert.equal(after.name, "Round Trip"); assert.equal(after.message_count, 5);
	const ids = (await api("GET", `/api/projects/${p.id}/messages`)).json.data.map((m: any) => m.id);
	assert.deepEqual(ids, orig.map((m: any) => m.id));
	const skip = await api("POST", "/api/import?mode=skip", undefined, { raw: js.text });
	assert.equal(skip.json.data.projects[0].status, "skipped");
	const all = await api("GET", "/api/export");
	assert.ok(all.json.projects.length >= 4);
});

test("plain-text transcript import (default speakers)", async () => {
	const p = (await api("POST", "/api/projects", { name: "Transcript" })).json.data;
	const text = "用户：帮我装 docker\n顺便配置镜像源\nClaude: 好的，先执行\n```bash\nuser: not a speaker inside code\ncurl -fsSL get.docker.com | sh\n```\nAI（GPT-5）: 第二条回复\n我: 谢谢";
	const dry = await api("POST", `/api/projects/${p.id}/import?format=text&dry_run=1`, undefined, { raw: text });
	assert.equal(dry.json.data.count, 4);
	await api("POST", `/api/projects/${p.id}/import?format=text`, undefined, { raw: text });
	const l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => [m.role, m.author]), [["user", null], ["assistant", "Claude"], ["assistant", "GPT-5"], ["user", null]]);
	assert.equal(l[0].content, "帮我装 docker\n顺便配置镜像源");
	assert.match(l[1].content, /user: not a speaker inside code/);
});

test("plain-text transcript with custom speaker map A=AI, B=user", async () => {
	const p = (await api("POST", "/api/projects", { name: "AB" })).json.data;
	const text = "B：帮我部署 nginx\nNote: 这一行不是说话人\nA：好的，先检查端口\nA: 80 已占用\nC：执行结果\n$ ss -ltnp\nB:可以";
	const det = await api("POST", "/api/tools/detect-speakers", undefined, { raw: text });
	assert.deepEqual(det.json.data.map((d: any) => d.name).slice(0, 2).sort(), ["A", "B"]);
	const sp = encodeURIComponent("A=AI, B=user，C=tool/bash");
	const r = await api("POST", `/api/projects/${p.id}/import?format=text&speakers=${sp}`, undefined, { raw: text });
	assert.equal(r.json.data.created, 5);
	const l = (await api("GET", `/api/projects/${p.id}/messages`)).json.data;
	assert.deepEqual(l.map((m: any) => [m.role, m.author]), [["user", null], ["assistant", null], ["assistant", null], ["tool", "bash"], ["user", null]]);
	assert.equal(l[0].content, "帮我部署 nginx\nNote: 这一行不是说话人");
	assert.equal(l[4].content, "可以");
	assert.equal((await api("POST", `/api/projects/${p.id}/import?format=text&speakers=A=robot`, undefined, { raw: text })).status, 400);
	assert.equal((await api("POST", `/api/projects/${p.id}/import?format=text&speakers=X=user`, undefined, { raw: text })).status, 400);
	const users = await api("GET", `/api/projects/${p.id}/messages?role=user`);
	assert.equal(users.json.total, 2);
	const both = await api("GET", `/api/projects/${p.id}/messages?role=user,assistant`);
	assert.equal(both.json.total, 4);
	const q = await api("GET", `/api/projects/${p.id}/messages?q=bash`);
	assert.equal(q.json.total, 1);
});

test("admin password login sessions", async () => {
	assert.equal((await api("POST", "/api/auth/login", { password: "nope" }, { token: null })).status, 401);
	const r = await api("POST", "/api/auth/login", { password: "pw-test" }, { token: null });
	assert.equal(r.status, 200);
	const s = r.json.data.token;
	assert.equal((await api("GET", "/api/projects", undefined, { token: s })).status, 200);
	assert.equal((await api("GET", "/api/auth/api-token", undefined, { token: s })).json.data.token, TOKEN);
	await api("POST", "/api/auth/logout", undefined, { token: s });
	assert.equal((await api("GET", "/api/projects", undefined, { token: s })).status, 401);
	assert.equal((await api("GET", "/favicon.svg", undefined, { token: null })).status, 200);
	assert.equal((await api("GET", "/favicon.ico", undefined, { token: null })).status, 200);
});

test("search, stats, backups, openapi, ui", async () => {
	const s = await api("GET", "/api/search?q=docker");
	assert.ok(s.json.data.length >= 1); assert.ok(s.json.data[0].snippet.includes("docker"));
	assert.ok((await api("GET", "/api/stats")).json.data.messages > 0);
	const b = await api("POST", "/api/backups");
	assert.equal(b.status, 201);
	assert.equal((await api("GET", "/api/backups")).json.data.length, 1);
	assert.equal((await api("GET", "/api/openapi.json", undefined, { token: null })).status, 200);
	assert.match((await api("GET", "/", undefined, { token: null })).text, /<html|<!doctype/i);
	const pre = await fetch(BASE + "/api/projects", { method: "OPTIONS" });
	assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), "*");
});
