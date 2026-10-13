'use strict';

/**
 * 定时清理云函数 —— 位置精确数据的保留策略执行者（docs/01 §5）。
 *
 * 为什么必须有它：云开发控制台的索引选项不支持 TTL 自动过期（以控制台实际选项为准），
 * 所以"精确轨迹短期保留"这条隐私承诺必须靠定时任务兑现，不能只写在文档里。
 *
 * 建议触发频率：每小时一次。配置方式见 README「定时触发器」。
 *
 * 同时清理过期的幂等记录（operations），避免无限增长。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const BATCH = 100;

async function purge(collection, field, now) {
  let total = 0;
  for (let i = 0; i < 50; i++) {
    // 单次最多删 100 条，循环直到清完或达到上限
    const res = await db
      .collection(collection)
      .where({ [field]: _.lt(now) })
      .limit(BATCH)
      .get();
    if (!res.data.length) break;

    await Promise.all(res.data.map((doc) => db.collection(collection).doc(doc._id).remove()));
    total += res.data.length;
    if (res.data.length < BATCH) break;
  }
  return total;
}

exports.main = async () => {
  const now = new Date();
  const result = { ranAt: now.toISOString(), deleted: {} };

  try {
    result.deleted.locations = await purge('locations', 'expiresAt', now);
  } catch (e) {
    result.deleted.locations = -1;
    result.error = `locations 清理失败：${e.errMsg || e.message}`;
  }

  try {
    result.deleted.operations = await purge('operations', 'expiresAt', now);
  } catch (e) {
    result.deleted.operations = -1;
    result.error = (result.error || '') + ` operations 清理失败：${e.errMsg || e.message}`;
  }

  console.log('[timer-cleanup]', JSON.stringify(result));
  return result;
};
