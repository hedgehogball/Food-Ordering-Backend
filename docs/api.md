# 后端接口

除 `/healthz` 外均为 POST JSON，微信身份来自网关。金额为分，时间为毫秒时间戳；拒绝时检查返回的 `ok:false`、`code`、`message`。以下 `sessionId`、`orderId`、`jobId` 均从真实响应获取，不能使用示例字符串下单。

## 登录与菜单

`/api/login` 请求 `{"action":"login"}`，返回 `user.id`、`user.role`。`id` 是 AppID 和 OpenID 的 SHA-256 标识，`role` 为 `customer/cashier/owner`。请求体的 OpenID、账号标识或角色不决定调用者身份。

`/api/menu` 请求 `{}`，返回 `{ok:true,dishes:[...]}`。字段包括 `id/name/price/unit/options/minQuantity/soldOut/image`，价格和售罄状态由后端计算，不信任客户端价格。

## 堂食 `/api/table-order`

| action | 参数 | 权限 / 用途 |
| --- | --- | --- |
| `join` | `table`；可带原 `sessionId` | 加入本桌当前餐次；回看旧餐次需本人是成员 |
| `get` | `table,sessionId` | 本餐次成员查看合并账单 |
| `submit` | `table,sessionId,requestId,items,expectedTotal,note` | 本餐次成员提交新加菜批次 |
| `checkout` | `table,sessionId,revision` | 成员核对最新账单后申请整桌结账 |
| `cancelCheckout` | `table,sessionId,revision` | 原申请人或店员恢复点单 |
| `staffGet` | `table`，可带 `sessionId` | 店员查看桌台账单 |
| `confirmPaid` | `table,sessionId,revision,expectedTotal` | 店员核对实际收款后登记 |

响应为 `{ok:true,session:{...}}`。`revision` 使用最近一次获取的值；结账状态下不能继续加菜。顾客不能通过改变 sessionId 读取没有加入的餐次。`join` 使用所选桌号加入餐次，不是扫码真实性或地理位置验证。

提交示例：

```json
{
  "action": "submit",
  "table": "01",
  "sessionId": "从join响应取得",
  "requestId": "client:unique-20261012-0001",
  "items": [{"dishId":"lamb-skewer","option":"微辣","quantity":10}],
  "expectedTotal": 1300,
  "note": "少盐"
}
```

`requestId` 为 8～100 位字母、数字、冒号、下划线或短横线。一次提交最多 152 行，禁止重复菜品加口味；1.3 元品类每种菜品跨口味总量至少 10 串。餐次最多 50 位成员、200 次提交，文档容量也有上限。

## 自取 `/api/takeaway`

| action | 参数 | 用途 |
| --- | --- | --- |
| `submit` | `requestId,items,expectedTotal,name,phone,pickupAt,note` | 下单，返回 `order` |
| `list` | 无 | 只查看本人历史，返回 `orders` |
| `staffList` | 无 | 店员查看待取餐订单 |
| `complete` | `id,expectedTotal` | 店员确认实际收款与交付 |

取餐时间要满足当前营业时段、最短准备时间、最大提前天数。默认至少 15 分钟后、最多 7 天内。重复编号和相同内容恢复原订单，改内容重用编号拒绝。电话号码仅用于自取订单联系，不是登录方式。

## 门店运营 `/api/operations`

`publicSettings` 可由已识别的顾客调用，返回 `{settings,acceptingNow}`；其他操作至少要求店员权限：

| action | 参数 | 说明 |
| --- | --- | --- |
| `dashboard` | 无 | 当前桌台、自取、厨房与打印任务；繁忙时响应可能截断 |
| `saveSettings` | `expectedVersion,settings` | 仅店主；版本冲突返回 `SETTINGS_CHANGED` |
| `advance` | `kind,orderId,expectedStage,nextStage`，堂食还需 `sessionId` | 制作 `new → cooking → ready`，不改变付款状态 |
| `requestPrint` | `kind,orderId`，堂食还需 `sessionId` | 创建小票；补打加 `reprint:true,requestId` |
| `getTicket` | `jobId` | 获取完整厨房小票内容 |
| `markPrinted` | `jobId` | 人工确认已打印；没有打印机发送协议 |
| `stats` | `dateFrom,dateTo`，如 `2026-10-01` | 按北京时间统计，最多连续 31 天 |

`kind` 为 `dinein` 或 `takeaway`。默认营业设置：

```json
{
  "open": true,
  "useHours": false,
  "openTime": "10:00",
  "closeTime": "23:00",
  "weekdays": [1,2,3,4,5,6,7],
  "leadMinutes": 15,
  "advanceDays": 7
}
```

设置更新使用最近获取的 `settings.version` 作为 `expectedVersion`。暂停营业只拒绝新的提交，已提交订单和丢失响应的重试仍可核对。

统计收款金额使用完整数据库聚合；明细最多 200 笔，下单和菜品分析每类最多扫描 2,000 文档并限时，达到上限返回 `truncated:true`。截断的菜品排行不能当完整报表使用。堂食收款次数按餐次计、提交次数按加菜批次计。

## 常见错误

| code | 处理 |
| --- | --- |
| `UNAUTHENTICATED` | 检查是否经微信网关、AppID 是否匹配 |
| `FORBIDDEN` | 检查餐次成员身份或服务器店员角色 |
| `MIN_QUANTITY` / `PRICE_CHANGED` | 刷新菜单并核对数量 / 总价 |
| `TABLE_LOCKED` / `BILL_CHANGED` | 刷新本桌账单，不直接重复结账 |
| `TOKEN_REUSED` | 核对原提交；内容变化时使用新编号 |
| `SHOP_CLOSED` / `PICKUP_INVALID` | 查看营业设置，调整下单或取餐时间 |
| `SERVICE_UNAVAILABLE`（HTTP 503） | 服务或数据库故障；恢复后使用原编号核对是否已成功提交 |
