import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { CONFIG } from "./config.ts";

mkdirSync(CONFIG.dataDir, { recursive: true });
export const sqlite = new DatabaseSync(CONFIG.dbPath);
sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS projects (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	slug        TEXT NOT NULL UNIQUE,
	description TEXT,
	tool        TEXT,            -- 聊天工具/Agent：Cursor、Claude Code、ChatGPT…
	model       TEXT,            -- 默认模型
	tags        TEXT,            -- JSON array
	meta        TEXT,            -- JSON object
	archived    INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id          TEXT PRIMARY KEY,
	project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	seq         INTEGER NOT NULL,          -- 1..N，项目内连续顺序
	role        TEXT NOT NULL,             -- user | assistant | system | tool | note
	author      TEXT,                      -- 具体身份：我 / GPT-5 / Claude Code / bash …
	content     TEXT NOT NULL DEFAULT '',
	format      TEXT NOT NULL DEFAULT 'markdown', -- markdown | text | code | json
	ext_id      TEXT,                      -- 调用方自带 ID，用于幂等推送
	meta        TEXT,                      -- JSON object（工具调用、文件改动、token 数…）
	sent_at     INTEGER,                   -- 原始聊天时间（可选）
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_project_seq ON messages(project_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_ext ON messages(project_id, ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

type Arg = string | number | bigint | null | Uint8Array;
const norm = (a: unknown[]): Arg[] => a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Arg)));
const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
const stmt = (sql: string) => { let s = cache.get(sql); if (!s) { s = sqlite.prepare(sql); cache.set(sql, s); } return s; };
let depth = 0;

export const db = {
	all<T = any>(sql: string, ...args: unknown[]): T[] { return stmt(sql).all(...norm(args)) as T[]; },
	get<T = any>(sql: string, ...args: unknown[]): T | undefined { return stmt(sql).get(...norm(args)) as T | undefined; },
	run(sql: string, ...args: unknown[]) { const r = stmt(sql).run(...norm(args)); return { changes: Number(r.changes) }; },
	/** Re-entrant transaction (nested calls join the outer one). */
	tx<T>(fn: () => T): T {
		if (depth > 0) return fn();
		sqlite.exec("BEGIN IMMEDIATE"); depth++;
		try { const r = fn(); depth--; sqlite.exec("COMMIT"); return r; } catch (e) { depth--; sqlite.exec("ROLLBACK"); throw e; }
	},
};

export const getSetting = (k: string) => db.get<{ v: string }>("SELECT v FROM settings WHERE k=?", k)?.v;
export const setSetting = (k: string, v: string) => db.run("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);

export type ProjectRow = {
	id: string; name: string; slug: string; description: string | null; tool: string | null; model: string | null;
	tags: string | null; meta: string | null; archived: number; created_at: number; updated_at: number;
};
export type MessageRow = {
	id: string; project_id: string; seq: number; role: string; author: string | null; content: string; format: string;
	ext_id: string | null; meta: string | null; sent_at: number | null; created_at: number; updated_at: number;
};
