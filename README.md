# dsh-free-trae

只维护 **TRAE** 的 DSH 插件：登录、账号、模型目录、流式对话、积分显示、每日签到。

没有别的渠道，没有免登录中转池。

## 能做什么

| 能力 | TRAE |
| --- | --- |
| 登录 | 浏览器授权 + 手动粘贴回调地址 |
| 区域 | 国服 `trae.cn` / 国际服 `trae.ai` |
| 账号 | 多账号、切换当前账号、退出、手动续期 |
| 模型 | 实时拉 `get_detail_param` |
| 对话 | SSE 流式转发、工具调用、失败换号 |
| 续期 | refreshToken 轮换，临期自动续，401 强制续一次 |
| 积分 | 可用积分查询（`ide_user_ent_usage`，仅国服） |
| 签到 | 每日签到（`checkin_credits`，仅国服） |
| 计费倍率 | 目录里的实时倍率（`display_contact_config`），缺失回落官方文档 |

模型会以 provider `trae` 出现在 DSH 的模型选择器里，并带计费倍率标签：
TRAE 从目录的 `display_contact_config` 解出实时 `consumption_rate.data.rate`，
有活动折扣时显示 `×原价→×现价`。目录没给倍率的模型才回落官方文档公布的
「积分消耗速度」，其余不显示（不臆造 ×1）。

## 安装

```bash
cd dsh-free-trae
npm pack
# 用你的 DSH 安装插件的方式安装生成的 tar 包，例如：
dsh plugin install ./dsh-free-trae-0.3.1.tgz
```

也可以直接把这个目录放进 DSH 的插件目录，或用本地路径安装。安装后重启 DSH，设置页会出现 **TRAE** 分区。

要求 Node `^22.19.0 || >=24.0.0`（用内置 `fetch`）。

## 使用

1. 设置 → TRAE → 选区域 → **生成登录链接**。
2. 浏览器会打开 TRAE 授权页；登录成功后页面跳到 `http://127.0.0.1:18080/authorize?...`。
   **页面打不开是正常的**——本插件不监听这个端口。
3. 复制地址栏里的**完整地址**，粘回面板，点 **完成登录**。

回调地址里有 `refreshToken` / `userInfo`，属于登录凭据，不要发给别人。

> 只支持 `refreshToken` 形式的回调。如果上游改成 PKCE `code` 回调，登录会明确报错，不会静默失败。

## 积分与签到

TRAE 卡片底部有一个签到区：

- 每个账号旁边显示**当前可用积分**，右上角有「账号 / 积分合计 / 上次签到」概览；查不到会显示 `—（原因）`。
- 勾选「定时」并设置时间（`HH:mm`），保存后每天到点自动跑；DSH 需保持运行。
- 「立即签到」只签 TRAE，结果显示在卡片里（成功 / 今日已领 / 待刷新 / 无资格 / 不支持 / 失败）。

说明：

- **TRAE 只有国服支持积分与签到**；国际服的 ug 协议未实测，会明确显示「不支持」，不会拿国际 token 去打国服接口。
- 积分/签到都是私有接口，可能随上游变化失效。

## 文件结构

```
index.js                 Host 半身：cordis 插件入口、HTTP 路由、账号 CRUD
client.js                浏览器半身：设置页 TRAE 卡片（无构建步骤，只用宿主提供的 react）
src/adapter.js           宿主 LLM 适配器：选号/续期/换号/事件翻译
src/store.js             ~/.dsh/free-trae/accounts.json + settings.json（均 0600）
src/http.js              fetch 封装、SSE 拆帧、静默超时看门狗
src/messages.js          harness 消息块 → OpenAI messages
src/emit.js              上游增量 → 宿主 block-start/text-delta/tool-call-delta/block-end/usage/finish
src/trae/auth.js         OAuth 地址、回调解析、ExchangeToken、GetUserInfo、续期
src/trae/models.js       get_detail_param → 模型清单（10 分钟缓存）
src/trae/upstream.js     llm_utils_chat：请求体改写 + output/done/token_usage/error 映射
src/trae/credits.js      国服 ug：积分查询 / 签到状态 / 签到（含设备身份派生）
src/checkin.js           积分汇总、签到执行器、60 秒定时调度
scripts/selftest.mjs     离线自检：请求体、事件、账号库、SSE（不发网络）
scripts/smoke-host.mjs   假 ctx + 真 http：路由、登录 URL、404、预检
```

## 自检

```bash
npm run selftest
npm run smoke
```

`selftest` 覆盖 TRAE 回调解析与请求体改写、块事件收尾、账号库权限、SSE 拆帧，
以及积分/签到的解析与设备身份、签到时间判定、模型倍率标签。`smoke` 会真的起一个
`node:http` 服务，验证 Host 路由、登录 URL 生成、积分与签到接口（同样不联网）。

## 数据与安全

- 账号与 token 只写在 `~/.dsh/free-trae/accounts.json`，权限 `0600`。
- **token 是明文落盘的**（Node 侧没有 Android KeyStore 那种系统密钥库）。这台机器上的
  其它进程理论上读得到，介意的话请给磁盘加密或缩短账号寿命。
- HTTP 接口只返回掩码后的账号（不含 accessToken / refreshToken）。
- 插件不主动监听任何端口：Web 端挂在 DSH 自己的 webServer 上（同源 + CORS 预检），
  桌面端挂在宿主共享的 `/api` 通道上（Electron 用 IPC 桥，没有 webServer）。
- 不包含任何遥测；除 TRAE 官方域名外不发请求。

## 已知限制

- **逆向协议，随时会失效。** 版本常量：TRAE `0.1.52`。
- 模型声明为纯文本：图片会降级成 `[image omitted]`，不做视觉请求。
- TRAE 模型目录用的是国服实测的 `get_detail_param`；国际服若拉不到目录，会退回 4 个兜底
  模型名（仍可尝试对话）。
- 只在“还没吐出任何内容”时换号，且最多尝试 2 个账号；已经出字后失败就按错误收尾。
- **TRAE 国际服不支持积分/签到**（ug 协议未实测，会明确标注）。
- TRAE 优先使用目录里的实时倍率（`display_contact_config.consumption_rate`），读到活动折扣时
  显示 `×原价→×现价`；目录没给才回落官方文档的基础值。会员档位、忙时/闲时会改变实际消耗。
- 定时签到依赖 DSH 进程常驻；进程被杀期间不会补跑，重新启动后会补一次。
- 遇到 `RESOURCE_LIMIT` / `10605`：上游排队，插件会自动重试一次、并在多账号时换号；
  如果是 60 秒级长队列会直接提示「约 N 秒后重试」，此时重发或换模型即可。
  它也会让宿主的自动上下文压缩失败（报 “context compaction failed”），属于临时限流，不是账号坏了。

## 协议来源与致谢

- [玖念/traework2api](https://github.com/jiunianyyds/traework2api-android)：TRAE 登录/聊天
  （Kotlin 参考实现）。
- [hulibuld/dsh-get-it-for-free](https://github.com/hulibuld/dsh-get-it-for-free)：DSH 插件宿主接线、
  TRAE 手动回调思路（TypeScript 参考实现）。

本项目是重新实现的精简版（MIT），不包含上述项目的渠道包与二进制。

## 免责声明

本项目只用于协议研究与个人账号调试。逆向私有接口、多账号切换等行为可能违反
TRAE 的服务条款，可能导致限流或封号。请使用不重要的小号，并自行承担风险。
