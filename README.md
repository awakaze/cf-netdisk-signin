# 百度网盘双端签到 · Cloudflare Workers

每天自动完成 PC、App 签到，领取已达到档位的累计签到奖励，并按每项操作前后的真实成长值生成通知。不需要手机、代理或本地常驻进程。

默认每天**北京时间 11:30**运行。全部成功立即使用成功渠道推送；部分失败先不推送，**30 分钟后补试一次**，补试成功推送成功渠道，仍失败则推送异常渠道。成功项目会保留原测量结果，补试跳过它们。

## 功能

- 每次 PC 签到、App 签到、每个累计奖励领取前先查询成长值；查询失败不执行对应操作。操作后再次查询，逐项记录变化。
- App 签到与奖励领取均复查服务端状态；PC 识别真实重复签到码。HTTP 200 但业务失败仍视为失败。
- 奖励档位与本周期已签天数由服务器返回，不写死 7/15/30 等档位；通知显示下一档和仍需签到的天数。
- 成功、失败分别配置自定义 fetch 请求模板，可使用不同 URL、方法、请求头与 JSON 正文。
- SQLite Durable Object 保存当日结果、失败补试与推送状态，串行处理并去重；alarm 在失败后补试，不保持进程睡眠。
- 推送网络失败可在 30 分钟后补发一次，只补发通知，不重新执行签到。
- 受令牌保护的手动执行、只读状态、最近报告接口。

## 部署

