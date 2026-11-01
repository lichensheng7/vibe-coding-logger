# 交给"整理 AI"的提示词

把下面整段（替换尖括号部分）连同原始聊天记录一起发给另一个 AI（ChatGPT / Claude / Cursor Agent 等）。
能执行命令/HTTP 的 Agent 会直接推送；不能执行的，会输出一个 JSON，你再用一条 curl 导入。

---

你是聊天记录整理员。我会给你一段格式混乱的 AI 编程聊天记录（可能来自不同工具，AI 可能一次连续回复多条，夹杂终端输出、代码、工具调用）。请把它整理成有序的消息列表，并推送到 Vibe Coding Logger。

## 整理规则

1. 严格保持原始时间顺序，一条原始发言 = 一条消息。AI 连续回复多条时保留为多条，不要合并。
2. role 只能是：
   - `user`：我发的问题/指令（每条 user 都会开启新的一"轮"）
   - `assistant`：AI 的回复
   - `tool`：终端输出、命令执行结果、工具调用及其结果、文件 diff
   - `system`：系统提示词、上下文设定
   - `note`：你补充的说明（尽量少用）
3. author 写具体身份：我的消息写 `我`；AI 写模型或工具名（如 `Claude Code`、`GPT-5`）；工具写工具名（如 `bash`、`edit_file`）。
4. content 原样保留，不要改写、总结或翻译；代码块保留 ``` 围栏。纯命令/日志输出的 format 用 `code`，其余用 `markdown`。
5. 有时间就填 sent_at（ISO 8601，带时区），没有就省略。
6. 每条消息给一个 ext_id，从 `1` 开始递增的字符串，方便失败重试时自动去重。
7. 无法判断归属的内容，归到前一条消息里，不要丢弃。

## 推送方式

服务地址：`<BASE_URL>`，Token：`<API_TOKEN>`

第一步，创建项目：

```
POST <BASE_URL>/api/projects
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"name": "<项目名，例如：2026-11-01 部署 nginx>", "tool": "<来源工具>", "model": "<主要模型>", "tags": ["deploy"], "description": "<一句话说明这段对话在做什么>"}
```

记下返回的 `data.id`。

第二步，按顺序逐条推送（每条等上一条返回成功后再发）：

```
POST <BASE_URL>/api/projects/<id>/messages
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"ext_id": "1", "role": "user", "author": "我", "content": "...", "sent_at": "2026-11-01T14:23:00+08:00"}
```

失败就用相同 ext_id 重发，已存在的会被跳过（返回 `"status": "skipped"`）。
也可以一次性推送：`POST /api/projects/<id>/messages`，body 为 `{"messages": [ ...全部消息... ]}`。

如果你不能发 HTTP 请求，就只输出下面这个 JSON（不要任何其他文字），我自己导入：

```json
{"name": "...", "tool": "...", "model": "...", "description": "...", "messages": [
  {"ext_id": "1", "role": "user", "author": "我", "content": "..."},
  {"ext_id": "2", "role": "assistant", "author": "Claude Code", "content": "..."}
]}
```

---

## 我自己导入 AI 输出的 JSON

```bash
curl -X POST "$BASE/api/projects" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @organized.json
```

（`POST /api/projects` 接受带 `messages` 的 body，一步完成建项目 + 写入。）
