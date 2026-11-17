'use strict';

/**
 * 内容安全：输入闸门、输出脱敏、云调用适配。
 *
 * 这份测试要证明的**不是"字面能拦几个词"**，而是四条结构性结论：
 *
 *   ① 本地规则必然可用（断网、没配权限时仍然生效）—— 这是"不裸奔"的来源；
 *   ② 云调用失败时**按部署方的选择**处置，且降级在元信息里可见（不静默）；
 *   ③ 被拒绝的内容**没有落库**（安全闸门在业务处理器与幂等缓存之前）；
 *   ④ 输出侧改写发生在**写库之前**（下一轮读到的也是脱敏后的文本）。
 *
 * 前两条对应"安全要可用"，后两条对应"安全要真的生效"。
 * 只测"包含敏感词就返回错误"很容易通过，但那说明不了上面任何一条。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');
const lexicon = require('../cloudfunctions/api/lib/safety/lexicon');
const policy = require('../cloudfunctions/api/lib/safety/policy');
const { createSafetyGate } = require('../cloudfunctions/api/lib/safety');
const { createCloudSafetyProvider, normalizeText } = require('../cloudfunctions/api/lib/safety/cloud');
const { sanitizeResult, FALLBACK } = require('../cloudfunctions/api/lib/safety/output');
const actions = require('../cloudfunctions/api/actions');

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';

/** 假云 provider：`text` / `image` 返回固定的归一化结果，并记账调用次数 */
function fakeCloud(handlers) {
  const h = handlers || {};
  const state = { textCalls: 0, imageCalls: 0, lastText: null };
  return {
    name: 'fake-cloud',
    textAvailable: true,
    imageAvailable: true,
    state,
    async checkText(args) { state.textCalls += 1; state.lastText = args; return h.text ? h.text(args) : { ok: true, level: 'pass' }; },
    async checkImage(args) { state.imageCalls += 1; return h.image ? h.image(args) : { ok: true, level: 'pass' }; },
  };
}
const gateWith = (provider, env) => createSafetyGate({
  provider,
  env: Object.assign({ SAFETY_MODE: 'cloud', SAFETY_FAIL_MODE: 'open' }, env || {}),
  now: () => Date.parse('2026-11-08T04:00:00.000Z'),
});

// ── 一、本地规则 ───────────────────────────────────────────────
test('本地规则：正常出游用语一律放行，不靠"少收词"换低误伤', () => {
  const normal = [
    '我到了，在一号口', '等你们五分钟', '先去中央大街，再去索菲亚教堂，最后到太阳岛',
    '哈哈哈哈哈笑死我了', '行程结束时间是多少？', '这里有 3 个人', '下午 17:30 集合',
    '哈工大哈工大哈工大', '附近有洗手间吗', '帮我看看明天的天气',
  ];
  for (const text of normal) {
    const r = lexicon.scan(text);
    assert.equal(r.level, 'pass', `不该拦：${text} → ${r.hits.map((h) => h.label).join(',')}`);
  }
});

test('本地规则：联系方式、站外链接、导流话术、人身威胁、不可见字符都能识别到具体标签', () => {
  const cases = [
    ['我的手机13800138000', 'contact.phone'],
    ['打 138 0013 8000 找我', 'contact.phone_spaced'],
    ['加我微信聊', 'contact.wechat'],
    ['QQ 12345678', 'contact.qq'],
    ['发到 a.b@example.com', 'contact.email'],
    ['看这个 https://evil.example.com/x', 'link.url'],
    ['去 taobao.com 下单', 'link.domain'],
    ['扫码进群', 'link.qrcode'],
    ['刷单日结，招代理', 'solicit.ad'],
    ['我要弄死你', 'threat.person'],
    ['正常\u200B文本', 'control.invisible'],
  ];
  for (const [text, label] of cases) {
    const r = lexicon.scan(text);
    assert.equal(r.level, 'risky', `该拦但没拦：${text}`);
    assert.ok(r.hits.some((h) => h.label === label), `${text} 未命中 ${label}，实际 ${r.hits.map((h) => h.label)}`);
  }
});