需要 Node.js 22+、Cloudflare 账号。SQLite Durable Objects 支持 Workers Free；参考 [Cloudflare 存储说明](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) 与 [alarm 文档](https://developers.cloudflare.com/durable-objects/api/alarms/)。

```sh
npm ci
npx wrangler login
npm test
npm run check
npm run deploy
```

复制 `secrets.example.json` 为 `secrets.local.json`，填写自己的配置，再上传为 Worker Secrets：

```sh
npx wrangler secret bulk secrets.local.json
```

也可以只通过 Cloudflare 控制台填写 Secrets，无须本地配置文件。示例中的推送 URL 是占位符，应替换或直接删除对应推送字段。

`wrangler.toml` 的 `30 3 * * *` 按 UTC 配置，对应北京时间 11:30。修改运行时间直接修改 cron 后重新部署；参考 [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。调度变更可能需要传播时间，平台调度不是精确到秒。

## 配置

所有自定义覆盖项均可省略；实际访问百度需要有效 Cookie。缺少凭据会产生失败报告，不会伪造成功。

| 名称 | 默认 | 用途 |
| --- | --- | --- |
| `BAIDU_COOKIE` | 空 | 自己账号的完整 Cookie，缺少时无法签到 |
| `BAIDU_CUID` | 从 Cookie 的 BAIDUCUID 提取 | 可覆盖为本人已有设备标识 |
| `BAIDU_HEADERS` | `{}` | JSON 字符串，自定义本人设备请求头；Cookie 始终取 BAIDU_COOKIE |
| `PUSH_SUCCESS` | 不推送 | 全部任务成功时的推送请求 JSON 字符串 |
| `PUSH_FAILURE` | 不推送 | 补试后仍有失败时的推送请求 JSON 字符串 |
| `ADMIN_TOKEN` | 管理接口关闭 | 建议使用至少 32 字节随机令牌；cron 不依赖此项 |
| `RETRY_MINUTES` | `30` | 补试/推送补发的等待分钟数，1–1440；不增加重试次数 |
| `TIMEOUT_MS` | `15000` | 单次百度请求超时，100–60000 毫秒 |
| `ENABLE_PC` | `true` | 设为字符串 `false` 关闭 PC 签到 |
| `ENABLE_APP` | `true` | 设为字符串 `false` 关闭 App 签到 |
| `ENABLE_AWARDS` | `true` | 设为字符串 `false` 关闭累计奖励领取 |

可以在 Cloudflare 控制台配置普通变量，也可以作为 Secrets 上传。`keep_vars = true` 保留控制台普通变量；Secrets 不进入公开代码。修改 Cookie 或设备配置后更新 Secrets 即可。

此项目以最小参数调用接口，不生成原生签名或设备安全材料。使用本人已有 cuid 不等于在云端复现手机系统环境；网络出口仍是 Cloudflare。

## 自定义 fetch 推送

推荐声明式请求模板，避免执行任意 JS。它能表达常见 `await fetch(url, { method, headers, body: JSON.stringify(...) })`，也便于修改字段名称。`body` 内的对象会统一 JSON 编码，换行和引号自动转义。

`PUSH_SUCCESS` 和 `PUSH_FAILURE` 分别填写以下结构的 **JSON 字符串**：

```json
{
  "url": "https://push.example/your-endpoint",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": {
    "title": "{{title}}",
    "body": "{{body}}"
  }
}
```

占位符支持 `{{title}}`、`{{body}}`、`{{date}}`、`{{status}}`，可放在请求头或嵌套 JSON 值中。默认方法为 POST，默认正文为 `title`、`body`。例如服务商使用 `content` 字段，只需改为 `"content": "{{body}}"`。

MoePush 的转发模板要把 `${body.title}` 映射到消息标题，把 `${body.body}` 映射到消息正文；如果其渠道模板使用 `${body.content}`，就在请求体中配置 `content`。本项目的 `{{...}}` 和 MoePush 的 `${...}` 属于不同层，勿混淆。MoePush 参考：[推送实现](https://github.com/beilunyang/moepush/blob/main/app/api/push/%5Bid%5D/route.ts)。

如服务商 HTTP 200 仍可能业务失败，可额外配置 `successField`（如 `data.code`）和 `successValue`（如 `0`），校验实际 JSON 业务结果。网络异常不输出携带推送密钥的 URL。

Telegram 渠道若采用 MarkdownV2，在该渠道请求配置中添加 `"escape": "telegram-markdown-v2"`，自动转义日期、括号、加号等保留字符。HTML 模式可配置 `"escape": "html"`。转义只应用于变量值，不改变自定义模板中的格式标记；两个渠道各自独立配置。

MoePush 当前模板插值未自动转义反斜线；若通过 MoePush 转发 MarkdownV2，再添加 `"doubleBackslash": true`，让转义符完整经过其 JSON 模板解析。直连 Telegram 或其他正确处理 JSON 的转发器通常不需要此项。

通知示例：

```text
百度网盘签到成功 · 2026-10-22
日期：2026-10-22（北京时间）
执行：首次；全部成功
✅ PC 签到：已完成
  成长值：100 → 104（+4）
✅ App 签到：已完成
  成长值：104 → 117（+13）
本周期累计签到：14 天
下一档累计 15 天奖励：还需签到 1 天
当前成长值：117
```

累计奖励领取后会显示例如 `✅ 累计 15 天奖励：已领取，实得成长值 +20`（数值仅为示例，实际按领取前后余额测量），然后显示新的下一档与剩余签到天数。用户账号的日常自动成长为凌晨约 1 点 +30；默认 11:30 执行，推送不再提示自动成长。

## Cloudflare 用量估算

部署使用一个 Worker、一个每日 Cron Trigger、一个带 SQLite 存储和 alarm 的 Durable Object，以及 Worker Secrets。alarm 等待补试时无需保持程序运行；只保留最近一轮报告，不累计保存每日历史。

单账号每天正常运行：Worker 定时调用约 1 次、Durable Object 调用约 1 次；含一次签到补试和一次通知补发时，Durable Object 调用约 3 次。存储操作通常为几十次，保守按每天少于 100 次估算。按全天总计活跃 180 秒的保守假设，128 MB 对象约消耗 22.5 GB-s，而非把 30 分钟等待全部计为运行时间。

Workers Free 的请求额度为每天 10 万；Durable Objects Free 为每天 10 万请求、13,000 GB-s、500 万行读取、10 万行写入，以及总共 5 GB 存储。本项目正常用量远低于这些额度；额度由账号其他项目共享，公网异常流量也会消耗 Worker 请求。该估算不代表账号实时账单，已有付费计划的基础月费仍按其订阅收取。

来源：[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

## 手动检查

设置本地环境变量 `WORKER_URL` 为自己的部署地址。下列辅助命令从忽略的 `secrets.local.json` 读取 ADMIN_TOKEN，不将令牌写进命令行参数：

```sh
node tools/manage.mjs health
node tools/manage.mjs status
node tools/manage.mjs report
node tools/manage.mjs run
node tools/manage.mjs notify
```

- `GET /health`：公开存活检查，不含账号、成长值、设备信息。
- `GET /status`：即时只读查询成长值与累计奖励，不签到、不领奖、不推送。
- `GET /report`：读取最近一次执行及推送结果。
- `POST /run`：立即执行当天任务并推送；当日已执行时返回已有报告，不提前补试、不重复推送。
- `POST /notify`：配置修复后立即手动补发失败通知，不重复签到；手动修复不受自动补发次数限制，已发送的通知不会再发。

除健康检查外的接口需 `Authorization: Bearer <ADMIN_TOKEN>`。不提供浏览器公开签到按钮。报告仅保留最近一轮；本地管理命令会将响应保存到忽略的 `captures/`。

## 边界与验证

- 仅双端签到及累计签到奖励，不做答题、广告或补签。
- PC 与 App 最小参数已在原本地项目多日验证；**累计奖励仅 cuid + day 的独立领取尚待实际到档位验证**，成功响应后必须复查完整领取状态。状态不足会进入异常补试流程。
- 接口为非公开服务端接口，可能变化；Cloudflare 出口能否访问须以自己的部署实测为准。
- 持久化检查点和服务端状态降低重复操作风险；外部请求与落盘无法组成跨服务事务。若执行在发送通知后、记录通知前中断，极端情况下可能重复收到通知。
- 跨北京时间零点的旧补试会取消，下一天由正常 cron 启动；默认 11:30/12:00 不涉及跨日。
- 自动部署 GitHub 工作流只做离线测试和打包验证，不访问你的真实账号。首次部署后的验证记录见 `VERIFICATION.md`。

不要提交 Cookie、设备材料、推送真实地址或管理令牌。本仓库忽略本地配置、运行报告和工具缓存。
