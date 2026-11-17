'use strict';

/**
 * 人形特化的适配层 + 人数误差指标。
 *
 * 这份测试要证明的是：
 *   ① 服务端**声明了人形特化**，调用方才认；没声明就不许在界面上标"特化"；
 *   ② 质量指标只用来**解释误差方向**，绝不被换算成"实际人数"；
 *   ③ 上游返回结构任何一处不合格就整次拒绝（不猜人数）；
 *   ④ 误差指标算得对，且样本不足时明确说"不能当准确率"。
 *
 * 第 ② 条是这份测试的重点：把 `count` 乘一个系数"补偿漏检"是最容易
 * 通过演示、也最容易在真实照片上崩掉的做法。这里用测试把它挡住。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCrowdProvider, crowdConfig, normalizeDetector, normalizeQuality, detectorLabel, qualityHints } =
  require('../cloudfunctions/api/lib/guide/crowd');
const { summarize, summarizeGrid, BUCKETS, MIN_SAMPLES } = require('../cloudfunctions/api/lib/crowd-metrics');

const ENV = { YOLO_BASE_URL: 'https://detector.example.test', YOLO_API_KEY: 'private-token' };
const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';

test('计数请求失败区分鉴权、路径、图片限制、忙、模型未就绪与超时，错误正文不外泄', async () => {
  for (const [details, expected] of [
    [{ httpStatus: 401 }, /鉴权失败/], [{ httpStatus: 403 }, /拒绝访问/],
    [{ httpStatus: 404 }, /服务根地址/], [{ httpStatus: 413 }, /压缩/],
    [{ httpStatus: 429 }, /其他图片/], [{ httpStatus: 503 }, /模型尚未就绪/],
    [{ timeoutMs: 25000 }, /超过25秒/],
  ]) {
    const provider = createCrowdProvider({ env: ENV, http: async () => {
      throw Object.assign(new Error('private-token'), { details: { ...details, bodyHead: 'private-token' } });
    } });
    await assert.rejects(provider.countPeople(IMAGE), error => expected.test(error.message) && !error.message.includes('private-token'));
  }
});

/** 一份"合格的人形特化服务返回" */
function personResponse(overrides) {
  return Object.assign({
    count: 1,
    boxes: [{ x: 0.4, y: 0.3, width: 0.1, height: 0.3, confidence: 0.88 }],
    model: 'yolo11n-person',
    confidenceThreshold: 0.35,
    estimated: true,
    truncated: false,
    detector: { weights: '/app/weights/person.pt', personOnly: true, imgsz: 1024,
      tiling: { enabled: true, grid: 2, overlap: 0.2, merged: 'center-core+nms' } },
    quality: { imageWidth: 1920, imageHeight: 1080, meanBoxArea: 0.0031, smallBoxRatio: 0.43, edgeBoxRatio: 0.14, inferenceMs: 812 },
  }, overrides || {});
}
const count = (data) => createCrowdProvider({ env: ENV, http: async () => ({ json: data }) }).countPeople(IMAGE);

test('人形特化：声明了 personOnly 才在界面上标"特化"，并带上输入尺寸与切片参数', async () => {
  const r = await count(personResponse());
  assert.equal(r.count, 1);
  assert.equal(r.detector.personOnly, true);
  assert.equal(r.detector.weights, 'person.pt', '权重名只保留文件名，不带容器路径');
  assert.equal(r.detector.imgsz, 1024);
  assert.equal(r.detector.tiling.grid, 2);
  assert.equal(r.detectorLabel, '人形特化 · yolo11n-person · 输入 1024 · 2×2 切片');
});

test('人形特化：这张图没切片就写"整图推理"，不能拿配置回显冒充实际做法', async () => {
  // 服务端按图片大小自动决定：配置是 2×2，但这张 800px 的图整图推理
  const untitled = await count(personResponse({ detector: { personOnly: true, weights: 'person.pt', imgsz: 1024,
    tiling: { enabled: false, grid: 1, overlap: 0, merged: 'none' } } }));
  assert.equal(untitled.detector.tiling.enabled, false);
  assert.equal(untitled.detectorLabel, '人形特化 · yolo11n-person · 输入 1024 · 整图推理');

  // 老服务没有 enabled 字段时按 grid>1 兼容（那个版本只有配置、没有按图决定）
  const legacyShape = await count(personResponse({ detector: { personOnly: true, imgsz: 640,
    tiling: { grid: 2, overlap: 0.2, merged: 'nms' } } }));
  assert.equal(legacyShape.detector.tiling.enabled, true);
  assert.match(legacyShape.detectorLabel, /2×2 切片/);
});

