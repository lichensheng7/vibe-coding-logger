<p align="center"><img src="docs/logo.png" width="112" alt="Vibe Coding Logger"></p>

<h1 align="center">Vibe Coding Logger</h1>

自托管的 vibe coding 聊天记录服务：把你和 AI（Cursor、Claude Code、ChatGPT、Codex…）的对话按项目清晰存下来，支持后续修改内容和身份、导入导出，全部能力通过 REST API 提供，方便再用 V0 等工具做前端。

- **项目隔离**：每段聊天记录一个 project，可设工具、模型、标签、描述，可归档
- **不规则数据友好**：一问多答、工具输出、系统提示都按原顺序存；每条 `user` 消息自动开启新一"轮"（turn），无需调用方计算
- **两种录入方式**
  1. 手动：自带的简易界面逐条添加（添加后自动切换 用户/AI 角色）、任意位置插入
  2. AI 整理推送：把乱序记录交给另一个 AI，按 [docs/AI_PROMPT.md](docs/AI_PROMPT.md) 建项目 → 逐条推送；`ext_id` 幂等，失败可安全重试
- **随时修正**：单条改内容/角色/身份/格式/时间，移动位置；勾选多条（支持 Shift 连选、选中整轮）后批量改角色/身份或删除；也可按条件批量改（如把所有 `ChatGPT` 改成 `GPT-5`）
- **查看与搜索**：「全部 / 只看用户问题 / 只看 AI 回复」一键切换，项目内搜索（内容和身份，高亮、可定位回原位置），以及跨项目搜索
- **登录**：网页用管理员密码登录（会话），程序和整理 AI 用 API Token，两者互不影响
- **导入导出**：JSON（单项目/全部备份，可原样恢复）、JSONL、Markdown（可读 + 可无损再导入）、对话文本（`A：` / `B：` 这类说话人开头，说话人可自定义映射 `A=AI, B=user`，界面能自动识别有哪些说话人）
- **其他**：跨项目全文搜索、OpenAPI 3.1 文档、CORS、SQLite 每日自动备份、Docker 多架构镜像，零 npm 依赖

## 部署（Docker）

```bash
mkdir -p /opt/vibe-coding-logger && cd /opt/vibe-coding-logger
curl -fsSLO https://raw.githubusercontent.com/lichensheng7/vibe-coding-logger/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/lichensheng7/vibe-coding-logger/main/.env.example -o .env
sed -i "s/^API_TOKEN=.*/API_TOKEN=$(openssl rand -hex 24)/" .env   # 生成 Token
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=你的密码/" .env
docker compose up -d
grep API_TOKEN .env    # 记下 Token
```

打开 `http://<服务器>:18150`，用管理员密码登录。右上角「API Token」可复制给整理 AI 用的 Token。数据在 `./data`（SQLite + 自动备份）。

镜像：`ghcr.io/lichensheng7/vibe-coding-logger:latest`（amd64 / arm64，每次推送 main 自动测试并构建）。
本地构建：`docker compose up -d --build`。不用 Docker：Node ≥ 22.18，`npm start`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 空 | 网页登录密码；为空时网页只能用 API Token 登录 |
| `SESSION_DAYS` | `30` | 登录会话有效期 |
| `API_TOKEN` | 自动生成 | Bearer Token，可逗号分隔多个；留空时生成到 `data/api_token` |
| `PUBLIC_READ` | `false` | 允许不带 Token 的 GET（只读演示） |
| `CORS_ORIGIN` | `*` | 前端域名 |
| `MAX_BODY_MB` | `64` | 请求体上限 |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `24` / `7` | 自动备份 |
| `HOST_PORT` | `18150` | compose 映射端口 |

## 数据模型

**Project**：`id`、`name`、`slug`（唯一，可代替 id 用在 URL 中）、`description`、`tool`、`model`、`tags[]`、`meta{}`、`archived`，列表/详情附带 `message_count`、`turn_count`、`last_message_at`。

**Message**：