test('本地规则：全角数字与拆分写法同样命中（绕过写法不是漏洞）', () => {
  assert.equal(lexicon.scan('１３８００１３８０００').level, 'risky');
  assert.equal(lexicon.scan('微信　号：abc12345').level, 'risky');
});

test('本地规则的分组可以按字段裁剪，但不可见字符在昵称里同样要挡', () => {
  // emoji 变体选择符（U+FE0F）是正常输入，两层都不该拦
  assert.equal(lexicon.scan('小明\uFE0F', policy.NAME_GROUPS).level, 'pass');
  assert.equal(lexicon.scan('小明\uFE0F').level, 'pass');
  // 零宽字符：昵称里必须挡 —— `小明` 与 `小明\u200B` 界面上长得一样，可以冒充别人
  assert.equal(lexicon.scan('小明\u200B', policy.NAME_GROUPS).level, 'risky');
  assert.equal(lexicon.scan('小明\u200B').level, 'risky');
  // 导流话术也挡（昵称是曝光量最大的位置）
  assert.equal(lexicon.scan('刷单日结', policy.NAME_GROUPS).level, 'risky');
});

test('输出脱敏保留可读性：手机号留头尾，链接给占位，不整条丢弃', () => {
  const r = lexicon.mask('联系我 13800138000，或看 https://a.example.com/x ，谢谢');
  assert.match(r.text, /138\*{4}8000/);
  assert.ok(!r.text.includes('https://'), '链接必须整段消失');
  assert.match(r.text, /链接已省略/);
  assert.equal(r.severe, false);
  assert.deepEqual(r.masked.map((m) => m.label).sort(), ['contact.phone', 'link.url']);
});

test('输出脱敏：severe 内容不做脱敏，交给上层整条替换', () => {
  const r = lexicon.mask('我告诉你，弄死你');
  assert.equal(r.severe, true);
});

test('输出脱敏：先替换的占位会改变长度，后面的规则必须按新文本重新定位', () => {
  // 「加群」比占位短很多，若复用旧下标，「刷单」会被插到错误位置并留下残片
  const r = lexicon.mask('加群以后去刷单，QQ 12345678');
  assert.ok(!r.text.includes('刷单'), '第二处命中不能被漏掉或切错：' + r.text);
  assert.ok(!r.text.includes('12345678'));
  assert.ok(r.text.includes('以后去'), '正常文字不能被误删：' + r.text);
});

// ── 二、云调用适配 ──────────────────────────────────────────────
test('msgSecCheck 的两种返回形态都能归一，未知形状不当作"通过"', () => {
  assert.deepEqual(normalizeText({ errCode: 0, result: { suggest: 'pass', label: 100 } }), {
    ok: true, level: 'pass', label: 'wx.100', errCode: 0, errMsg: null, source: 'v2',
  });
  assert.equal(normalizeText({ errCode: 0, result: { suggest: 'risky', label: 20001 } }).level, 'risky');
  assert.equal(normalizeText({ errCode: 0, result: { suggest: 'review' } }).level, 'review');
  // 旧版把结论放在 errCode 里
  assert.equal(normalizeText({ errCode: 87014, errMsg: 'risky' }).level, 'risky');
  assert.equal(normalizeText({ errCode: 0 }).ok, false, '只有 errCode 0、没有 result 的形状不认识，不能当通过');
  assert.equal(normalizeText({ errCode: 47001, errMsg: 'bad args' }).ok, false);
  assert.equal(normalizeText(null).ok, false);
});

