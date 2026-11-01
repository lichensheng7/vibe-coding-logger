import { db, type MessageRow, type ProjectRow } from "./db.ts";
import { HttpError, now } from "./util.ts";
import { createProject, getProject, insertMessages, outMessage, outProject, normRole } from "./store.ts";

export const EXPORT_FORMAT = "vibe-coding-logger";
export const EXPORT_VERSION = 1;

function projectBundle(p: ProjectRow) {
	const msgs = db.all<MessageRow>("SELECT * FROM messages WHERE project_id=? ORDER BY seq", p.id);
	return { ...outProject(p), messages: msgs.map((m) => { const { project_id, ...rest } = outMessage(m); return rest; }) };
}

/** JSON envelope — the same shape for one project or a full backup, so either can be re-imported. */
export function exportJson(ids?: string[]) {
	const rows = ids ? ids.map(getProject) : db.all<ProjectRow>("SELECT * FROM projects ORDER BY created_at");
	return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), projects: rows.map(projectBundle) };
}

export function exportJsonl(idOrSlug: string) {
	const p = getProject(idOrSlug);
	return db.all<MessageRow>("SELECT * FROM messages WHERE project_id=? ORDER BY seq", p.id)
		.map((m) => { const { project_id, ...rest } = outMessage(m); return JSON.stringify(rest); }).join("\n") + "\n";
}

/* ------------------------------- Markdown -------------------------------- */
const ICON: Record<string, string> = { user: "🧑", assistant: "🤖", system: "⚙️", tool: "🛠️", note: "📝" };
const LABEL: Record<string, string> = { user: "用户", assistant: "AI", system: "系统", tool: "工具", note: "备注" };
const iso = (t: number | null) => (t ? new Date(t).toISOString() : "");

export function exportMarkdown(idOrSlug: string) {
	const p = getProject(idOrSlug);
	const P = outProject(p);
	const msgs = db.all<MessageRow>("SELECT * FROM messages WHERE project_id=? ORDER BY seq", p.id);
	const out: string[] = [`# ${p.name}`, ""];
	if (p.description) out.push(...p.description.split("\n").map((l) => `> ${l}`), "");
	const facts = [p.tool && `工具：${p.tool}`, p.model && `模型：${p.model}`, P.tags.length && `标签：${P.tags.join(", ")}`, `消息：${msgs.length} 条`, `导出：${new Date().toISOString()}`].filter(Boolean);
	out.push(...facts.map((f) => `- ${f}`), "");
	out.push(`<!-- vcl:project ${JSON.stringify({ name: p.name, description: p.description, tool: p.tool, model: p.model, tags: P.tags })} -->`, "");
	let turn = 0;
	for (const m of msgs) {
		if (m.role === "user") { turn++; out.push("<!-- vcl:turn -->", "---", "", `## 第 ${turn} 轮`, ""); }
		const meta: any = { role: m.role };
		if (m.author) meta.author = m.author;
		if (m.format !== "markdown") meta.format = m.format;
		if (m.sent_at) meta.sent_at = iso(m.sent_at);
		if (m.ext_id) meta.ext_id = m.ext_id;
		const mm = m.meta ? JSON.parse(m.meta) : null; if (mm && Object.keys(mm).length) meta.meta = mm;
		out.push(`<!-- vcl:msg ${JSON.stringify(meta).replace(/-->/g, "--\\u003e")} -->`);
		out.push(`### ${ICON[m.role] ?? ""} ${LABEL[m.role] ?? m.role}${m.author ? ` · ${m.author}` : ""}${m.sent_at ? `  \`${iso(m.sent_at).replace("T", " ").slice(0, 19)}\`` : ""}`, "");
		const body = m.format === "code" || m.format === "json" ? "```" + (m.format === "json" ? "json" : "") + "\n" + m.content + "\n```" : m.content;
		out.push(body, "");
	}
	return out.join("\n");
}

/** Parses Markdown produced by exportMarkdown (lossless round-trip of role/author/format/time/meta). */
export function parseMarkdown(md: string): { project?: any; messages: any[] } {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	let project: any;
	const messages: any[] = [];
	let cur: any = null, buf: string[] = [];
	const flush = () => {
		if (!cur) return;
		let b = buf;
		const ti = b.findIndex((l) => l.trim() === "<!-- vcl:turn -->"); if (ti >= 0) b = b.slice(0, ti);
		if (b.length && /^###\s/.test(b[0])) b = b.slice(1);
		let text = b.join("\n").replace(/^\n+|\n+$/g, "");
		if ((cur.format === "code" || cur.format === "json") && /^```[\w-]*\n[\s\S]*\n```$/.test(text)) text = text.replace(/^```[\w-]*\n/, "").replace(/\n```$/, "");
		messages.push({ ...cur, content: text });
		cur = null; buf = [];
	};
	for (const l of lines) {
		const pm = l.match(/^<!-- vcl:project (.*) -->$/);
		if (pm) { try { project = JSON.parse(pm[1]); } catch {} continue; }
		const mm = l.match(/^<!-- vcl:msg (.*) -->$/);
		if (mm) { flush(); try { cur = JSON.parse(mm[1]); } catch { throw new HttpError(400, `无法解析消息标记: ${l.slice(0, 80)}`); } continue; }
		if (cur) buf.push(l);
	}
	flush();
	if (!messages.length) throw new HttpError(400, "没有找到 vcl:msg 标记。手写记录请用 format=text（\"用户:\" / \"AI:\" 开头分段）");
	return { project, messages };
}

/* -------------------------- loose plain-text transcript -------------------------- */
// "用户: …" / "我：" / "User:" / "AI:" / "Assistant:" / "Claude:" / "[tool] …" start a new message;
// following lines belong to it. Custom speakers can be mapped with ?speakers=Name=role,Other=role
export function parseTranscript(text: string, speakers: Record<string, string> = {}): any[] {
	const known: Record<string, string> = {
		"用户": "user", "我": "user", user: "user", me: "user", human: "user", "you": "user", "q": "user", "问": "user",
		ai: "assistant", assistant: "assistant", "助手": "assistant", bot: "assistant", chatgpt: "assistant", gpt: "assistant", claude: "assistant",
		gemini: "assistant", cursor: "assistant", copilot: "assistant", "a": "assistant", "答": "assistant",
		system: "system", "系统": "system", tool: "tool", "工具": "tool", terminal: "tool", note: "note", "备注": "note",
	};
	for (const [k, v] of Object.entries(speakers)) known[k.toLowerCase()] = normRole(v);
	const names = Object.keys(known).sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const re = new RegExp(`^\\s*(?:\\*\\*|#+\\s*)?\\[?(${names.join("|")})\\]?(?:\\s*[（(]([^）)]{1,60})[）)])?(?:\\*\\*)?\\s*[:：]\\s?(.*)$`, "i");
	const out: any[] = []; let cur: any = null;
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		const m = line.match(re);
		if (m) {
			if (cur) out.push(cur);
			const who = m[1];
			const role = known[who.toLowerCase()];
			const generic = ["用户", "我", "user", "me", "human", "you", "q", "问", "ai", "assistant", "助手", "bot", "a", "答", "system", "系统", "tool", "工具", "note", "备注"].includes(who.toLowerCase());
			cur = { role, author: m[2] ?? (generic ? null : who), content: m[3] ?? "" };
		} else if (cur) cur.content += (cur.content ? "\n" : "") + line;
	}
	if (cur) out.push(cur);
	for (const m of out) m.content = m.content.replace(/^\n+|\s+$/g, "");
	if (!out.length) throw new HttpError(400, "没识别到说话人。每段以 \"用户:\" / \"AI:\" / \"Claude:\" 等开头，或用 speakers 参数映射自定义名字");
	return out;
}

/* --------------------------------- import --------------------------------- */
/** Extract a messages array from whatever JSON the caller sent. */
export function messagesFromJson(data: any): any[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.messages)) return data.messages;
	if (Array.isArray(data?.projects) && data.projects.length === 1) return data.projects[0].messages ?? [];
	if (Array.isArray(data?.projects)) throw new HttpError(400, "这是多项目备份，请用 POST /api/import 导入");
	throw new HttpError(400, "JSON 里没有找到消息数组（支持: [...] / {messages:[...]} / 导出文件）");
}
export const parseJsonl = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
	try { return JSON.parse(l); } catch { throw new HttpError(400, `JSONL 第 ${i + 1} 行不是合法 JSON`); }
});

