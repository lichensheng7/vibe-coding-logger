import { db, type MessageRow, type ProjectRow } from "./db.ts";
import { HttpError, now, parseJsonField, slugify, toMs, uid } from "./util.ts";

/* ================================ roles ================================ */
export const ROLES = ["user", "assistant", "system", "tool", "note"] as const;
const ROLE_ALIAS: Record<string, string> = {
	user: "user", human: "user", me: "user", i: "user", "我": "user", "用户": "user", "提问": "user", prompt: "user", question: "user",
	assistant: "assistant", ai: "assistant", bot: "assistant", model: "assistant", agent: "assistant", gpt: "assistant", chatgpt: "assistant",
	claude: "assistant", gemini: "assistant", copilot: "assistant", cursor: "assistant", "助手": "assistant", "回复": "assistant", answer: "assistant",
	system: "system", "系统": "system", developer: "system",
	tool: "tool", function: "tool", tool_call: "tool", tool_result: "tool", observation: "tool", terminal: "tool", shell: "tool", "工具": "tool",
	note: "note", comment: "note", memo: "note", "备注": "note", "笔记": "note",
};
export function normRole(r: unknown): string {
	const k = String(r ?? "").trim().toLowerCase();
	const v = ROLE_ALIAS[k];
	if (!v) throw new HttpError(400, `未知 role "${String(r).slice(0, 30)}"，可用: ${ROLES.join(" / ")}`);
	return v;
}
const FORMATS = new Set(["markdown", "text", "code", "json", "html"]);

/* ============================== serializers ============================== */
export const outProject = (p: ProjectRow & { message_count?: number; turn_count?: number; last_message_at?: number | null }) => ({
	id: p.id, name: p.name, slug: p.slug, description: p.description, tool: p.tool, model: p.model,
	tags: parseJsonField(p.tags) ?? [], meta: parseJsonField(p.meta) ?? {}, archived: !!p.archived,
	...(p.message_count !== undefined ? { message_count: p.message_count, turn_count: p.turn_count ?? 0, last_message_at: p.last_message_at ?? null } : {}),
	created_at: p.created_at, updated_at: p.updated_at,
});
export const outMessage = (m: MessageRow & { turn?: number }) => ({
	id: m.id, project_id: m.project_id, seq: m.seq, ...(m.turn !== undefined ? { turn: m.turn } : {}),
	role: m.role, author: m.author, content: m.content, format: m.format, ext_id: m.ext_id,
	meta: parseJsonField(m.meta) ?? {}, sent_at: m.sent_at, created_at: m.created_at, updated_at: m.updated_at,
});

/* ================================ projects ================================ */
const str = (v: unknown, max = 100_000) => (v == null ? null : String(v).slice(0, max));
const jsonOrNull = (v: unknown, kind: "array" | "object") => {
	if (v == null) return null;
	if (kind === "array" && !Array.isArray(v)) throw new HttpError(400, "tags 必须是字符串数组");
	if (kind === "object" && (typeof v !== "object" || Array.isArray(v))) throw new HttpError(400, "meta 必须是对象");
	return JSON.stringify(v);
};

function uniqueSlug(base: string, exceptId?: string) {
	const b = slugify(base) || "project";
	let s = b, i = 2;
	while (db.get("SELECT 1 FROM projects WHERE slug=? AND id IS NOT ?", s, exceptId ?? null)) s = `${b}-${i++}`;
	return s;
}

export function getProject(idOrSlug: string): ProjectRow {
	const p = db.get<ProjectRow>("SELECT * FROM projects WHERE id=? OR slug=?", idOrSlug, idOrSlug);
	if (!p) throw new HttpError(404, `项目不存在: ${idOrSlug}`);
	return p;
}

export function projectWithStats(id: string) {
	return db.get(`SELECT p.*, (SELECT COUNT(*) FROM messages WHERE project_id=p.id) message_count,
		(SELECT COUNT(*) FROM messages WHERE project_id=p.id AND role='user') turn_count,
		(SELECT MAX(COALESCE(sent_at, created_at)) FROM messages WHERE project_id=p.id) last_message_at
		FROM projects p WHERE p.id=?`, id);
}

