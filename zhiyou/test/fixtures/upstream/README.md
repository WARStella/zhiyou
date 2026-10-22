# 上游真实返回的录音

这里存的是**腾讯位置服务真实调用返回的原始 body**，用于让解析代码跑在真实数据上。

## 为什么需要

`lib/map/fake.js` 的数据是**我自己写的**。它能测"排序函数对不对"，
但测不了"**我把真实返回解析对了吗**" —— 而后者才是最容易错的地方。

真实案例：`duration` 单位是**分钟**不是秒（815 米返回 12）。我按秒解析，
把每段步行时间算成实际的 **1/60**，而且**不报错** —— 页面照常显示，
只是数字错得离谱。这个 bug 是探针拿真实返回才发现的。

用录音跑测试 = 把当时的真实情况固化下来，任何时候都能重放，
而且重放的是**真实解析代码**（见 `lib/map/replay.js` 的设计说明）。

## 怎么录一条新的

1. 调对应的探针或接口，例如从自检页点「地图接口探针」
2. 把返回里的 `rawHead`（或完整 body）另存为 JSON
3. 按下面格式包一层：

```json
{
  "name": "给人看的名字",
  "kind": "direction-walking | place-search | geocoder",
  "source": "腾讯位置服务 WebServiceAPI 真实调用",
  "recordedAt": "2026-10-13",
  "request": { "keyword": "冰雪大世界" },
  "note": "如有截断要在这里说明",
  "httpStatus": 200,
  "body": { /* 原样的上游返回 */ }
}
```

`request` 用于在同类录音里挑对的那条（可选，只有一条时可以省略）。

4. 加一条测试，用 `createReplayTransport` 注入：

```js
const provider = createMapProvider('tencent', {
  http: createReplayTransport({ recordings: [record] }),
  key: 'REPLAY',
});
const r = await provider.walkingRoute(from, to);
assert.equal(r.durationMinutes, 12);   // 真实返回 + 真实解析
```

## ⚠️ 注意

- **必须原样保存，不要手改**。改了就不再是"上游说过的话"，
  那这批数据就退化成了另一个 `fake.js`。
- 如果记录被截断（比如 `rawHead` 有长度上限），**在 `note` 里说明**，
  并且测试**只断言确实存在的字段** —— 不要为了凑断言去补数据。

## 现有录音

| 文件 | 接口 | 完整度 |
|---|---|---|
| `direction-walking-central-avenue.json` | 步行路线 | ⚠️ steps 只保留前 4 条（原 8 条），polyline 完整。由 `rawHead` 的 1200 字上限所致 |

## 待补

- **`place-search-*.json`**：地点检索的真实返回还没录过。
  这份最有价值 —— 「冰雪大世界」那次真实检索返回了什么，目前只有截图，
  没有原始 body。下次在自检页或行程页触发一次检索后，把 `place.search`
  返回里的 `rawHead` 存进来。
