'use strict';

/**
 * 团队流程回放 —— 6 条案例的真跑测试。
 *
 * ── 这个文件在测什么 ─────────────────────────────────────────
 *
 * 不是"接口返回 ok"，而是**案例集里那些中文散文能不能被判成 true/false**：
 * `invariants` 36 条、`mustNotHappen` 21 条、`expectedState` 若干，
 * 全部由 `test/replay-runner.js` 翻译成机器判定。
 *
 * 所以每条测试的措辞是"机器可判定的断言全部通过"，
 * 而不是"接口没报错"。
 *
 * ── 一条硬规矩 ──────────────────────────────────────────────
 *
 * 若某条被判定为 **blocked**（实现缺陷），这条测试**必须红**，
 * 并在断言信息里写出 finding（现象 / 期望 / 实现位置 / 原始响应片段）。
 * **不许**标 `skip`、不许标 `todo`、更不许把断言放宽到能过 ——
 * 把红的测试改绿是最容易做、也最没有价值的一件事。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('./replay-runner');

/**
 * 六条案例共享同一次执行：执行器每条案例各建一个独立世界，
 * 重复跑只会浪费时间，不会带来额外信息。
 */
let pending = null;
function executed() {
  if (!pending) pending = runner.runTeamReplay();
  return pending;
}

function detailOf(r) {
  const lines = [];
  for (const s of r.steps) {
    if (!s.expectationPassed) lines.push(`第 ${s.step} 步（${s.action}）未达预期：${s.expectationEvidence}`);
  }
  for (const p of r.probes) {
    if (!p.verdictPassed) lines.push(`探针 ${p.id}（${p.action}）未达预期：${p.verdictEvidence}`);
  }
  for (const i of r.invariants) {
    if (i.checkedBy === 'machine' && !i.passed) lines.push(`不变量未通过「${i.text}」：\n  ${i.evidence}`);
  }
  for (const c of r.mustNotHappenChecks) {
    if (!c.passed) lines.push(`出现了「绝不允许发生」的现象「${c.text}」：\n  ${c.evidence}`);
  }
  for (const c of r.expectedStateChecks) {
    if (!c.passed) lines.push(`预期状态未通过「${c.text}」：${c.evidence}`);
  }
  return lines.length ? lines.join('\n') : '（没有失败的子项？请检查执行器）';
}

function blockedMessage(r) {
  const f = r.finding || {};
  const loc = Array.isArray(f.location) ? f.location.map((x) => `  · ${x}`).join('\n') : `  · ${f.location}`;
  return [
    `${r.caseId} 被判定为 blocked —— **实现缺陷**，不是案例写错、也不是断言太严。`,
    '',
    `【案例断言】${f.caseAssertion || '(未记录)'}`,
    `【现象】${f.symptom || '(未记录)'}`,
    `【期望】${f.expected || '(未记录)'}`,
    `【实现位置】\n${loc}`,
    `【原始响应片段】${JSON.stringify(f.rawResponse, null, 2)}`,
    `【为什么停在这里】${f.whyBlocked || ''}`,
    '',
    '按项目纪律：**不改实现**（那是另一件事）、**不放宽断言**。',
    '所以这条测试必须是红的；修好实现后删掉 replay-runner.js 里的这条裁决，它会自动恢复正常。',
  ].join('\n');
}

/** 一条案例的机器口径：不变量 + 绝不允许发生的现象 + 预期状态 + 每一步的期望。 */
function assertCasePassed(r) {
  assert.notEqual(r.status, 'blocked', blockedMessage(r));

  assert.equal(
    r.machineInvariants.failed,
    0,
    `${r.caseId} 有 ${r.machineInvariants.failed} 条不变量未通过：\n${detailOf(r)}`
  );

  assert.ok(
    r.machineInvariants.total > 0 && r.machineInvariants.checks > 0,
    `${r.caseId} 没有机器判定的不变量 —— 那就只剩"接口返回 ok"了，不算证据`
  );

  assert.equal(
    r.mustNotHappen.failed,
    0,
    `${r.caseId} 出现了"绝不允许发生"的现象：\n${detailOf(r)}`
  );

  assert.equal(
    r.expectedStateChecks.filter((c) => !c.passed).length,
    0,
    `${r.caseId} 预期状态未达成：\n${detailOf(r)}`
  );

  assert.equal(
    r.status,
    'passed',
    `${r.caseId} 的状态是 ${r.status}：\n${detailOf(r)}`
  );
}

for (const caseId of runner.REPLAY_CASE_IDS) {
  test(`团队流程回放 ${caseId}：机器可判定的断言全部通过`, async () => {
    const { results } = await executed();
    const r = results.find((x) => x.caseId === caseId);
    assert.ok(r, `执行器没有返回 ${caseId} 的结果`);
    assertCasePassed(r);
  });
}
