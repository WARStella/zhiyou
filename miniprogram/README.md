# miniprogram/ 由 A 负责

本目录是小程序前端代码，**归 A 所有**。

## 当前是脚手架，不是成品

B 为了让项目能在微信开发者工具里跑起来（否则模拟器会报
`根据 project.config.json 中 miniprogramRoot 指定的目录 miniprogram/，在该目录下未找到 app.json`），
建了一套**最小脚手架**：

| 文件 | 用途 | A 要做什么 |
|---|---|---|
| `app.json` | 页面注册与全局窗口样式 | 加页面、改导航栏，保留 `sitemapLocation` |
| `app.js` | 云开发初始化 `wx.cloud.init` | **保留**，这是后端连通的前提 |
| `app.wxss` | 全局样式 | 按设计稿替换 |
| `sitemap.json` | 搜索索引配置 | 保留即可 |
| `utils/api.js` | 后端调用统一封装 | **保留并沿用**，见下方第 2 条 |
| `pages/index/*` | **后端联调自检页** | 可删除或替换成正式首页 |

自检页的价值不在界面，而在于：**真机联调或外场实测出问题时，先跑一次自检，
就能立刻分清是"后端没通"还是"页面逻辑有问题"**。建议至少保留到 W2 三机联调结束。

---

B 只在这里留两条会直接影响前端配置的约定：

## 1. 位置接口必须在 `app.json` 声明，否则无法提交审核

使用了地理位置相关接口，就必须在 `app.json` 的 `requiredPrivateInfos` 中声明，
**且该 AppID 必须先获得对应接口权限**，否则提交代码审核会报
`61040 地理位置接口权限或声明缺失`。
依据：[小程序地理位置接口申请与使用指引](https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/product/apply_privacy_api.html)

```json
{
  "requiredPrivateInfos": ["getLocation", "onLocationChange", "startLocationUpdate"]
}
```

**注意**：`requiredPrivateInfos` 里写了什么，就必须真的申请到对应权限。
如果最终走**手动选点**的降级路径（用户在地图上点选自己的位置），
则不需要这些受限接口，提审时用 `privacy_api_not_use` 声明即可 —— 见
`../docs/00_今日行动_1013.md` §2 的 12:00 段。

## 2. 所有后端调用必须带两个字段

`utils/api.js` 统一封装，不要在每个页面里手写：

```js
wx.cloud.callFunction({
  name: 'api',
  data: {
    action: 'trip.plan',      // 域.动作
    requestId: uuid(),        // 每次操作新生成，重试时复用同一个 → 服务端据此去重
    expectedVersion: version, // 写操作必带 → 服务端据此拒绝旧版本确认
    payload: { /* ... */ }
  }
})
```

- `requestId` 复用是幂等的关键：网络超时重试时**必须复用同一个**，否则会重复执行。
- 忘记带 `expectedVersion` 时，改集合任务的确认会被服务端直接拒绝
  （见 `../docs/02_接口清单_v0.md` §3 第 4 条）—— 这是刻意的，防止旧版本确认生效。

完整接口清单见 `../docs/02_接口清单_v0.md`。
