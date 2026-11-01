const env = process.env;
const num = (v: string | undefined, d: number) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : d; };

export const CONFIG = {
	port: num(env.PORT, 8080),
	host: env.HOST ?? "0.0.0.0",
	dataDir: env.DATA_DIR ?? "./data",
	get dbPath() { return env.DB_PATH ?? `${this.dataDir}/vibe-coding-logger.db`; },
	/** Comma-separated Bearer tokens. Empty = one is generated on first start and saved to DATA_DIR/api_token. */
	apiTokens: (env.API_TOKEN ?? "").split(",").map((s) => s.trim()).filter(Boolean),
	/** Allow GET requests without a token (read-only public demo). */
	publicRead: /^(1|true|yes)$/i.test(env.PUBLIC_READ ?? ""),
	maxBodyMb: num(env.MAX_BODY_MB, 64),
	corsOrigin: env.CORS_ORIGIN ?? "*",
	backupKeep: num(env.BACKUP_KEEP, 7),
	backupIntervalHours: num(env.BACKUP_INTERVAL_HOURS, 24),
};
