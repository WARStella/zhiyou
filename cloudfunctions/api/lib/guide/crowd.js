'use strict';

/**
 * 人群计数适配层 —— 调用**人形特化**的 YOLO 检测服务。
 *
 * ── 这一层存在的理由 ─────────────────────────────────────────
 *
 * 检测服务的输出会直接变成界面上的一句「约 N 人」。计数错一个不影响什么，
 * 但**返回结构错一个字段**就会让页面把 `undefined` 当成人数显示出来。
 * 所以这里对上游做**逐字段校验**：数量、坐标、置信度、模型名、特化声明、
 * 质量指标，任何一条不合格都整次拒绝，绝不"尽力猜一个数"。
 *
 * ── "人形特化"在协议上是什么 ─────────────────────────────────
 *
 * 通用 YOLO 有 80 类，只取 person 一类就叫特化是**不够**的：
 *   · 人群照片里人普遍很小、互相遮挡 → 需要更高输入分辨率与切片推理；
 *   · 远景小目标与画面边缘的截断人体 → 需要专门的过滤与提示；
 *   · 这些安排必须能被调用方**看见**，否则"特化了没有"无从验证。
 *
 * 所以服务端必须回一个 `detector` 对象（`personOnly: true` + 权重名 +
 * 输入尺寸 + 切片参数）和一个 `quality` 对象（小目标比例、边缘截断比例）。
 * 本项目用它们做两件事：① 在界面上标明这次是谁在数；② 把"结果可能偏低"
 * 的原因说清楚 —— 而不是给一个人数就完事。
 *
 * 老版本服务没有这两个字段时仍然可用（向后兼容），但会明确标成"未声明特化"。
 */

const { defaultTransport } = require('../http');
const { assert, CODES } = require('../errors');

/** 置信度阈值只在 (0,1) 开区间内才有意义；等于 0 或 1 都说明服务端没认真给 */
const inUnit = (v) => Number.isFinite(v) && v > 0 && v < 1;
const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

function crowdConfig(env = process.env) {
  const base = String(env.YOLO_BASE_URL || '').trim().replace(/\/+$/, ''), key = String(env.YOLO_API_KEY || '').trim();
  let valid = false;
  try { const u = new URL(base); valid = u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (!u.port || u.port === '443'); } catch (_) {}
  return { base, key, available: Boolean(valid && key) };
}

/**
 * 归一化 `detector`。
 *
 * 三种情况**必须分开**，因为它们对用户的含义完全不同：
 *   · 没给（老服务）→ `null`，界面不标特化；
 *   · 给了但 `personOnly !== true` → `null`，同样不标 —— 不能把"自称特化"
 *     但没声明单类的服务当作特化；
 *   · 给了且声明单类 → 带出权重名、输入尺寸、切片参数。
 */
function normalizeDetector(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.personOnly !== true) return null;
  /** 权重名只留文件名：路径可能带出容器内目录结构，没必要暴露 */
  const weights = typeof raw.weights === 'string'
    ? raw.weights.replace(/\\/g, '/').split('/').filter(Boolean).pop().slice(0, 80)
    : null;
  const imgsz = Number.isSafeInteger(raw.imgsz) && raw.imgsz >= 256 && raw.imgsz <= 4096 ? raw.imgsz : null;
  /**
   * 权重里的类别数。**这是"B2 到底做完没有"唯一能验证的数**：
   * 官方 yolo11n 是 80 类、只取 person；B2 微调权重是 1 类。
   * 两者在输出上完全一样，所以必须由服务端报出来、调用方保留下来，
   * 否则"部署了 person.pt"这件事无法从行为上核对。
   */
  const classCount = Number.isSafeInteger(raw.classCount) && raw.classCount >= 1 && raw.classCount <= 1000
    ? raw.classCount : null;
  const tiling = raw.tiling && typeof raw.tiling === 'object'
    && Number.isSafeInteger(raw.tiling.grid) && raw.tiling.grid >= 1 && raw.tiling.grid <= 4
    && inRange(raw.tiling.overlap, 0, 0.5)
    ? { grid: raw.tiling.grid, overlap: raw.tiling.overlap,
      /**
       * `enabled` 描述的是**这一张图实际切没切**（服务端按图片大小自动决定）。
       * 老服务没有这个字段时按"grid>1 就算切了"兼容 —— 那个版本只有配置、
       * 没有按图决定，等价于总是切。
       */
      enabled: typeof raw.tiling.enabled === 'boolean' ? raw.tiling.enabled : raw.tiling.grid > 1,
      merged: typeof raw.tiling.merged === 'string' ? raw.tiling.merged.slice(0, 40) : null }
    : null;
  return { personOnly: true, weights, imgsz, classCount, singleClass: classCount === 1, tiling };
}

/** 归一化 `quality`：比例越界就整块作废，不"修一修继续用" */
function normalizeQuality(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const positive = (v) => Number.isSafeInteger(v) && v > 0 && v <= 20000;
  if (!positive(raw.imageWidth) || !positive(raw.imageHeight)) return null;
  if (!inRange(raw.meanBoxArea, 0, 1) || !inRange(raw.smallBoxRatio, 0, 1) || !inRange(raw.edgeBoxRatio, 0, 1)) return null;
  return {
    imageWidth: raw.imageWidth, imageHeight: raw.imageHeight,
    meanBoxArea: raw.meanBoxArea, smallBoxRatio: raw.smallBoxRatio, edgeBoxRatio: raw.edgeBoxRatio,
    inferenceMs: Number.isSafeInteger(raw.inferenceMs) && raw.inferenceMs >= 0 && raw.inferenceMs <= 600000 ? raw.inferenceMs : null,
  };
}

