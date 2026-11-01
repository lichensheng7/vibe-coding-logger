export class HttpError extends Error {
	status: number; details?: unknown;
	constructor(status: number, message: string, details?: unknown) { super(message); this.status = status; this.details = details; }
}
export const now = () => Date.now();
export const uid = (p = "") => p + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function timingSafeEqual(a: string, b: string) {
	const enc = new TextEncoder(); const x = enc.encode(a), y = enc.encode(b);
	if (x.length !== y.length) return false;
	let r = 0; for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
	return r === 0;
}

/** Accepts ms epoch, seconds epoch, or any Date-parsable string. Returns ms or null. */
export function toMs(v: unknown): number | null {
	if (v == null || v === "") return null;
	if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
	if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return toMs(Number(v));
	const t = Date.parse(String(v));
	if (Number.isNaN(t)) throw new HttpError(400, `无法解析时间: ${String(v).slice(0, 40)}`);
	return t;
}

export const slugify = (s: string) =>
	s.normalize("NFKC").trim().toLowerCase().replace(/[\s_/\\]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export const parseJsonField = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
