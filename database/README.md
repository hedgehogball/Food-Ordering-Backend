# 数据库结构与初始化

后端使用 MySQL 5.7 / 8.0、InnoDB 和 JSON 字段。这里提供可重复执行的建表与默认数据脚本，包含 01～36 桌、默认营业设置；不包含线上用户、订单、手机号或店主账号。

## 新数据库

先由数据库管理员创建独立数据库并给开发账号授权，数据库字符集选 `utf8mb4`。例如在 MySQL 管理客户端执行：

```sql
CREATE DATABASE food_ordering CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

在项目根目录复制 `.env.example` 为 `.env`，填入数据库地址、用户名、密码和 `MYSQL_DATABASE=food_ordering`。然后执行：

```powershell
npm ci --ignore-scripts
npm run db:init
```

这与服务器启动的初始化使用同一实现，会建表、补充缺失索引和生成列、补齐桌号。数据库必须事先存在；运行账号需要该库的 SELECT、INSERT、UPDATE、CREATE、ALTER、INDEX 权限。不要使用生产 root 账号做日常开发。

也可以在 MySQL 命令行中手动导入。先 `mysql -h 127.0.0.1 -P 3306 -u food_ordering -p food_ordering`，然后在 **MySQL 提示符** 中执行下面命令，路径替换为本机项目位置，统一使用 `/`：

```sql
SOURCE C:/projects/Food-Ordering-Backend/database/schema.sql;
SOURCE C:/projects/Food-Ordering-Backend/database/seed.sql;
```

上述 SOURCE 在 MySQL 客户端执行，不是在 PowerShell 执行。手动 schema 适合新库；已有旧库仍运行 `npm run db:init` 补齐迁移。脚本不导出数据，不创建数据库账号，也不替换密码。

## 表与约束

| 表 | 用途 | 关键字段 / 索引 |
| --- | --- | --- |
| `lj_users` | 登录记录 | 64 位账号标识、首次与最近登录时间 |
| `lj_dining_tables` | 36 桌的当前餐次指针 | `id` 为 01～36，JSON 内有 `sessionId` |
| `lj_dining_sessions` | 同桌成员、每次加菜、合并账单、收款状态 | `document`；创建 / 修改 / 收款时间的生成列和索引 |
| `lj_takeaway` | 自取订单 | `actor + request_id` 唯一索引；本人历史及收款日期索引 |
| `lj_settings` | 营业和预约设置 | `shop` 文档；`version` 用于并发更新检查 |
| `lj_print_jobs` | 厨房小票任务 | `source_key` 唯一；状态和创建时间索引 |

金额均为整数分；业务时间为毫秒时间戳，营业时段与统计按北京时间计算。菜单来源是 `src/dining/menu.js`，当前没有菜单数据库表；菜单变更需修改代码并重新部署。

同桌提交通过桌号行锁与事务处理，自取通过账号和请求编号唯一约束去重。JSON 文档会包含实际订单、身份或联系方式，真实数据库备份应留在受控存储中，不加入源码仓库。

## 已有环境

启动初始化与 seed 都不会重置已选桌号、当前餐次或营业设置；缺失默认行才补充。旧数据由 `src/database.js` 增加缺失的生成列和报表索引，保留原文档。这里的 schema 不是生产库备份，也不自动复制原服务的数据。

测试使用 `127.0.0.1:33308` 的专用本地 MySQL 实例，每次创建独立的 `lj_` 前缀测试库。`npm run test:integration` 验证 SQL 初始化幂等、JSON 生成列、同桌并发、权限与持久化，不读取 `.env` 的生产连接配置。