/** Import a whole export/backup file. mode=new: always new projects; restore: keep ids, replace existing; skip: keep ids, skip existing. */
export function importBundle(data: any, mode = "new") {
	if (!["new", "restore", "skip"].includes(mode)) throw new HttpError(400, "mode 只能是 new / restore / skip");
	let projects: any[];
	if (Array.isArray(data?.projects)) projects = data.projects;
	else if (data?.name && Array.isArray(data?.messages)) projects = [data];
	else throw new HttpError(400, "不是有效的导出文件（缺少 projects 数组）");
	return db.tx(() => {
		const results: any[] = [];
		for (const [i, pj] of projects.entries()) {
			if (!pj?.name) throw new HttpError(400, `第 ${i + 1} 个项目缺少 name`);
			const exists = pj.id ? db.get<ProjectRow>("SELECT * FROM projects WHERE id=?", pj.id) : undefined;
			if (exists && mode === "skip") { results.push({ id: exists.id, name: exists.name, status: "skipped" }); continue; }
			if (exists && mode === "restore") db.run("DELETE FROM projects WHERE id=?", exists.id);
			const keep = mode === "new" ? undefined : { id: pj.id, created_at: toMsSafe(pj.created_at), updated_at: toMsSafe(pj.updated_at) };
			const body = { ...pj };
			if (mode !== "new" && exists) body.slug = pj.slug; // reuse slug after delete
			const p = createProject(body, keep);
			const msgs = Array.isArray(pj.messages) ? pj.messages : [];
			if (msgs.length) insertMessages(p.id, msgs, { keepIds: mode !== "new", on_duplicate: "skip" });
			if (keep?.updated_at) db.run("UPDATE projects SET updated_at=? WHERE id=?", keep.updated_at, p.id);
			results.push({ id: p.id, name: p.name, slug: p.slug, messages: msgs.length, status: mode !== "new" && exists ? "restored" : "created" });
		}
		return { mode, imported_at: now(), projects: results };
	});
}
const toMsSafe = (v: unknown) => { if (v == null) return undefined; const n = typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(n) ? n : undefined; };
