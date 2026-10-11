# 链家烧烤 · 独立后端

微信小程序点餐后端，支持登录、01～36 桌同桌多人点餐、到店自取、厨房接单、门店收银、营业设置和经营统计。使用 Node.js 22.9+、MySQL 5.7 / 8.0，可独立部署到微信云托管，HTTP 端口默认 **8080**。

从 [Food-Ordering-Mini-Program](https://github.com/hedgehogball/Food-Ordering-Mini-Program) 的 [08a79b1](https://github.com/hedgehogball/Food-Ordering-Mini-Program/commit/08a79b187b02266e9a79908c89661a04094bf59a) 提取，业务程序放入 `src`，不依赖小程序目录或云函数 SDK。本仓库提供数据库结构与默认初始化数据，不包含线上数据库备份。当前使用到店收款，未接入微信在线支付；厨房小票有持久化任务队列与人工打印登记，尚未连接打印机。

## 目录

```text
src/
  server.js           服务入口、连接池、角色配置
  app.js              HTTP 路由、微信网关身份核验
  database.js         MySQL 适配、事务、初始化及增量迁移
  takeaway.js         自取订单与本人历史
  operations.js       门店设置、制作状态、小票、统计
  auth/service.js     微信身份对应的稳定账号标识
  dining/             菜单、堂食规则、同桌账单服务
database/
  schema.sql          六张业务表、生成列和索引
  seed.sql            36 个桌号、默认营业设置
  README.md           数据库初始化和旧库升级说明
scripts/              数据库初始化、集成测试入口
tests/                HTTP、业务规则、实际 MySQL 集成测试
Dockerfile            微信云托管独立构建入口
.env.example          本地开发配置模板
```

## 本地启动（Windows PowerShell）

安装 Node.js 22.9 或更高版本及 MySQL，先建立独立开发数据库 `food_ordering`（字符集 `utf8mb4`），不要共用生产库。数据库创建与权限见 [数据库说明](database/README.md)。本地脚本使用的 `--env-file-if-exists` 参数从 [Node.js 22.9 开始提供](https://nodejs.org/download/release/v22.21.0/docs/api/cli.html#--env-file-if-existsfile)。

```powershell
git clone https://github.com/hedgehogball/Food-Ordering-Backend.git
cd Food-Ordering-Backend
npm ci --ignore-scripts
Copy-Item .env.example .env
```

填写 `.env` 的实际值后运行：

```powershell
npm run db:init
npm start
```

`npm start` 自动读取根目录 `.env`；服务启动也会进行幂等初始化，不清空已有数据。开发时可运行 `npm run dev` 自动监听源码修改。提供 npm 与 pnpm 锁文件；使用 pnpm 时可执行 `pnpm install --frozen-lockfile --ignore-scripts`。

| 配置 | 含义 |
| --- | --- |
| `PORT` | HTTP 端口，默认 8080 |
| `WX_APPID` | 当前小程序的真实 AppID，必须填写 |
| `MYSQL_ADDRESS` | MySQL 地址和端口，如 `127.0.0.1:3306` |
| `MYSQL_USERNAME` / `MYSQL_PASSWORD` | 数据库用户名与密码，必须填写 |
| `MYSQL_DATABASE` | 已存在的数据库名；示例为 `food_ordering`，请显式配置 |
| `OWNER_USER_IDS` | 店主登录后返回的完整 64 位账号标识，多个用英文逗号分隔 |
| `CASHIER_USER_IDS` | 店员账号标识，同上 |
| `CASHIER_OPENIDS` | 兼容旧环境的店员 OpenID，新环境通常留空 |

店主拥有门店设置和全部店员权限；店员可接单、收银、打印登记和查看统计；未配置的账号为顾客。角色由服务器配置计算，客户端不能指定。新服务需要自行配置店主账号，仓库不会自动授予权限。这里的 `package.json` 中 `private: true` 用于防止误发布到 npm，与 GitHub 公开仓库无关。

## 本地访问和接口调试

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/healthz
```

它会检查真实数据库连接。业务接口使用 POST JSON，以下本地测试头模拟微信网关，**仅限自己的本机开发服务**：

```powershell
$headers = @{
  'X-WX-SOURCE' = 'wx_client'
  'X-WX-APPID' = '替换为.env中的WX_APPID'
  'X-WX-OPENID' = 'local-test-customer-001'
}
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/login `
  -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body '{"action":"login"}'
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/table-order `
  -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body '{"action":"join","table":"01"}'
```

模拟登录返回的账号标识只属于本地假定身份，不能作为真实微信店主账号。真实账号标识须在小程序通过微信网关登录后取得。数据库连接使用 `.env` 指定的地址，后端 HTTP 地址和数据库地址是两个不同连接；本地接口端口 8080、常规 MySQL 端口 3306、专用集成测试 MySQL 端口 33308。

## 部署到微信云托管

选择本仓库根目录作为构建目录，Dockerfile 路径为 `Dockerfile`，容器端口 **8080**。在服务配置中填写以上环境变量，数据库使用该环境可访问的 MySQL 内网地址；保留现有服务时继续使用原数据库名称与角色配置。

1. 将本仓库连接到云托管的代码构建来源，或下载仓库后上传源码构建。
2. 配置数据库连接和 `WX_APPID`，配置需要的店主 / 店员标识；密码放在云端配置中。
3. 关闭该服务的默认公网访问，确认没有自定义域名或不可信代理绕过微信网关。业务身份依赖微信注入的 `X-WX-SOURCE`、`X-WX-APPID`、`X-WX-OPENID`，普通公网请求可伪造这些头，不能把本进程直接公开。
4. 发布后检查 `GET /healthz` 和运行日志，再用小程序体验版验证顾客与店员权限。

本次独立仓库上传本身不会更改线上服务的部署来源、数据库或版本。初次部署新环境时，不会自动同步原环境订单。现有环境升级会保留原有文档并补齐索引；请先在测试环境验证。

小程序通过微信提供的容器调用连接服务：

```javascript
wx.cloud.init({ env: '你的云托管环境ID' });
wx.cloud.callContainer({
  config: { env: '你的云托管环境ID' },
  path: '/api/login',
  header: { 'X-WX-SERVICE': '你的服务名称', 'content-type': 'application/json' },
  method: 'POST',
  data: { action: 'login' }
}).then(res => console.log(res.data));
```

小程序不用自行填写身份头，也不需要数据库密码或 AppSecret。异地开发者可克隆仓库搭建独立开发库；联调已部署服务时使用有小程序开发权限的微信账号和开发者工具，通过 `callContainer` 访问。需要查看云日志或部署时，由管理员在平台另行授予相应成员权限；仓库访问权不等于数据库、云服务或门店工作台权限。

## 接口与业务规则

业务响应成功为 `{ok:true,...}`，业务拒绝通常为 HTTP 200 的 `{ok:false,code,message}`，客户端需要检查 `ok`；数据库或内部故障返回 HTTP 503 的 `SERVICE_UNAVAILABLE`。请求体上限 64 KiB。

| 路径 | 操作 |
| --- | --- |
| `GET /healthz` | 数据库连接检查 |
| `POST /api/login` | `login`：保存登录时间，返回账号标识与角色 |
| `POST /api/menu` | 返回菜品，价格由服务器保存 |
| `POST /api/table-order` | `join/get/submit/checkout/cancelCheckout/staffGet/confirmPaid` |
| `POST /api/takeaway` | `submit/list/staffList/complete` |
| `POST /api/operations` | `publicSettings/dashboard/saveSettings/advance/requestPrint/getTicket/markPrinted/stats` |

完整请求示例、权限和状态见 [接口说明](docs/api.md)。金额单位是整数分，时间为毫秒时间戳。羊肉现穿每份半斤 35 元；1.3 元烤串每种菜品合计至少 10 串，可混选口味；每种口味数量 1～99；自取打包费 0 元。菜单配置位于 `src/dining/menu.js`，图片路径对应原小程序素材，本服务不提供静态图片托管。当前小程序还保留前端菜单快照，修改品类、价格或口味时须同步前端，避免客户端提交旧价格被后端拒绝。

同桌多人各自登录加入同一餐次、分别下单，订单在服务端合并。桌号行锁、事务与提交编号保证并发处理；相同内容重试使用原 `requestId` 返回原结果，改内容重用编号会拒绝。收银只允许店员操作，整桌账单结账后才开启新餐次。营业设置通过版本号避免多人互相覆盖。

## 测试

```powershell
npm test
```

覆盖身份核验、角色隔离、价格计算、同桌并发、结账、营业时段、厨房状态与小票。实际 MySQL 测试另外运行：

```powershell
npm run test:integration
```

集成测试要求单独的 MySQL 实例监听 **127.0.0.1:33308**，仅该本地实例的测试 root 账号采用空密码，每次新建测试库并保留供检查。不得把生产库映射到此端口。测试不使用 `.env` 的生产连接，依次验证 SQL 初始化 / 幂等 / 生成列、20 人真实数据库并发、重复请求去重、重新连接后持久化、顾客与店员隔离、运营设置冲突和大账单响应上限；最后启动独立服务进程验证实际 HTTP 登录、角色和订单落库。该启动测试创建临时数据库账号，结束后移除账号。
