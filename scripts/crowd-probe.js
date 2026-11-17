/**
 * 人群计数服务的连通性与"特化声明"复测。
 *
 *   node scripts/crowd-probe.js
 *
 * 为什么单独一个探针：`/count` 返回 200 不等于返回的东西可用。
 * 这个脚本把**契约里的关键字段**逐项打出来 —— 尤其是 `detector`
 * （人形特化怎么声明的）与 `quality`（这次图像条件如何）。
 * 少一个字段，适配层会整次拒绝；早点在探针里看见，比在页面上看见"计数失败"好。
 *
 * 密钥只从 `.env.local` 读，不打印、不写日志。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCrowdProvider, crowdConfig } = require('../cloudfunctions/api/lib/guide/crowd');

const envFile = path.join(__dirname, '..', '.env.local');
if (!fs.existsSync(envFile)) {
  console.log('没有找到 .env.local，跳过探针（密钥不写在代码里，所以无法默认运行）。');
  process.exit(0);
}
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.trim().match(/^([A-Za-z0-9_]+)\s+(\S+)$/);
  if (m) env[m[1]] = m[2];
}

const config = crowdConfig(env);
console.log('YOLO_BASE_URL 已配置：', Boolean(config.base));
console.log('YOLO_API_KEY 已配置：', Boolean(config.key));
if (!config.available) {
  console.log('配置不完整：需要 https 根地址与密钥。适配层会返回"尚未部署"，不会用语言模型猜人数。');
  process.exit(0);
}

const b64File = process.env.PROBE_IMAGE || path.join(process.env.TEMP || '/tmp', 'probe2.b64');
if (!fs.existsSync(b64File)) {
  console.log('没有找到待测图片（' + b64File + '）。可以用 PROBE_IMAGE=<base64 文件路径> 指定。');
  console.log('服务连通性可以用空白图验证 0 人，但 0 人不代表识别准确率。');
  process.exit(0);
}

const b64 = fs.readFileSync(b64File, 'utf8').trim();
const provider = createCrowdProvider({ env });

(async () => {
  console.log('provider.available:', provider.available);
  const t0 = Date.now();
  const r = await provider.countPeople(b64);
  console.log('耗时(ms):', Date.now() - t0);
  console.log('人数:', r.count, '（truncated:', r.truncated, '）');
  console.log('模型:', r.model, '· 阈值:', r.confidenceThreshold);
  console.log('特化声明:', r.detectorLabel || '未声明（老版本服务，或没有开人形特化）');
  if (r.detector) {
    console.log('  detector:', JSON.stringify(r.detector));
    const classes = r.detector.classCount;
    if (classes === 1) console.log('  权重类型: 单类（B2 微调权重，classCount=1）');
    else if (classes) console.log('  权重类型: %d 类官方权重，只取 person 类 —— **不是** B2 微调权重', classes);
    else console.log('  权重类型: 服务端未能读出类别数（老版本），无法据此判断 B2 是否已生效');
  }
  if (r.quality) console.log('  quality:', JSON.stringify(r.quality));
  console.log('提示:', r.notice);
  console.log('');
  console.log('说明：单个样本只证明链路通了，不构成准确率结论；要误差请用 scripts/crowd-eval.js 做人工对照。');
})().catch((e) => {
  console.error('失败:', e.code || '', e.message);
  process.exit(1);
});
