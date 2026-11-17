'use strict';

/**
 * 内容安全的**策略表 —— 单一事实来源**。
 *
 * 哪一类内容、在哪个动作、哪个字段、往哪个方向过检，只写在这里。
 *
 * 为什么必须集中：如果让每个动作自己 `if (check(text))`，会出现三种漂移，
 * 而且三种都不会报错：
 *   ① 加了新接口忘了接（表现是"这个入口怎么不拦"）；
 *   ② 同一个字段在 A 接口拦、B 接口放（表现是"绕过路径"）；
 *   ③ 有人为了跑通测试把阈值调松，没人知道。
 * 这张表可以被测试整体断言（`test/content-safety.test.js` 逐个 action 核对），
 * 漏接会变成一条明确的失败，而不是一个需要靠人肉巡检的隐患。
 */

const { GROUPS } = require('./lexicon');

/**
 * 微信内容安全接口的 `scene` 取值。**数字是微信定义的**，不能自拟，
 * 传错会让 `msgSecCheck` 直接报参数错误。
 *
 * 只列本项目实际用到的几个；1 资料 / 2 评论 / 3 论坛 / 4 社交日志。
 */
const SCENE = {
  PROFILE: 1,
  COMMENT: 2,
  FORUM: 3,
  SOCIAL_LOG: 4,
};

/** 聊天文本：熟人小圈子里也不允许出现站外导流与人身威胁 */
const CHAT_GROUPS = [GROUPS.CONTACT, GROUPS.LINK, GROUPS.SOLICIT, GROUPS.THREAT, GROUPS.CONTROL];
/**
 * 昵称：挡联系方式、链接、导流话术与不可见字符。
 *
 * 昵称会出现在**每一条**聊天气泡旁、以及地图与队伍列表上，
 * 是这个产品里曝光量最大的位置 —— 不挡导流等于把广告位免费送出去。
 *
 * 不可见字符也必须挡：`小明` 与 `小明\u200B` 在界面上长得一模一样，
 * 后者可以冒充别人说话。这不是内容合规问题，是**身份可信**问题。
 */
const NAME_GROUPS = [GROUPS.CONTACT, GROUPS.LINK, GROUPS.SOLICIT, GROUPS.CONTROL];

/**
 * 送给大模型之前要过检的文本。
 *
 * 助手的问题会被拼进提示词。除了内容风险，这里还有一层**注入风险**：
 * 手机号、链接、二维码话术出现在提示词里时，几乎总是"诱导模型把站外信息带出来"。
 * 在进入模型之前挡掉，比让模型自己判断可靠得多。
 */
const MODEL_GROUPS = [GROUPS.CONTACT, GROUPS.LINK, GROUPS.SOLICIT, GROUPS.THREAT, GROUPS.CONTROL];

/**
 * 输入策略：`{action, field, scene, groups, note}`。
 *
 * `field` 是 `payload` 上的**顶层字段名**。刻意不支持嵌套路径：
 * 嵌套路径要写解析器，而解析器本身会成为绕过点（如 `a.b` 与 `a['b']`）。
 */
const INPUT_POLICY = [
  { action: 'chat.send', field: 'text', scene: SCENE.COMMENT, groups: CHAT_GROUPS, kind: 'chat' },
  { action: 'user.updateProfile', field: 'nickname', scene: SCENE.PROFILE, groups: NAME_GROUPS, kind: 'nickname' },
  { action: 'guide.ask', field: 'text', scene: SCENE.SOCIAL_LOG, groups: MODEL_GROUPS, kind: 'model' },
  { action: 'intent.parse', field: 'text', scene: SCENE.SOCIAL_LOG, groups: MODEL_GROUPS, kind: 'model' },
  { action: 'trip.adjustText', field: 'text', scene: SCENE.SOCIAL_LOG, groups: MODEL_GROUPS, kind: 'model' },
];