test('B2 是否真的做完，只能看 classCount：80 类官方权重与 1 类微调权重在输出上完全一样', async () => {
  const tiling = { enabled: true, grid: 2, overlap: 0.2, merged: 'center-core+nms' };
  const single = await count(personResponse({ detector: { personOnly: true, classCount: 1, weights: 'person.pt', imgsz: 1280, tiling } }));
  assert.equal(single.detector.classCount, 1);
  assert.equal(single.detector.singleClass, true, 'classCount=1 才算 B2 权重');

  const coco = await count(personResponse({ detector: { personOnly: true, classCount: 80, weights: 'person.pt', imgsz: 1280, tiling } }));
  assert.equal(coco.detector.singleClass, false, '把官方权重改名成 person.pt 不能算完成 B2');

  // 老服务不报 classCount：如实标成未知，不默认成"单类"
  const unknown = await count(personResponse({ detector: { personOnly: true, weights: 'person.pt', imgsz: 1280, tiling } }));
  assert.equal(unknown.detector.classCount, null);
  assert.equal(unknown.detector.singleClass, false);

  // 越界值不采纳（0 类、非整数都不该被当成有效声明）
  const bad = await count(personResponse({ detector: { personOnly: true, classCount: 0, weights: 'p.pt', imgsz: 1280, tiling } }));
  assert.equal(bad.detector.classCount, null);
});

test('人形特化：没有声明 personOnly 的旧服务仍可用，但**不能**被标成特化', async () => {
  const legacy = personResponse({ detector: undefined, quality: undefined });
  const r = await count(legacy);
  assert.equal(r.detector, null);
  assert.equal(r.detectorLabel, null, '没声明就不许标特化 —— 否则"特化"两个字就没有信息量');
  assert.equal(r.quality, null);

  const notPersonOnly = await count(personResponse({ detector: { personOnly: false, weights: 'yolo11n.pt', imgsz: 640 } }));
  assert.equal(notPersonOnly.detector, null, 'personOnly=false 等同于没声明');
});

test('人形特化：detector 的细节坏了只丢细节，quality 坏了则整块作废', async () => {
  // detector 是"声明 + 可选细节"：personOnly 是这个声明本身，细节不合法只丢细节
  const partial = normalizeDetector({ personOnly: true, imgsz: 100 });
  assert.equal(partial.personOnly, true);
  assert.equal(partial.imgsz, null, '输入尺寸过小时不采纳，但不否认特化声明');
  assert.equal(normalizeDetector({ personOnly: true, tiling: { grid: 9, overlap: 0.2 } }).tiling, null, '切片数越界');
  assert.equal(normalizeDetector({ personOnly: true, tiling: { grid: 2, overlap: 0.9 } }).tiling, null, '重叠比例越界');
  // quality 是一组一起算出来的比例，混进一个越界值就说明服务端算错了，整块不可信
  assert.equal(normalizeQuality({ imageWidth: 0, imageHeight: 100, meanBoxArea: 0, smallBoxRatio: 0, edgeBoxRatio: 0 }), null);
  assert.equal(normalizeQuality({ imageWidth: 100, imageHeight: 100, meanBoxArea: 0.1, smallBoxRatio: 1.5, edgeBoxRatio: 0 }), null);
  const r = await count(personResponse({ quality: { imageWidth: 100, imageHeight: 100, meanBoxArea: 2, smallBoxRatio: 0, edgeBoxRatio: 0 } }));
  assert.equal(r.quality, null, '质量指标坏了不该让整次计数失败，但要标成不知道');
  assert.equal(r.count, 1, '计数本身仍然有效');
});

