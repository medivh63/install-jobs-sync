# install-jobs-sync

Cloudflare Worker + D1，两块功能：

1. **排期聚合（cron）**：定时从 Firefly（GraphQL，安装单 + 服务单）和 North Energy
   （SubcontractorHub，REST）拉未来安装排期，归一化后 upsert 进 D1 的 `items` 表，
   变化时打 webhook 通知；`/jobs` 只读接口给下游（solarcrew）消费。
2. **供应商预约门户（`/`）**：供应商凭口令登录，看施工日历（每天占用 vs 容量），
   挑空闲日 book 安装——预约时填 job 信息（地址、板数、组件瓦数、备注），并上传
   site survey / SLD 附件（存 R2）。管理员可确认/取消预约、封锁日期。
   下游用 `/bookings`（同 `/jobs` 的 Bearer 鉴权）读取预约。

## 结构

```
src/index.js      Worker 全部逻辑:cron 同步 + /jobs /bookings + /portal/api/*
public/index.html 供应商门户页面(纯 HTML/JS,无构建步骤)
schema.sql        表结构参考文档(实际建表由 ensureSchema 自动完成)
wrangler.toml     配置:cron / D1 / R2 / 静态资产 / vars
```

## 日历的"占用"怎么算

某天 `used` = `items` 里在途（`gone_at IS NULL`）的安装数 + `bookings` 里未取消的预约数；
`used >= CAPACITY_PER_DAY`（默认 1）即"已满"，`blocked_days` 里的日期显示"不可约"。
门户只返回聚合数量，**不透出 `items` 里任何客户信息**——各家供应商互相看不到对方客户。

## 部署

```bash
# 首次:创建附件桶(D1 库已有)
wrangler r2 bucket create install-jobs-files

# 必需的 secret(fail closed:不配对应接口一律 503)
wrangler secret put READ_TOKEN          # /jobs /bookings /run 的 Bearer 口令
wrangler secret put PORTAL_CODE         # 门户供应商口令(共享,发给各供应商)
wrangler secret put PORTAL_ADMIN_CODE   # 门户管理口令(确认/取消/封锁日期)
wrangler secret put FF_SESSION          # Firefly cookie(会过期)
wrangler secret put SCH_TOKEN           # SubcontractorHub Bearer
wrangler secret put WEBHOOK_URL         # (可选)通知 webhook,新预约/状态变化也会推这里

wrangler deploy
```

## 本地开发

```bash
cat > .dev.vars << 'EOF'
PORTAL_CODE=test123
PORTAL_ADMIN_CODE=admin456
READ_TOKEN=readtok
EOF
npx wrangler dev --local     # http://localhost:8787,本地模拟 D1/R2
```

## 门户 API（`/portal/api/*`，请求头 `X-Portal-Code`；管理操作另加 `X-Portal-Admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/calendar?from=&to=` | 每天 `{date, used, capacity, blocked}`（≤120 天） |
| GET | `/bookings?from=&to=` | 预约列表 |
| POST | `/bookings` | 建预约 `{date, supplier, contact, phone, address, panels, panel_model, notes}`；过去/封锁/已满的日期拒绝 |
| GET | `/bookings/:id` | 单条预约 + 附件列表 |
| PATCH | `/bookings/:id` | `{status}`；供应商只能取消 pending，其余管理员 |
| POST | `/bookings/:id/files` | multipart：`file` + `kind`（site_survey/sld/other），≤20MB |
| GET | `/files/:id` | 取附件 |
| PUT/DELETE | `/blocked/:date` | 封锁/解封日期（管理员） |

## 已知取舍（雏形阶段）

- 供应商共用一个 `PORTAL_CODE`，预约在门户内彼此可见；要按供应商隔离得做独立账号。
- 名额检查与写入之间无锁，并发下可能超订一单——管理员确认环节兜底。
- 附件没有病毒扫描/类型白名单，口令持有者皆可上传。