export function listProjects(opts: { q?: string; tag?: string; archived?: string; limit: number; offset: number }) {
	const where: string[] = [], args: unknown[] = [];
	if (opts.q) { where.push("(p.name LIKE ? OR p.description LIKE ? OR p.slug LIKE ?)"); const l = `%${opts.q}%`; args.push(l, l, l); }
	if (opts.tag) { where.push("EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value=?)"); args.push(opts.tag); }
	if (opts.archived === "only") where.push("p.archived=1");
	else if (opts.archived !== "all") where.push("p.archived=0");
	const w = where.length ? "WHERE " + where.join(" AND ") : "";
	const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM projects p ${w}`, ...args)!.n;
	const rows = db.all(`SELECT p.*, (SELECT COUNT(*) FROM messages WHERE project_id=p.id) message_count,
		(SELECT COUNT(*) FROM messages WHERE project_id=p.id AND role='user') turn_count,
		(SELECT MAX(COALESCE(sent_at, created_at)) FROM messages WHERE project_id=p.id) last_message_at
		FROM projects p ${w} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, ...args, opts.limit, opts.offset);
	return { total, items: rows.map(outProject) };
}

export function createProject(b: any, keep?: { id?: string; created_at?: number; updated_at?: number }) {
	const name = String(b?.name ?? "").trim();
	if (!name) throw new HttpError(400, "name 必填");
	const t = now();
	const id = keep?.id ?? uid("p_");
	db.run(`INSERT INTO projects (id,name,slug,description,tool,model,tags,meta,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		id, name.slice(0, 200), uniqueSlug(b.slug ?? name), str(b.description), str(b.tool, 200), str(b.model, 200),
		jsonOrNull(b.tags, "array"), jsonOrNull(b.meta, "object"), b.archived ? 1 : 0, keep?.created_at ?? t, keep?.updated_at ?? t);
	return getProject(id);
}

export function updateProject(idOrSlug: string, b: any) {
	const p = getProject(idOrSlug);
	const sets: string[] = [], args: unknown[] = [];
	const set = (col: string, v: unknown) => { sets.push(`${col}=?`); args.push(v); };
	if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) throw new HttpError(400, "name 不能为空"); set("name", n.slice(0, 200)); }
	if (b.slug !== undefined) set("slug", uniqueSlug(String(b.slug), p.id));
	if (b.description !== undefined) set("description", str(b.description));
	if (b.tool !== undefined) set("tool", str(b.tool, 200));
	if (b.model !== undefined) set("model", str(b.model, 200));
	if (b.tags !== undefined) set("tags", jsonOrNull(b.tags, "array"));
	if (b.meta !== undefined) set("meta", jsonOrNull(b.meta, "object"));
	if (b.archived !== undefined) set("archived", b.archived ? 1 : 0);
	set("updated_at", now());
	db.run(`UPDATE projects SET ${sets.join(",")} WHERE id=?`, ...args, p.id);
	return getProject(p.id);
}

export const deleteProject = (idOrSlug: string) => { const p = getProject(idOrSlug); db.run("DELETE FROM projects WHERE id=?", p.id); return { id: p.id }; };
const touch = (projectId: string) => db.run("UPDATE projects SET updated_at=? WHERE id=?", now(), projectId);

/* ================================ messages ================================ */
/** Accepts loose shapes: OpenAI-style content parts, `text` / `message` aliases, `name`/`model` as author, etc. */
function contentOf(m: any): string {
	let c = m.content ?? m.text ?? m.message ?? m.body ?? "";
	if (Array.isArray(c)) c = c.map((p: any) => (typeof p === "string" ? p : p?.text ?? p?.content ?? (p?.type ? `[${p.type}]` : JSON.stringify(p)))).join("\n");
	else if (typeof c === "object" && c) c = c.text ?? JSON.stringify(c, null, 2);
	return String(c);
}

export type MsgInput = {
	role: string; author: string | null; content: string; format: string; ext_id: string | null;
	meta: string | null; sent_at: number | null; id?: string; created_at?: number; updated_at?: number;
};
export function normMessage(m: any, i = 0, keepIds = false): MsgInput {
	if (typeof m !== "object" || m == null || Array.isArray(m)) throw new HttpError(400, `第 ${i + 1} 条消息格式错误：应为对象`);
	try {
		const format = String(m.format ?? "markdown").toLowerCase();
		if (!FORMATS.has(format)) throw new HttpError(400, `format 只能是 ${[...FORMATS].join("/")}`);
		const meta = m.meta ?? m.metadata;
		const out: MsgInput = {
			role: normRole(m.role ?? m.speaker ?? m.from ?? m.sender),
			author: str(m.author ?? m.name ?? m.model ?? null, 200),
			content: contentOf(m),
			format,
			ext_id: str(m.ext_id ?? m.external_id ?? m.client_id ?? null, 200),
			meta: meta == null ? null : jsonOrNull(meta, "object"),
			sent_at: toMs(m.sent_at ?? m.timestamp ?? m.time ?? m.date ?? null),
		};
		if (keepIds) { if (m.id) out.id = String(m.id); if (m.created_at) out.created_at = toMs(m.created_at)!; if (m.updated_at) out.updated_at = toMs(m.updated_at)!; }
		return out;
	} catch (e: any) {
		if (e instanceof HttpError) throw new HttpError(e.status, `第 ${i + 1} 条消息：${e.message}`);
		throw e;
	}
}

const maxSeq = (pid: string) => db.get<{ n: number }>("SELECT COALESCE(MAX(seq),0) n FROM messages WHERE project_id=?", pid)!.n;
export function renumber(pid: string) {
	db.run(`UPDATE messages SET seq = r.rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY seq, created_at, id) rn FROM messages WHERE project_id=?) r WHERE messages.id = r.id`, pid);
}
const msgById = (id: string) => {
	const m = db.get<MessageRow>("SELECT * FROM messages WHERE id=?", id);
	if (!m) throw new HttpError(404, `消息不存在: ${id}`);
	return m;
};
export const turnOf = (m: MessageRow) =>
	db.get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE project_id=? AND role='user' AND seq<=?", m.project_id, m.seq)!.n;
export const getMessage = (id: string) => { const m = msgById(id); return outMessage({ ...m, turn: turnOf(m) }); };

/** Resolve where new messages go: returns the 1-based seq the first one will take. */
function insertionSeq(pid: string, opt: { position?: unknown; after_id?: unknown; before_id?: unknown }) {
	const end = maxSeq(pid) + 1;
	if (opt.after_id) { const m = msgById(String(opt.after_id)); if (m.project_id !== pid) throw new HttpError(400, "after_id 不属于该项目"); return m.seq + 1; }
	if (opt.before_id) { const m = msgById(String(opt.before_id)); if (m.project_id !== pid) throw new HttpError(400, "before_id 不属于该项目"); return m.seq; }
	if (opt.position != null && opt.position !== "") {
		const p = Number(opt.position);
		if (!Number.isInteger(p) || p < 1) throw new HttpError(400, "position 必须是 >=1 的整数");
		return Math.min(p, end);
	}
	return end;
}

export type InsertOpts = { position?: unknown; after_id?: unknown; before_id?: unknown; on_duplicate?: string; keepIds?: boolean };
/**
 * Insert messages in order. Messages carrying an ext_id already present in the project are
 * skipped (default), updated in place (on_duplicate=update), or rejected (on_duplicate=error) — so a
 * pushing agent can safely retry.
 */
export function insertMessages(pidOrSlug: string, raw: any[], opts: InsertOpts = {}) {
	const p = getProject(pidOrSlug);
	if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, "messages 不能为空");
	if (raw.length > 50_000) throw new HttpError(400, "单次最多 50000 条");
	const items = raw.map((m, i) => normMessage(m, i, opts.keepIds));
	const dup = (opts.on_duplicate ?? "skip").toLowerCase();
	if (!["skip", "update", "error"].includes(dup)) throw new HttpError(400, "on_duplicate 只能是 skip/update/error");
	return db.tx(() => {
		const results: { id: string; seq: number; status: "created" | "skipped" | "updated"; ext_id: string | null }[] = [];
		const fresh: MsgInput[] = [];
		const seenExt = new Set<string>();
		for (const it of items) {
			if (it.ext_id) {
				if (seenExt.has(it.ext_id)) throw new HttpError(400, `同一批次 ext_id 重复: ${it.ext_id}`);
				seenExt.add(it.ext_id);
				const ex = db.get<MessageRow>("SELECT * FROM messages WHERE project_id=? AND ext_id=?", p.id, it.ext_id);
				if (ex) {
					if (dup === "error") throw new HttpError(409, `ext_id 已存在: ${it.ext_id}`, { id: ex.id });
					if (dup === "update") {
						db.run("UPDATE messages SET role=?, author=?, content=?, format=?, meta=?, sent_at=?, updated_at=? WHERE id=?",
							it.role, it.author, it.content, it.format, it.meta, it.sent_at, now(), ex.id);
						results.push({ id: ex.id, seq: ex.seq, status: "updated", ext_id: it.ext_id });
					} else results.push({ id: ex.id, seq: ex.seq, status: "skipped", ext_id: it.ext_id });
					continue;
				}
			}
			fresh.push(it);
			results.push({ id: "", seq: 0, status: "created", ext_id: it.ext_id });
		}
		if (fresh.length) {
			const start = insertionSeq(p.id, opts);
			db.run("UPDATE messages SET seq = seq + ? WHERE project_id=? AND seq >= ?", fresh.length, p.id, start);
			const t = now();
			let k = 0;
			for (const r of results) {
				if (r.status !== "created") continue;
				const it = fresh[k];
				let id = it.id && !db.get("SELECT 1 FROM messages WHERE id=?", it.id) ? it.id : uid("m_");
				const seq = start + k++;
				db.run(`INSERT INTO messages (id,project_id,seq,role,author,content,format,ext_id,meta,sent_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
					id, p.id, seq, it.role, it.author, it.content, it.format, it.ext_id, it.meta, it.sent_at, it.created_at ?? t, it.updated_at ?? t);
				r.id = id; r.seq = seq;
			}
		}
		touch(p.id);
		return {
			project_id: p.id,
			created: results.filter((r) => r.status === "created").length,
			updated: results.filter((r) => r.status === "updated").length,
			skipped: results.filter((r) => r.status === "skipped").length,
			items: results,
		};
	});
}

