'use strict';

/**
 * 测试世界 —— 用内存仓储 + 真实 invoke 路径构造一个可端到端调用的环境。
 *
 * 关键：测试调用的是**与线上完全相同的 invoke 与 actions 代码**，
 * 只有仓储实现不同。这是"没有 AppID 也能开发"的验证方式。
 */

const { createMemoryRepo } = require('../cloudfunctions/api/lib/repo/memory');
const { invoke } = require('../cloudfunctions/api/lib/invoke');
const { createMapProvider } = require('../cloudfunctions/api/lib/map');
const C = require('../cloudfunctions/api/lib/repo/collections');
const fixtures = require('./fixtures/places');

/**
 * 假地图服务的**默认工厂** —— 通过 ctx 注入，而不是设环境变量。
 *
 * 为什么不用 `process.env.MAP_PROVIDER = 'fake'`：
 *   那会让产品代码为了可测而读一个只对测试有意义的环境变量，
 *   而且**注入不了"上游故障"这种状态**（只能靠再加一个
 *   `MAP_FAKE_FAIL` 之类的后门 —— 那正是要避免的东西）。
 *
 * 注入工厂则可以表达任意情况：正常、故障、特定 Key、特定延迟。
 */
const defaultMapFactory = (name, opts) => createMapProvider(name || 'fake', opts);

/** 固定基准时刻，保证测试可复现。 */
const NOW = new Date('2026-10-20T01:00:00.000Z');

let requestCounter = 0;
const newRequestId = () => `req_${++requestCounter}`;

async function makeWorld(opts) {
  opts = opts || {};
  const base = new Date(opts.now || NOW);
  const repo = createMemoryRepo({ now: base.getTime() });

  await repo.__seed(C.PLACES, fixtures.places);

  /**
   * @param {string} openid
   * @returns {(action:string, payload?:object, o?:object) => Promise<object>}
   */
  const clientFor = (openid) => (action, payload, o) => {
    o = o || {};
    return invoke(
      {
        action,
        requestId: o.requestId === null ? null : o.requestId || newRequestId(),
        expectedVersion: o.expectedVersion,
        payload: payload || {},
      },
      {
        repo,
        openid,
        env: opts.env || 'dev',
        now: o.now ? new Date(o.now) : base,
        /** 动作层通过它拿到地图服务；测试可注入任意实现 */
        createMapProvider: opts.createMapProvider || defaultMapFactory,
      }
    );
  };

  return {
    repo,
    NOW: base,
    clientFor,
    A: clientFor('openid_A'),
    B: clientFor('openid_B'),
    C: clientFor('openid_C'),
    at: (iso) => new Date(iso),
    plusMin: (min) => new Date(base.getTime() + min * 60000),
  };
}

/** 建一支三人小队，返回 {crewId, A, B, C}（都已是客户端函数）。 */
async function makeCrew(world, name) {
  const created = await world.A('crew.create', { name: name || '测试小队' });
  if (!created.ok) throw new Error(`建队失败：${JSON.stringify(created.error)}`);
  const { crewId, inviteCode } = created.data;

  for (const who of ['B', 'C']) {
    const r = await world[who]('crew.join', { inviteCode });
    if (!r.ok) throw new Error(`${who} 入队失败：${JSON.stringify(r.error)}`);
  }
  return { crewId, inviteCode };
}

const expectOk = (res) => {
  if (!res.ok) {
    throw new Error(`期望成功但失败：${res.error && res.error.code} ${res.error && res.error.message}`);
  }
  return res.data;
};

const expectFail = (res, code) => {
  if (res.ok) throw new Error(`期望失败（${code}）但成功了：${JSON.stringify(res.data)}`);
  if (code && res.error.code !== code) {
    throw new Error(`期望错误码 ${code}，实际 ${res.error.code}：${res.error.message}`);
  }
  return res.error;
};

module.exports = { makeWorld, makeCrew, expectOk, expectFail, NOW, fixtures, C, defaultMapFactory, createMapProvider };