/** 一句能贴到界面上的"这次是谁在数、怎么数的" */
function detectorLabel(detector, model) {
  if (!detector) return null;
  const parts = ['人形特化', model];
  if (detector.imgsz) parts.push('输入 ' + detector.imgsz);
  if (detector.tiling) {
    /**
     * 服务端会按图片大小决定切不切。**这里必须如实说这一次的实际情况**：
     * 配置了 2×2、但这张 800px 的图是整图推理的，就不能标"2×2 切片"，
     * 否则界面上那行字只是配置回显，不是证据。
     */
    if (detector.tiling.enabled && detector.tiling.grid > 1) {
      parts.push(detector.tiling.grid + '×' + detector.tiling.grid + ' 切片');
    } else {
      parts.push('整图推理');
    }
  }
  return parts.join(' · ');
}

/**
 * 由质量指标推出**能解释误差方向**的提示。
 *
 * ⚠️ 只说方向，不说数值：`smallBoxRatio` 高**意味着**漏检可能偏多，
 * 但不等于"实际人数 = 检测数 × 1.3"。乘一个魔法系数是最容易做、
 * 也最容易在下一张照片上错得离谱的做法，本项目不做。
 */
function qualityHints(quality) {
  const hints = [];
  if (!quality) return hints;
  if (quality.smallBoxRatio >= 0.4) {
    hints.push('画面中远处小目标占 ' + Math.round(quality.smallBoxRatio * 100) + '%，这类人体容易漏检，实际人数可能更多。');
  }
  if (quality.edgeBoxRatio >= 0.3) {
    hints.push('部分人体位于画面边缘，可能被截断，结果偏向低估。');
  }
  return hints;
}

function createCrowdProvider(options = {}) {
  const config = crowdConfig(options.env);
  return {
    available: config.available,
    async countPeople(imageBase64) {
      assert(config.available, CODES.NOT_IMPLEMENTED, 'YOLO 人群计数服务尚未部署，请配置 YOLO_BASE_URL 和 YOLO_API_KEY');
      let data;
      try {
        const result = await (options.http || defaultTransport)(config.base + '/count', { method: 'POST', timeoutMs: 25000,
          maxBytes: 256 * 1024, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.key },
          body: JSON.stringify({ imageBase64 }) });
        data = result && result.json;
      } catch (error) {
        const details = error && error.details || {};
        const status = Number.isInteger(details.httpStatus) ? details.httpStatus : null;
        const timeout = Boolean(details.timeoutMs);
        const messages = {
          400: 'YOLO 无法读取这张图片，请换一张 JPG 或 PNG 图片重试',
          401: 'YOLO 服务鉴权失败，请核对云函数与计数服务的 YOLO_API_KEY 是否一致',
          403: 'YOLO 服务拒绝访问，请检查云托管访问权限',
          404: 'YOLO 计数接口不存在，请检查 YOLO_BASE_URL 是否为服务根地址（不要带 /count）',
          413: '图片超过计数服务大小限制，请压缩后重试',
          429: 'YOLO 服务正在处理其他图片，请稍后重试',
          500: 'YOLO 推理失败，请检查计数服务日志',
          503: 'YOLO 模型尚未就绪，请检查权重文件和服务启动日志',
          504: 'YOLO 服务网关超时，请稍后重试并检查服务实例状态',
        };
        console.warn('[guide.crowd]', JSON.stringify({ reason: timeout ? 'timeout' : 'request_failed', httpStatus: status }));
        assert(false, CODES.INSUFFICIENT_DATA, timeout
          ? 'YOLO 计数超过25秒，请稍后重试；若持续超时，请检查服务冷启动及推理耗时'
          : messages[status] || 'YOLO 计数暂不可用，请检查服务网络连接或稍后重试；未使用语言模型猜测人数');
      }
      assert(data && data.estimated === true && Number.isSafeInteger(data.count) && data.count >= 0 && data.count <= 1000 &&
        Array.isArray(data.boxes) && data.boxes.length === data.count && /^yolo[\w.-]{1,60}$/i.test(data.model || '') &&
        inUnit(data.confidenceThreshold) &&
        data.boxes.every(b => b && [b.x, b.y, b.width, b.height, b.confidence].every(Number.isFinite) &&
          b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0 && b.x + b.width <= 1.00001 && b.y + b.height <= 1.00001 &&
          b.confidence >= data.confidenceThreshold && b.confidence <= 1), CODES.INSUFFICIENT_DATA, 'YOLO 返回结果异常，请重新检测');

      const detector = normalizeDetector(data.detector);
      const quality = normalizeQuality(data.quality);
      const hints = qualityHints(quality);
      const parts = ['仅统计照片中检测到的人体，遮挡、远处小目标可能漏检，结果为估计值，不代表现场实时人数。'];
      if (data.truncated) parts.push('已达到检测数量上限，实际人数可能更多。');
      parts.push(...hints);

      return {
        count: data.count, model: data.model, confidenceThreshold: data.confidenceThreshold, estimated: true,
        truncated: Boolean(data.truncated),
        boxes: data.boxes.map(({ x, y, width, height, confidence }) => ({ x, y, width, height, confidence })),
        /**
         * 特化声明与质量指标**原样带出**（已归一化）。界面据此显示
         * 「人形特化 · yolo11n-person · 输入 1024 · 2×2 切片」，
         * 让"用的是什么、怎么数的"在页面上就能核对，而不是只写在文档里。
         */
        detector, detectorLabel: detectorLabel(detector, data.model), quality,
        notice: parts.join(''),
      };
    },
  };
}

module.exports = { crowdConfig, createCrowdProvider, normalizeDetector, normalizeQuality, detectorLabel, qualityHints };