test('质量指标只解释误差方向，绝不换算成"实际人数"', async () => {
  const r = await count(personResponse());
  assert.equal(r.count, 1, 'count 必须就是检测到的目标数，不能被"补偿"过');
  assert.match(r.notice, /小目标占 43%/);
  assert.match(r.notice, /实际人数可能更多/);
  assert.doesNotMatch(r.notice, /边缘/, '0.14 的边缘比例不该凭空冒出一句提示');

  const edged = await count(personResponse({ quality: { imageWidth: 1080, imageHeight: 1920, meanBoxArea: 0.02, smallBoxRatio: 0.1, edgeBoxRatio: 0.42 } }));
  assert.match(edged.notice, /画面边缘/);
  assert.match(edged.notice, /低估/);

  // 界面上不能出现任何"推算人数"的字段
  for (const key of ['estimatedCount', 'adjustedCount', 'guess', 'inferred']) assert.equal(r[key], undefined);

  assert.deepEqual(qualityHints(null), []);
  assert.equal(qualityHints({ smallBoxRatio: 0.1, edgeBoxRatio: 0.1 }).length, 0, '指标正常时不该硬凑提示');
});

test('人数上限与截断：到上限必须说清"实际可能更多"', async () => {
  const many = Array.from({ length: 3 }, () => ({ x: 0.1, y: 0.1, width: 0.05, height: 0.2, confidence: 0.9 }));
  const r = await count(personResponse({ count: 3, boxes: many, truncated: true, quality: undefined }));
  assert.equal(r.truncated, true);
  assert.match(r.notice, /检测数量上限/);
});

test('零人仍然是一个有效结果：不报错、不提示"识别失败"', async () => {
  const r = await count(personResponse({ count: 0, boxes: [], detector: undefined, quality: undefined }));
  assert.equal(r.count, 0);
  assert.deepEqual(r.boxes, []);
  assert.doesNotMatch(r.notice, /失败|异常/);
});

test('上游返回结构任何一处不合格都整次拒绝，且不泄露密钥或上游原文', async () => {
  const bad = [
    personResponse({ count: 2 }),                                        // 数量与框数不一致
    personResponse({ model: 'guess' }),                                  // 模型名不认识
    personResponse({ confidenceThreshold: 0 }),                          // 阈值等于 0 说明没认真给
    personResponse({ confidenceThreshold: 1 }),                          // 等于 1 会拒绝一切
    personResponse({ estimated: false }),                                // 不承认是估计值
    personResponse({ boxes: [{ x: -0.01, y: 0, width: 1, height: 1, confidence: 1 }] }), // 坐标越界
    personResponse({ boxes: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1, confidence: 0.1 }] }), // 低于阈值
    personResponse({ count: 1001, boxes: Array.from({ length: 1001 }, () => ({ x: 0, y: 0, width: 0.1, height: 0.1, confidence: 0.9 })) }),
  ];
  for (const data of bad) {
    await assert.rejects(count(data), /结果异常/, JSON.stringify(data).slice(0, 80));
  }
  await assert.rejects(createCrowdProvider({ env: {} }).countPeople(IMAGE), /尚未部署/);
  await assert.rejects(
    createCrowdProvider({ env: ENV, http: async () => { throw new Error('Bearer private-token 被拒'); } }).countPeople(IMAGE),
    (e) => /暂不可用/.test(e.message) && !e.message.includes('private-token') && /未使用语言模型猜测人数/.test(e.message)
  );
});

test('配置只接受 HTTPS 且不带端口/账号/查询串 —— 密钥与地址都从环境读', () => {
  assert.equal(crowdConfig({}).available, false);
  assert.equal(crowdConfig({ YOLO_BASE_URL: 'http://x.test', YOLO_API_KEY: 'k' }).available, false, 'HTTP 明文不接受');
  assert.equal(crowdConfig({ YOLO_BASE_URL: 'https://x.test:8443', YOLO_API_KEY: 'k' }).available, false);
  assert.equal(crowdConfig({ YOLO_BASE_URL: 'https://u:p@x.test', YOLO_API_KEY: 'k' }).available, false);
  assert.equal(crowdConfig({ YOLO_BASE_URL: 'https://x.test/?a=1', YOLO_API_KEY: 'k' }).available, false);
  assert.equal(crowdConfig({ YOLO_BASE_URL: 'https://x.test/', YOLO_API_KEY: 'k' }).available, true);
});