test('云调用超时明确返回 timeout，且不会把上游异常原文带出来', async () => {
  const hung = createCloudSafetyProvider({ openapi: { security: { msgSecCheck: () => new Promise(() => {}) } } }, { timeoutMs: 40 });
  const timedOut = await hung.checkText({ content: 'x', openid: 'o', scene: 2 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');

  const broken = createCloudSafetyProvider({ openapi: { security: { msgSecCheck: () => { const e = new Error('内部密钥 abc123'); e.errCode = 40001; throw e; } } } });
  const result = await broken.checkText({ content: 'x', openid: 'o', scene: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'threw');
  assert.equal(result.errCode, 40001);
  assert.ok(!JSON.stringify(result).includes('abc123'), '上游异常原文不得出现在结果里');
});

test('没有云环境时 provider 判为不可用，而不是假装通过', () => {
  const p = createCloudSafetyProvider({});
  assert.equal(p.available, false);
  assert.equal(p.textAvailable, false);
});

// ── 三、闸门：本地优先、云失败策略、缓存 ────────────────────────
test('闸门：本地规则命中时不再调用云 —— 一次配额都不该花', async () => {
  const cloud = fakeCloud();
  const gate = gateWith(cloud);
  const verdict = await gate.checkInput({ action: 'chat.send', payload: { text: '我手机13800138000' }, openid: 'o' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.provider, 'local');
  assert.equal(cloud.state.textCalls, 0);
  assert.match(verdict.message, /联系方式/, '提示要说清改什么，不能只说"不合规"');
});

test('闸门：云判 risky 拒绝、判 review 放行但留痕、判 pass 通过', async () => {
  const risky = await gateWith(fakeCloud({ text: () => ({ ok: true, level: 'risky', label: 'wx.20001' }) }))
    .checkInput({ action: 'chat.send', payload: { text: '我到了' }, openid: 'o' });
  assert.equal(risky.ok, false);
  assert.deepEqual(risky.labels, ['wx.20001']);
  assert.equal(risky.code, 'CONTENT_REJECTED');

  const review = await gateWith(fakeCloud({ text: () => ({ ok: true, level: 'review' }) }))
    .checkInput({ action: 'chat.send', payload: { text: '我到了' }, openid: 'o' });
  assert.equal(review.ok, true);
  assert.equal(review.review, true, 'review 允许通过，但必须留下标记');

  const passed = await gateWith(fakeCloud()).checkInput({ action: 'chat.send', payload: { text: '我到了' }, openid: 'o' });
  assert.equal(passed.ok, true);
  assert.equal(passed.review, false);
});

test('闸门：云失败时 open 放行并标 degraded，closed 拒绝且错误码指向"检测不可用"', async () => {
  const failing = fakeCloud({ text: () => ({ ok: false, reason: 'timeout' }) });

  const open = await gateWith(failing, { SAFETY_FAIL_MODE: 'open' })
    .checkInput({ action: 'chat.send', payload: { text: '我到了' }, openid: 'o' });
  assert.equal(open.ok, true);
  assert.equal(open.degraded, 'timeout', '降级必须可见，不能悄悄发生');

  const closed = await gateWith(failing, { SAFETY_FAIL_MODE: 'closed' })
    .checkInput({ action: 'chat.send', payload: { text: '我到了' }, openid: 'o' });
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'CONTENT_CHECK_UNAVAILABLE', '检测不可用与内容违规必须是两个码');
});

test('闸门：相同内容的检测结果会命中缓存，不重复花配额', async () => {
  const cloud = fakeCloud();
  const gate = gateWith(cloud);
  const first = await gate.checkText({ text: '我到了', groups: policy.CHAT_GROUPS, scene: 2, openid: 'o' });
  const second = await gate.checkText({ text: '我到了', groups: policy.CHAT_GROUPS, scene: 2, openid: 'o' });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(cloud.state.textCalls, 1);
});

test('闸门：SAFETY_MODE=off 时完全不检查（本地规则也不跑）', async () => {
  const cloud = fakeCloud();
  const gate = gateWith(cloud, { SAFETY_MODE: 'off' });
  const verdict = await gate.checkInput({ action: 'chat.send', payload: { text: '我手机13800138000' }, openid: 'o' });
  assert.equal(verdict.applied, false);
  assert.equal(cloud.state.textCalls, 0);
});

test('闸门：判定结果里不带用户原文（响应与日志都没有可泄露的正文）', async () => {
  const cloud = fakeCloud({ text: () => ({ ok: true, level: 'risky', label: 'wx.20001' }) });
  const verdict = await gateWith(cloud).checkInput({ action: 'chat.send', payload: { text: '这段话本身不该出现在判定里' }, openid: 'o' });
  assert.ok(!JSON.stringify(verdict).includes('这段话本身'));
});

// ── 四、端到端：拒绝发生在写库之前 ──────────────────────────────
test('chat.send：含联系方式的消息被拒，且没有任何一条消息落库', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const res = await w.A('chat.send', { crewId, text: '有事加我微信 13800138000', clientMessageId: 'cm-risk-1' });
  expectFail(res, 'CONTENT_REJECTED');
  assert.equal(await w.repo.count(C.CREW_MESSAGES), 0, '被拒的内容不能先落库再删');
  assert.equal(res.meta.safety.ok, false);
  assert.equal(res.meta.safety.field, 'text');
  assert.ok(!JSON.stringify(res).includes('13800138000'), '响应里不得回显被拦下的原文');
});

test('chat.send：被拒的请求不会写进幂等缓存 —— 换个内容用同一 requestId 能正常发出', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const bad = await w.A('chat.send', { crewId, text: '扫码进群', clientMessageId: 'cm-order-1' }, { requestId: 'fixed-req-order' });
  expectFail(bad, 'CONTENT_REJECTED');
  const good = await w.A('chat.send', { crewId, text: '我到了，在一号口', clientMessageId: 'cm-order-1' }, { requestId: 'fixed-req-order' });
  assert.equal(expectOk(good).message.text, '我到了，在一号口');
  assert.equal(good.meta.replayed, false, '这是一次真实执行，不是重放');
});

test('chat.send：正常消息通过，并在元信息里如实标出这次判定由谁做的', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const res = await w.A('chat.send', { crewId, text: '我到了，在一号口', clientMessageId: 'cm-ok-0001' });
  expectOk(res);
  assert.equal(res.meta.safety.ok, true);
  assert.equal(res.meta.safety.level, 'pass');
  // 测试环境没有云环境，provider 必须是 unavailable 而不是伪造成"已送检"
  assert.equal(res.meta.safety.provider, 'unavailable');
});