| 字段 | 说明 |
|---|---|
| `seq` | 项目内顺序，1..N 连续，插入/移动/删除自动维护 |
| `turn` | 只读，第几轮。第一条 `user` 之前的内容为 0 |
| `role` | `user` / `assistant` / `system` / `tool` / `note`（写入时也认 `human`、`我`、`ai`、`claude`、`terminal`、`备注` 等别名） |
| `author` | 具体身份：`我`、`Claude Code`、`GPT-5`、`bash`… |
| `content` | 正文（Markdown）；写入时也接受 OpenAI 风格 content parts 数组 |
| `format` | `markdown` / `text` / `code` / `json` / `html` |
| `ext_id` | 调用方自带 ID，项目内唯一，重复推送默认跳过 |
| `sent_at` | 原始聊天时间（毫秒时间戳；写入接受秒/毫秒/ISO 字符串） |
| `meta` | 任意 JSON：工具调用、改动的文件、token 数… |

## API 速查

所有接口需 `Authorization: Bearer <TOKEN>`：API Token，或 `POST /api/auth/login {"password":"..."}` 换来的会话 token。完整文档：`GET /api/openapi.json`（可直接丢给 V0 / 整理 AI）。

```bash
BASE=http://localhost:18150; T="Authorization: Bearer $TOKEN"; J="Content-Type: application/json"

# 建项目（可同时带 messages 一步写完）
curl -X POST $BASE/api/projects -H "$T" -H "$J" -d '{"name":"部署 nginx","tool":"Claude Code","tags":["deploy"]}'

# 逐条推送（AI 连续多条回复就连续推多条 assistant）
curl -X POST $BASE/api/projects/<id>/messages -H "$T" -H "$J" -d '{"ext_id":"1","role":"user","author":"我","content":"帮我部署 nginx"}'
curl -X POST $BASE/api/projects/<id>/messages -H "$T" -H "$J" -d '{"ext_id":"2","role":"assistant","author":"Claude Code","content":"先检查端口"}'
curl -X POST $BASE/api/projects/<id>/messages -H "$T" -H "$J" -d '{"ext_id":"3","role":"tool","author":"bash","format":"code","content":"$ ss -ltnp\n..."}'

# 批量 / 插到某条之后
curl -X POST $BASE/api/projects/<id>/messages -H "$T" -H "$J" -d '{"after_id":"m_xxx","messages":[{...},{...}]}'

# 读取：平铺 / 按轮分组 / 只看第 3 轮
curl $BASE/api/projects/<id>/messages -H "$T"
curl $BASE/api/projects/<id>/turns -H "$T"
curl "$BASE/api/projects/<id>/messages?turn=3" -H "$T"

# 修改内容与身份、移动、删除
curl -X PATCH $BASE/api/messages/<mid> -H "$T" -H "$J" -d '{"role":"assistant","author":"GPT-5","content":"..."}'
curl -X POST  $BASE/api/messages/<mid>/move -H "$T" -H "$J" -d '{"after_id":"m_yyy"}'
curl -X DELETE $BASE/api/messages/<mid> -H "$T"
curl -X POST $BASE/api/projects/<id>/messages/bulk-update -H "$T" -H "$J" -d '{"ids":["m_a","m_b"],"set":{"role":"assistant","author":"GPT-5"}}'
curl -X POST $BASE/api/projects/<id>/messages/bulk-update -H "$T" -H "$J" -d '{"filter":{"author":"ChatGPT"},"set":{"author":"GPT-5"}}'

# 只看用户问题 / 只看 AI 回复 / 项目内搜索
curl "$BASE/api/projects/<id>/messages?role=user" -H "$T"
curl "$BASE/api/projects/<id>/messages?role=assistant&q=nginx" -H "$T"

# 导出 / 导入
curl -OJ "$BASE/api/projects/<id>/export?format=md" -H "$T"       # md | json | jsonl
curl -OJ $BASE/api/export -H "$T"                                  # 全部项目备份
curl -X POST "$BASE/api/import?mode=new" -H "$T" --data-binary @backup.json        # new | restore | skip
curl -X POST "$BASE/api/projects/<id>/import?format=text&speakers=A=AI,B=user" -H "$T" --data-binary @chat.txt
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/projects` | 列表（`q`、`tag`、`archived`、分页）/ 创建 |
| GET/PATCH/DELETE | `/api/projects/:id` | 详情 / 修改 / 删除（`:id` 也可用 slug） |
| GET/POST/PUT | `/api/projects/:id/messages` | 列表（`role` 可多选、`author`、`q` 项目内搜索、`turn`、分页）/ 追加或插入 / 整体替换 |
| GET | `/api/projects/:id/turns` | 按轮分组 |
| PUT | `/api/projects/:id/order` | 按 id 数组整体重排 |
| POST | `/api/projects/:id/messages/delete` | 批量删除 |
| POST | `/api/projects/:id/messages/bulk-update` | 按勾选 `ids` 或 `filter` 批量改角色/身份/格式 |
| GET/PATCH/DELETE | `/api/messages/:id` | 单条 |
| POST | `/api/messages/:id/move` | 移动（`position` / `after_id` / `before_id`） |
| GET | `/api/projects/:id/export` | `format=json\|jsonl\|md` |
| GET | `/api/export` | 全部（或 `ids=`）JSON 备份 |
| POST | `/api/import` | 导入 JSON 备份，`mode=new\|restore\|skip` |
| POST | `/api/projects/:id/import` | 追加导入，`format=json\|jsonl\|md\|text`（缺省自动识别），`dry_run=1` 预览 |
| GET | `/api/search` | 跨项目全文搜索 |
| POST | `/api/auth/login`、`/api/auth/logout` | 管理员密码登录 / 注销 |
| GET | `/api/auth/api-token` | 登录后取回 API Token |
| POST | `/api/tools/detect-speakers` | 识别纯文本里的说话人 |
| GET/POST | `/api/backups`、`/api/backups/:name` | SQLite 备份 |
| GET | `/api/health`、`/api/stats`、`/api/openapi.json` | 其他 |

