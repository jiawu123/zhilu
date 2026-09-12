# 离线接口样例

所有样例只用于开发／测试，不代表已经执行真实研究。PROPOSED 表示本次要实现的新包装，不是旧入口已支持的接口。

- 01–03 沿用此前对接资料中的目标、Draft 与 Controller 请求样例。
- 04 是本次 Python research 输入建议格式。
- 05–06 是手工构造的 compiler 结构样例，来源 URL、作者、来源 ID 和文本均不得作为真实知乎证据使用。
- 07 是独立 HTTP 证据接口的 body；它不含 goal/context，由 Server 从项目读取。

05 在引文之前刻意放了 emoji 和 CRLF。quote_start/end 采用 Python Unicode code point 索引，结束位置不包含在内。Node 不能直接用这些下标做普通字符串 slice。

本资料只检查了 JSON 可解析性、样例索引与文档一致性。Codex 仍需用当前 Python 与 TypeScript 的真实校验函数重新验证，不得用本文件替代测试报告。