test('误差指标：MAE / RMSE / bias 三个数分别是"平均差多少""是否稳定""偏多还是偏少"', () => {
  const s = summarize([
    { expected: 0, predicted: 0 },
    { expected: 1, predicted: 1 },
    { expected: 4, predicted: 3 },
    { expected: 5, predicted: 6 },
    { expected: 9, predicted: 7 },
    { expected: 12, predicted: 12 },
  ]);
  // |0|+|0|+|−1|+|+1|+|−2|+|0| = 4 → /6
  assert.equal(s.n, 6);
  assert.equal(s.mae, 0.67);
  // 0+0+1+1+4+0 = 6 → /6 = 1 → sqrt = 1
  assert.equal(s.rmse, 1);
  // 0+0−1+1−2+0 = −2 → /6 = −0.33
  assert.equal(s.bias, -0.33, '指标必须能看出"系统性少算"');
  assert.equal(s.exact, 3);
  assert.equal(s.over, 1);
  assert.equal(s.under, 2);
  assert.equal(s.maxAbsError, 2);
  // 真值 0 / 1—5 / 6—15 三档有样本，16—50 与 51+ 为空，不出现在报告里
  assert.equal(s.buckets.length, 3);
  assert.match(s.note, /样本仅 6 张/);
});

test('误差指标：按真值分桶，才能暴露"人越多错得越多"', () => {
  const s = summarize([
    { expected: 2, predicted: 2 }, { expected: 3, predicted: 3 },
    { expected: 60, predicted: 20 }, { expected: 80, predicted: 30 },
  ]);
  assert.equal(s.buckets.find((b) => b.key === 'few').mae, 0);
  const crowd = s.buckets.find((b) => b.key === 'crowd');
  assert.equal(crowd.n, 2);
  assert.equal(crowd.mae, 45);
  assert.equal(crowd.bias, -45);
  assert.equal(BUCKETS.length, 5);
});

test('误差指标：空样本不抛错、不编数字；非法计数必须报错而不是静默跳过', () => {
  const empty = summarize([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.mae, null);
  assert.match(empty.note, /无法给出误差/);
  assert.throws(() => summarize([{ expected: -1, predicted: 0 }]), /非负整数/);
  assert.throws(() => summarize([{ expected: 3, predicted: 2.5 }]), /非负整数/);
});

test('评测样例集必须自报"合成"，否则它会被当成真实准确率', () => {
  const raw = require('./fixtures/crowd-samples.json');
  assert.equal(raw.meta.synthetic, true, '合成样例必须显式标注，否则报告会被误读');
  assert.ok(raw.meta.note.includes('不代表任何真实检测结果'));
  for (const sample of raw.samples) {
    assert.ok(Number.isSafeInteger(sample.expected) && sample.expected >= 0);
    assert.ok(Number.isSafeInteger(sample.predicted) && sample.predicted >= 0);
  }
});

// ── B1：置信度标定的汇总 ─────────────────────────────────────
const cell = (threshold, pairs) => ({ threshold, samples: pairs.map(([expected, predicted]) => ({ expected, predicted })) });
const repeat = (count, pair) => Array.from({ length: count }, () => pair);

test('标定汇总：每个 (IoU, conf) 一行，样本够才给推荐', () => {
  const result = summarizeGrid([{
    iou: 0.5,
    grid: [
      cell(0.3, repeat(20, [10, 10])),   // 全对 → MAE 0
      cell(0.45, repeat(20, [10, 11])),  // 每张多算 1 → MAE 1
    ],
  }]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].threshold, 0.3);
  assert.equal(result.rows[0].n, 20);
  assert.equal(result.rows[0].mae, 0);
  assert.equal(result.best.threshold, 0.3);
  assert.equal(result.note, null);
});

test('标定汇总：样本不足 ' + MIN_SAMPLES + ' 张时不给推荐 —— 这种"最优阈值"换批照片就失效', () => {
  const result = summarizeGrid([{ iou: 0.5, grid: [cell(0.35, repeat(5, [3, 4]))] }]);
  assert.equal(result.best, null);
  assert.match(result.note, /未达到 20 张/);
  assert.equal(summarizeGrid([]).best, null);
  assert.match(summarizeGrid([]).note, /没有可汇总/);
});

