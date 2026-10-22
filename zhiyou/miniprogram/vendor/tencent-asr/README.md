# 腾讯云官方小程序 ASR SDK

来源：[腾讯云官方直接引入教程](https://cloud.tencent.com/document/product/1093/76151) 所链接的 [asr.min.js](https://asr-miniprogram-1256237915.cos.ap-shanghai.myqcloud.com/asr.min.js)。下载日期：2026-10-16；原始文件 17526 字节，SHA-256：`34b9dc835aed2556ecd76102a45575697194239eb5c70318b2d5517b84fa6d7c`。SDK 内置请求头版本为 `miniProgram-plugin-2.2.6`。原始文件没有许可证头；使用与更新应遵循腾讯云服务及 SDK 的适用条款。

本地只做模块包装：移除 `SpeechRecognizer`、`getRecorderSpeechRecognizer` 两处声明前的 `export`；整体包在 `module.exports = function createTencentAsr(wx) { ...; return { SpeechRecognizer, getRecorderSpeechRecognizer }; };` 中。这样微信小程序可用 CommonJS 引入，测试可注入独立微信 API；SDK 内部保持原样。不要把打包后的文件冒充原始文件计算上面的哈希。

业务入口为 `miniprogram/utils/realtime-speech.js`：使用官方 `SpeechRecognizer(false)`，关闭 SDK 调试日志；将实例的 `getUrl` 替换为读取 `speech.session` 已签名 URL 的函数。小程序不提供 SecretKey、不执行 SDK 默认的本地签名或 `/server_time` 请求。录音仍由现有原生录音管理器控制，收到服务鉴权确认后才开始；保留分片节奏、取消清理、完整最终结果校验及脱敏诊断。

外层适配器补充 SDK 未报告的连接关闭、发送失败、消息格式校验和启动取消检查。没有使用插件，也没有调用 SDK 自带的录音封装。两个输入框共用同一个业务适配器。直接引入仍需要配置 socket 合法域名 `wss://asr.cloud.tencent.com`。