/**
 * 图片策略：动作层在**已经拿到字节**之后调用（`ctx.safety.checkImage`）。
 *
 * 为什么不在入口统一做：图片走的是 base64 或云存储 fileID 两种形态，
 * 入口不知道该怎么取字节；而动作层在 `decodeImage` 之后手里**就是**字节，
 * 放在那里既省一次解析，也避免"为了检查再下载一遍"。
 */
const IMAGE_POLICY = [
  { action: 'guide.ask', field: 'imageBase64', kind: 'guide_photo' },
  { action: 'guide.countPeople', field: 'imageBase64', kind: 'guide_photo' },
];

/**
 * 输出策略：模型生成、会直接显示给用户的文本。
 *
 * 这里**只列模型侧**。聊天与昵称是用户自己写的，已经在输入侧拦过；
 * 再拦一次不会更安全，只会让"我发的消息怎么变了"变得无法解释。
 *
 * 三个字段集合的区别是**要不要花云配额**：
 *   · `modelFields` —— 模型生成的主文案（`answer`）。送云检测；
 *   · `localFields` —— 我们自己拼的提示与线索（`notices`/`clues`）。
 *     它们是固定模板加工出来的，只需要本地脱敏，送云纯属浪费配额；
 *   · `nested` —— 正式知识库原文与商户/来源字段做本地脱敏；
 *     evidence来自联网模型整理时仍送云检测，由output.js按knowledgeOrigin区分。
 * 把这三类混在一起"一律送云"，会让一次助手问答产生 5—10 次云调用，
 * 而多出来的那些调用**一个字节的模型输出都没看**。
 */
const OUTPUT_POLICY = [
  {
    action: 'guide.ask',
    /** 主文案：被判定不可信时整条替换，其余字段只在必要时脱敏 */
    primary: 'answer',
    modelFields: ['answer'],
    localFields: ['notices', 'clues'],
    nested: [{ field: 'evidence', key: 'text' }, { field: 'merchants', key: 'name' }, { field: 'merchants', key: 'address' }, { field: 'sources', key: 'title' }, { field: 'sources', key: 'publisher' }],
    kind: 'model_output',
  },
];

/**
 * 用户可见的拒绝文案。
 *
 * 为什么按分组分开写：用户看到"内容不合规"只会反复重试；
 * 看到"不要发手机号/链接"才知道该怎么改。**能改的提示才是提示。**
 */
const MESSAGES = {
  [GROUPS.CONTACT]: '内容里包含手机号、微信号等联系方式，请删除后再发送',
  [GROUPS.LINK]: '内容里包含站外链接或二维码，请删除后再发送',
  [GROUPS.SOLICIT]: '内容里包含拉群、刷单等导流信息，请删除后再发送',
  [GROUPS.THREAT]: '内容里包含人身威胁，请修改后再发送',
  [GROUPS.CONTROL]: '内容里包含不可见字符，请删除后重新输入',
  unknown: '内容未通过安全检查，请修改后再发送',
};

/** 按命中分组给出**可执行**的提示；多组命中时只报最先命中的那一组 */
function rejectMessage(groups) {
  for (const group of [GROUPS.THREAT, GROUPS.CONTROL, GROUPS.CONTACT, GROUPS.LINK, GROUPS.SOLICIT]) {
    if ((groups || []).includes(group)) return MESSAGES[group];
  }
  return MESSAGES.unknown;
}

/** 查这个动作有没有输入策略（入口只对命中的动作做检查，其余一律不碰负载） */
function inputEntries(action) {
  return INPUT_POLICY.filter((entry) => entry.action === action);
}
function imageEntry(action) {
  return IMAGE_POLICY.find((entry) => entry.action === action) || null;
}
function outputEntry(action) {
  return OUTPUT_POLICY.find((entry) => entry.action === action) || null;
}

module.exports = {
  SCENE,
  GROUPS,
  CHAT_GROUPS,
  NAME_GROUPS,
  MODEL_GROUPS,
  INPUT_POLICY,
  IMAGE_POLICY,
  OUTPUT_POLICY,
  MESSAGES,
  rejectMessage,
  inputEntries,
  imageEntry,
  outputEntry,
};