test('非策略动作完全不碰内容安全：没有判定、没有元信息、没有额外开销', async () => {
  const cloud = fakeCloud();
  const gate = gateWith(cloud);
  // 同步判断必须能把"根本不相关的动作"挡在异步路径之外 —— 入口靠它保持原有时序
  assert.equal(gate.covers('meet.create'), false);
  assert.equal(gate.covers('trip.plan'), false);
  assert.equal(gate.covers('chat.send'), true);
  assert.equal(gateWith(cloud, { SAFETY_MODE: 'off' }).covers('chat.send'), false);

  const w = await makeWorld({ safety: gate });
  const res = await w.A('user.login');
  expectOk(res);
  assert.equal(res.meta.safety, undefined);
  assert.equal(cloud.state.textCalls, 0);
  assert.equal(cloud.state.imageCalls, 0);
});

test('user.updateProfile：昵称里的联系方式被拒，且资料没有被改动', async () => {
  const w = await makeWorld();
  expectOk(await w.A('user.login'));
  expectFail(await w.A('user.updateProfile', { nickname: '找我 13800138000' }), 'CONTENT_REJECTED');
  assert.equal((await w.repo.findOne(C.USERS, { openid: 'openid_A' })).nickname, undefined);
  expectOk(await w.A('user.updateProfile', { nickname: '小明' }));
});