export function listMessages(pidOrSlug: string, o: { role?: string; author?: string; q?: string; turn?: number; from_seq?: number; limit: number; offset: number }) {
	const p = getProject(pidOrSlug);
	const where = ["m.project_id=?"], args: unknown[] = [p.id];
	if (o.role) { where.push("m.role=?"); args.push(normRole(o.role)); }
	if (o.author) { where.push("m.author=?"); args.push(o.author); }
	if (o.q) { where.push("m.content LIKE ?"); args.push(`%${o.q}%`); }
	if (o.from_seq) { where.push("m.seq>=?"); args.push(o.from_seq); }
	const base = `SELECT m.*, (SELECT COUNT(*) FROM messages u WHERE u.project_id=m.project_id AND u.role='user' AND u.seq<=m.seq) turn FROM messages m WHERE ${where.join(" AND ")}`;
	const sql = o.turn != null ? `SELECT * FROM (${base}) WHERE turn=?` : base;
	if (o.turn != null) args.push(o.turn);
	const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM (${sql})`, ...args)!.n;
	const rows = db.all<MessageRow & { turn: number }>(`${sql} ORDER BY seq LIMIT ? OFFSET ?`, ...args, o.limit, o.offset);
	return { total, items: rows.map(outMessage) };
}

/** Messages grouped into turns: each user message opens a turn, everything after it (until the next user message) belongs to it. */
export function listTurns(pidOrSlug: string) {
	const p = getProject(pidOrSlug);
	const rows = db.all<MessageRow>("SELECT * FROM messages WHERE project_id=? ORDER BY seq", p.id);
	const turns: { turn: number; prompt: any; replies: any[] }[] = [];
	let cur: { turn: number; prompt: any; replies: any[] } | null = null;
	for (const m of rows) {
		if (m.role === "user") { cur = { turn: turns.length + 1, prompt: outMessage(m), replies: [] }; turns.push(cur); }
		else if (cur) cur.replies.push(outMessage(m));
		else { cur = { turn: 0, prompt: null, replies: [outMessage(m)] }; turns.push(cur); }
	}
	return turns;
}

export function updateMessage(id: string, b: any) {
	const m = msgById(id);
	const sets: string[] = [], args: unknown[] = [];
	const set = (col: string, v: unknown) => { sets.push(`${col}=?`); args.push(v); };
	if (b.role !== undefined) set("role", normRole(b.role));
	if (b.author !== undefined) set("author", str(b.author, 200));
	if (b.content !== undefined || b.text !== undefined) set("content", contentOf(b));
	if (b.format !== undefined) { const f = String(b.format).toLowerCase(); if (!FORMATS.has(f)) throw new HttpError(400, "format 不合法"); set("format", f); }
	if (b.meta !== undefined) set("meta", jsonOrNull(b.meta, "object"));
	if (b.sent_at !== undefined) set("sent_at", toMs(b.sent_at));
	if (b.ext_id !== undefined) {
		const e = str(b.ext_id, 200);
		if (e && db.get("SELECT 1 FROM messages WHERE project_id=? AND ext_id=? AND id<>?", m.project_id, e, m.id)) throw new HttpError(409, `ext_id 已存在: ${e}`);
		set("ext_id", e);
	}
	return db.tx(() => {
		if (sets.length) { set("updated_at", now()); db.run(`UPDATE messages SET ${sets.join(",")} WHERE id=?`, ...args, m.id); }
		if (b.position !== undefined || b.after_id !== undefined || b.before_id !== undefined) moveMessage(m.id, b);
		touch(m.project_id);
		return getMessage(m.id);
	});
}

/** Move one message to a new position (position = target seq, or after_id / before_id). */
export function moveMessage(id: string, b: any) {
	return db.tx(() => {
		const m = msgById(id);
		const n = maxSeq(m.project_id);
		let to: number;
		if (b.after_id) { const a = msgById(String(b.after_id)); if (a.project_id !== m.project_id) throw new HttpError(400, "after_id 不属于该项目"); to = a.seq < m.seq ? a.seq + 1 : a.seq; }
		else if (b.before_id) { const a = msgById(String(b.before_id)); if (a.project_id !== m.project_id) throw new HttpError(400, "before_id 不属于该项目"); to = a.seq > m.seq ? a.seq - 1 : a.seq; }
		else { to = Number(b.position); if (!Number.isInteger(to) || to < 1) throw new HttpError(400, "position 必须是 >=1 的整数"); }
		to = Math.min(Math.max(1, to), n);
		if (to < m.seq) db.run("UPDATE messages SET seq=seq+1 WHERE project_id=? AND seq>=? AND seq<?", m.project_id, to, m.seq);
		else if (to > m.seq) db.run("UPDATE messages SET seq=seq-1 WHERE project_id=? AND seq>? AND seq<=?", m.project_id, m.seq, to);
		db.run("UPDATE messages SET seq=? WHERE id=?", to, m.id);
		touch(m.project_id);
		return getMessage(m.id);
	});
}

/** Replace the whole order with an explicit id list (must contain every message exactly once). */
export function reorder(pidOrSlug: string, ids: unknown) {
	const p = getProject(pidOrSlug);
	if (!Array.isArray(ids)) throw new HttpError(400, "ids 必须是数组");
	const all = db.all<{ id: string }>("SELECT id FROM messages WHERE project_id=?", p.id).map((r) => r.id);
	const set = new Set(ids.map(String));
	if (set.size !== ids.length || set.size !== all.length || !all.every((i) => set.has(i))) throw new HttpError(400, "ids 必须恰好包含该项目的全部消息各一次");
	db.tx(() => { ids.forEach((id, i) => db.run("UPDATE messages SET seq=? WHERE id=?", i + 1, String(id))); touch(p.id); });
	return { project_id: p.id, count: ids.length };
}

export function deleteMessages(pidOrSlug: string | null, ids: string[]) {
	if (!ids.length) throw new HttpError(400, "ids 不能为空");
	return db.tx(() => {
		const pids = new Set<string>(); let n = 0;
		const scope = pidOrSlug ? getProject(pidOrSlug).id : null;
		for (const id of ids) {
			const m = db.get<MessageRow>("SELECT * FROM messages WHERE id=?", id);
			if (!m || (scope && m.project_id !== scope)) continue;
			db.run("DELETE FROM messages WHERE id=?", id); pids.add(m.project_id); n++;
		}
		for (const pid of pids) { renumber(pid); touch(pid); }
		return { deleted: n };
	});
}

/** Bulk change identity/format, e.g. rename every "assistant/ChatGPT" to "assistant/GPT-5". */
export function bulkUpdate(pidOrSlug: string, b: any) {
	const p = getProject(pidOrSlug);
	const set = b?.set ?? {};
	const sets: string[] = [], sargs: unknown[] = [];
	if (set.role !== undefined) { sets.push("role=?"); sargs.push(normRole(set.role)); }
	if (set.author !== undefined) { sets.push("author=?"); sargs.push(str(set.author, 200)); }
	if (set.format !== undefined) { const f = String(set.format).toLowerCase(); if (!FORMATS.has(f)) throw new HttpError(400, "format 不合法"); sets.push("format=?"); sargs.push(f); }
	if (!sets.length) throw new HttpError(400, "set 至少包含 role / author / format 之一");
	const where = ["project_id=?"], wargs: unknown[] = [p.id];
	if (Array.isArray(b.ids) && b.ids.length) { where.push(`id IN (${b.ids.map(() => "?").join(",")})`); wargs.push(...b.ids.map(String)); }
	const f = b.filter ?? {};
	if (f.role !== undefined) { where.push("role=?"); wargs.push(normRole(f.role)); }
	if (f.author !== undefined) { if (f.author === null) where.push("author IS NULL"); else { where.push("author=?"); wargs.push(String(f.author)); } }
	if (where.length === 1 && !b.all) throw new HttpError(400, "请提供 ids 或 filter（或 all: true 作用于全部消息）");
	const r = db.run(`UPDATE messages SET ${sets.join(",")}, updated_at=? WHERE ${where.join(" AND ")}`, ...sargs, now(), ...wargs);
	touch(p.id);
	return { updated: r.changes };
}

export function search(q: string, projectId: string | null, limit: number) {
	if (!q) throw new HttpError(400, "q 必填");
	const args: unknown[] = [`%${q}%`];
	let w = "m.content LIKE ?";
	if (projectId) { w += " AND m.project_id=?"; args.push(getProject(projectId).id); }
	return db.all<MessageRow & { project_name: string }>(`SELECT m.*, p.name project_name FROM messages m JOIN projects p ON p.id=m.project_id WHERE ${w} ORDER BY m.updated_at DESC LIMIT ?`, ...args, limit)
		.map((m) => {
			const i = m.content.toLowerCase().indexOf(q.toLowerCase());
			const snippet = (i > 40 ? "…" : "") + m.content.slice(Math.max(0, i - 40), i + q.length + 80) + (i + q.length + 80 < m.content.length ? "…" : "");
			return { ...outMessage(m), project_name: m.project_name, snippet };
		});
}