返回格式统一为 `{"success": true, "data": ...}`，列表附带 `total`；错误为 `{"success": false, "message": "..."}`。

## 对话文本导入格式

每条消息以「说话人：」开头（中英文冒号都行），下一行起直到下一个说话人之前都属于这条消息：

```
B：帮我在服务器部署 nginx
A：好的，先检查端口
A：80 端口被占用了，改用 openresty
C：$ ss -ltnp
B：可以，再加 https
```

说话人映射 `speakers=A=AI, B=user, C=tool/bash`：`名字=角色[/身份]`，角色写 `user` / `AI` / `用户` / `assistant` / `tool` / `system` / `note` 都行，`/` 后面是可选的身份。提供映射后**只按这些名字分段**，其他「xx:」开头的行算正文；代码块（```）里的内容永远不会被拆开。

不提供映射时，按常见名字分段：`用户/我/User/Human/Q`、`AI/Assistant/助手/Claude/GPT/ChatGPT/Gemini/Cursor/Copilot/A`、`System/系统`、`Tool/工具/Terminal`、`备注/Note`，括号里的内容作为身份（如 `AI（GPT-5）:`）。

网页导入时粘贴后会自动识别出现过的说话人，逐个选角色即可，可先「预览」再导入。更乱的记录建议交给 AI 按 [docs/AI_PROMPT.md](docs/AI_PROMPT.md) 整理。

## 开发

```bash
npm start          # http://localhost:8080，数据在 ./data
npm test           # 端到端 API 测试（node:test）
```

单进程 Node + 内置 `node:sqlite`（WAL），无第三方依赖。代码：`src/store.ts`（项目与消息、排序、轮次）、`src/io.ts`（导入导出）、`src/routes.ts`（路由）、`src/ui.html`（测试用界面，正式界面计划用 V0 重做）。

## License

MIT