test('标定汇总：MAE 打平时先看偏差、再看谁更保守', () => {
  // 两档 MAE 都是 1：一档系统性多算 1 人，一档一半多算一半少算（bias=0）
  const biasTie = summarizeGrid([{
    iou: 0.5,
    grid: [
      cell(0.30, repeat(20, [10, 11])),
      cell(0.45, Array.from({ length: 20 }, (_, i) => (i < 10 ? [10, 9] : [10, 11]))),
    ],
  }]);
  assert.equal(biasTie.rows[0].mae, 1);
  assert.equal(biasTie.rows[1].mae, 1);
  assert.equal(biasTie.best.threshold, 0.45, 'bias 为 0 的档更稳');

  // bias 也打平 → 选更高的阈值（框更少，宁可少算也不凭空多出人）
  const thresholdTie = summarizeGrid([{
    iou: 0.5,
    grid: [
      cell(0.30, Array.from({ length: 20 }, (_, i) => (i < 10 ? [10, 9] : [10, 11]))),
      cell(0.45, Array.from({ length: 20 }, (_, i) => (i < 10 ? [10, 9] : [10, 11]))),
    ],
  }]);
  assert.equal(thresholdTie.best.threshold, 0.45);
});

test('标定汇总：多组 IoU 都进表，坏行不会把整张表带崩', () => {
  const result = summarizeGrid([
    { iou: 0.4, grid: [cell(0.3, repeat(20, [5, 4]))] },
    { iou: 0.6, grid: [cell(0.3, repeat(20, [5, 5]))] },
    null,
    { iou: 0.7 },
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].iou, 0.4);
  assert.equal(result.best.iou, 0.6);
  assert.equal(result.best.mae, 0);
});

/**
 * 跨语言契约检查。
 *
 * 服务是 Python、调用侧是 Node，两边由不同的时间、可能由不同的人写。
 * 这类"两个仓库各改一边"的漂移不会有任何报错：Python 少返回一个字段，
 * Node 只会说"结果异常，请重新检测"，然后所有人去查网络。
 * 所以这里直接读 Python 源码断言关键字段与默认值，把漂移变成一条明确的失败。
 */
test('Node 调用侧与 Python 服务的契约不能各改一边', () => {
  const root = path.join(__dirname, '..', 'services', 'crowd');
  assert.ok(fs.existsSync(root), 'services/crowd 缺失：部署文档与 README 都指向它，不能只留文档');

  const detector = fs.readFileSync(path.join(root, 'detector.py'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

  // ① 响应字段：少一个 Node 就整次拒绝
  for (const key of ['"count"', '"boxes"', '"model"', '"confidenceThreshold"', '"estimated"',
    '"truncated"', '"detector"', '"quality"', '"personOnly"', '"imgsz"', '"tiling"',
    '"meanBoxArea"', '"smallBoxRatio"', '"edgeBoxRatio"', '"imageWidth"', '"imageHeight"', '"inferenceMs"']) {
    assert.ok(detector.includes(key), `detector.py 的响应里缺少 ${key}`);
  }

  // ② 只推理 person 单类 —— 这是"特化"的第一条硬约束
  assert.match(detector, /classes\s*=\s*\[PERSON_CLASS_ID\]/,
    '推理必须显式限定 person 单类（classes=[PERSON_CLASS_ID]），不能跑 80 类再筛');

  // ③ 默认模型名必须能被 Node 侧的正则接受
  const model = detector.match(/DEFAULT_MODEL_NAME\s*=\s*"([^"]+)"/);
  assert.ok(model, 'detector.py 必须有 DEFAULT_MODEL_NAME');
  assert.match(model[1], /^yolo[\w.-]{1,60}$/i, `默认模型名 ${model[1]} 不满足 Node 侧的校验正则`);

  // ④ 三个路由与"包括 /health 在内全路径鉴权"
  for (const route of ['"/health"', '"/model"', '"/count"']) assert.ok(app.includes(route), `app.py 缺少路由 ${route}`);
  assert.ok(app.includes('before_request'), '鉴权必须挂成全局钩子，否则新加路由会默认裸奔');

  // ⑤ 后台微调脚本与数据集配置要跟着服务走，否则"特化"只剩一句口号
  for (const file of ['train/finetune.py', 'train/person.yaml', 'Dockerfile', 'requirements.txt']) {
    assert.ok(fs.existsSync(path.join(root, file)), `services/crowd/${file} 缺失`);
  }
});