test('user.updateProfile：头像地址必须是云存储 fileID，站外地址不能存进去', async () => {
  const w = await makeWorld();
  expectOk(await w.A('user.login'));
  expectFail(await w.A('user.updateProfile', { avatarFileId: 'https://untrusted/avatar.png' }), 'INVALID_PARAM');
  expectFail(await w.A('user.updateProfile', { avatarFileId: '../../etc/passwd' }), 'INVALID_PARAM');
  expectOk(await w.A('user.updateProfile', { avatarFileId: 'cloud://env-1.abc/avatar.png' }));
});

test('guide.ask：提问里的站外链接在进入模型之前就被拒', async () => {
  let modelCalls = 0;
  const w = await makeWorld({
    createGuideProvider: () => ({ modelAvailable: true, visionAvailable: false,
      decide: async () => { modelCalls += 1; return { ok: true, data: { tool: 'finish' } }; } }),
  });
  const res = await w.A('guide.ask', { text: '看看 https://evil.example.com 这个' });
  expectFail(res, 'CONTENT_REJECTED');
  assert.equal(modelCalls, 0, '内容不合规的提问不该先花一次模型调用再拒');
});

// ── 五、输出侧 ────────────────────────────────────────────────
test('输出脱敏：模型文案、知识库片段、线索与提示各自按策略处理', async () => {
  const cloud = fakeCloud();
  const gate = gateWith(cloud);
  const out = await sanitizeResult({
    answer: '联系电话 13800138000，欢迎咨询',
    evidence: [{ chunkId: 'c1', text: '景区电话 13800138000', sourceId: 's1' }],
    clues: ['13800138000', '中央大街'],
    notices: ['图像结果是地点线索，需人工确认。'],
  }, { gate, action: 'guide.ask' });

  assert.equal(out.changed, true);
  assert.match(out.result.answer, /138\*{4}8000/);
  assert.match(out.result.evidence[0].text, /138\*{4}8000/);
  assert.deepEqual(out.result.clues, ['138****8000', '中央大街']);
  assert.equal(cloud.state.textCalls, 1, '只有模型主文案值得送云，固定模板与知识库原文不该花配额');
});

test('输出侧 severe 内容整条替换，并把原因写进用户能看到的提示', async () => {
  const gate = gateWith(fakeCloud());
  const out = await sanitizeResult({ answer: '我告诉你弄死你', notices: [] }, { gate, action: 'guide.ask' });
  assert.equal(out.replaced, true);
  assert.equal(out.result.answer, FALLBACK);
  assert.ok(out.result.notices.includes(FALLBACK), '替换了却不说明原因，用户只会以为助手坏了');
  assert.ok(!JSON.stringify(out.result).includes('弄死你'));
});

test('输出侧：云判 risky 时整条替换；判定失败时保留脱敏后的文本（不因接口抖动变成全不可用）', async () => {
  const risky = await sanitizeResult({ answer: '这是一段正常的话' },
    { gate: gateWith(fakeCloud({ text: () => ({ ok: true, level: 'risky' }) })), action: 'guide.ask' });
  assert.equal(risky.result.answer, FALLBACK);

  const flaky = await sanitizeResult({ answer: '这是一段正常的话' },
    { gate: gateWith(fakeCloud({ text: () => ({ ok: false, reason: 'timeout' }) })), action: 'guide.ask' });
  assert.equal(flaky.result.answer, '这是一段正常的话');
  assert.equal(flaky.replaced, false);
});

