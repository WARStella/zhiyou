'use strict';

/**
 * 客户端错误码 → 诊断映射的测试。
 *
 * 为什么这个也要测：`utils/api.js` 里的 DIAGNOSES 是**按 SDK 报错文本做子串匹配**的。
 * 如果某天基础库升级改了报错措辞，映射会静默失效 —— 页面还在显示"下一步"，
 * 但显示的是兜底文案，而开发者会以为自己看的是精确诊断。
 * 这里用**真实的报错原文**做回归，措辞变了就会红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { diagnose } = require('../miniprogram/utils/api.js');

test('云开发未开通：识别 -601034 并指向开通步骤', () => {
  // 这是本项目真实遇到过的原文（2026-10-13，微信开发者工具 Stable 2.02.2608080）
  const raw =
    'cloud.callFunction:fail Error: errCode: -601034 | errMsg: 没有权限，请先开通云开发或者云托管 ' +
    '(callId: 1791862256182-0.34021957201282804) (trace: 11:30:56 start->11:30:56 system error ' +
    '(Error: errCode: -601034 | errMsg: 没有权限，请先开通云开发或者云托管), abort)';

  const d = diagnose(raw);
  assert.match(d, /云开发尚未开通/);
  assert.match(d, /基本信息/, '必须提示"基本信息未填会挡住开通"这个真实前置条件');
});

test('云函数未部署：指向上传部署步骤', () => {
  const raw = 'cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found';
  const d = diagnose(raw);
  assert.match(d, /尚未部署/);
  assert.match(d, /上传并部署/);
});

test('环境不存在：指向 envId 配置', () => {
  const raw = 'Error: errCode: -601001 | errMsg: env check invalid, env not exists';
  const d = diagnose(raw);
  assert.match(d, /环境不存在|无权访问/);
  assert.match(d, /envId/);
});

test('超时：指向云函数超时配置', () => {
  const d = diagnose('Error: errCode: -504002 | errMsg: Invoking task timed out after 3 seconds');
  assert.match(d, /超时/);
});

test('未识别的报错：给兜底清单，且不假装知道原因', () => {
  const d = diagnose('some brand new unknown error');
  assert.match(d, /未能自动识别/);
  assert.match(d, /① 云开发环境未创建/);
});

test('空输入不抛异常', () => {
  assert.ok(diagnose(undefined).length > 0);
  assert.ok(diagnose('').length > 0);
  assert.ok(diagnose(null).length > 0);
});

test('请求ID：同一逻辑操作可复用，不同操作不重复', () => {
  const { newRequestId } = require('../miniprogram/utils/api.js');
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b, '每次生成都应该是新值');
  assert.ok(a.length > 8);
});