test('输出侧脱敏发生在写库之前：下一轮读取会话得到的也是脱敏后的线索', async () => {
  const w = await makeWorld({
    createGuideProvider: () => ({
      modelAvailable: false, visionAvailable: true, promptVersion: 'test',
      // 视觉模型把号码当成了"地点线索"—— 这类脏输出正是输出侧要兜的
      identify: async () => ({ ok: true, data: { names: ['13800138000'] } }),
    }),
  });
  const asked = expectOk(await w.A('guide.ask', { text: '这是哪儿', imageBase64: IMAGE }));
  assert.deepEqual(asked.clues, ['138****8000']);
  // `guide.get` 把会话里存的 `lastResponse` 平铺在顶层返回
  const reread = expectOk(await w.A('guide.get', { sessionId: asked.sessionId }));
  assert.deepEqual(reread.clues, ['138****8000'], '会话里存的必须也是脱敏后的版本');
  assert.ok(!JSON.stringify(reread.messages).includes('13800138000'));
});

// ── 六、图片 ──────────────────────────────────────────────────
test('图片：云判违规时计数请求被拒，且不会把照片发给 YOLO 服务', async () => {
  let counted = 0;
  const w = await makeWorld({
    safety: gateWith(fakeCloud({ image: () => ({ ok: true, level: 'risky' }) })),
    createGuideProvider: () => ({ modelAvailable: false, visionAvailable: false,
      countPeople: async () => { counted += 1; return { count: 0, boxes: [], estimated: true }; } }),
  });
  const res = await w.A('guide.countPeople', { imageBase64: IMAGE });
  expectFail(res, 'CONTENT_REJECTED');
  assert.equal(counted, 0, '照片不该在判违规之后仍然外传给检测服务');
});

test('图片：不在策略表里的动作不做图片检测（不白花配额）', async () => {
  const cloud = fakeCloud();
  const gate = gateWith(cloud);
  const verdict = await gate.checkImage({ action: 'user.updateProfile', bytes: Buffer.from('x'), contentType: 'image/png' });
  assert.equal(verdict.applied, false);
  assert.equal(cloud.state.imageCalls, 0);
});

// ── 七、结构与部署 ─────────────────────────────────────────────
test('策略表指向的 action 必须真实存在 —— 改了 action 名而策略表没跟上是会被发现的', () => {
  const registered = new Set(Object.keys(actions));
  for (const entry of policy.INPUT_POLICY.concat(policy.IMAGE_POLICY)) {
    assert.ok(registered.has(entry.action), `策略表里的 ${entry.action} 不在动作注册表里`);
  }
  for (const entry of policy.OUTPUT_POLICY) {
    assert.ok(registered.has(entry.action), `输出策略里的 ${entry.action} 不在动作注册表里`);
  }
});

test('部署配置里必须登记内容安全所需的云调用权限', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../cloudfunctions/api/config.json'), 'utf8'));
  const permissions = config.permissions && config.permissions.openapi;
  assert.ok(Array.isArray(permissions), 'permissions.openapi 必须是数组');
  for (const name of ['security.msgSecCheck', 'security.imgSecCheck']) {
    assert.ok(permissions.includes(name), `api/config.json 必须登记 ${name}，否则线上会以"没有权限"失败`);
  }
  assert.ok(permissions.includes('subscribeMessage.send'), '既有权限不能被顺手删掉');
});

test('健康检查如实报告内容安全：配置看不出真假时只能是 null，并报出当前生效的失败策略', () => {
  const { dependencyStatus } = require('../cloudfunctions/api/lib/config-health');
  const off = dependencyStatus({});
  assert.equal(off.contentSafety.configured, null);
  assert.equal(off.contentSafety.connectivity, 'not_probed');
  assert.equal(off.contentSafety.failMode, 'open');
  const strict = dependencyStatus({ SAFETY_FAIL_MODE: 'closed', SAFETY_MODE: 'cloud' });
  assert.equal(strict.contentSafety.failMode, 'closed');
  assert.equal(strict.contentSafety.mode, 'cloud');
});

test('错误码文档与代码一致：新增的两个内容安全码必须写进计划书', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/项目计划书.md'), 'utf8');
  for (const code of ['CONTENT_REJECTED', 'CONTENT_CHECK_UNAVAILABLE']) {
    assert.ok(doc.includes(code), `docs/项目计划书.md 里缺少错误码 ${code}`);
  }
});
