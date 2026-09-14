export function userFacingError(message: string): string {
  if (message.includes("不能覆盖用户字段") || message.includes("已被用户锁定")) return "本次调整涉及已手动设置并保护的内容，尚未应用。请通过任务详情核对相关设置后重新提交。";
  if (/配置无效|尚未启用|未启用|真实研究未开启/.test(message)) return "当前服务尚未配置完整或尚未开启。已有内容已保留；请检查服务配置后重试，也可查看演示方案。";
  if (/Roadmapper|Python|Provider/.test(message)) return "研究或规划暂时未完成，已有内容已保留。请检查网络、授权和服务状态后重试。";
  return message;
}

export function ErrorNotice({ message, className = "research-error" }: { message: string; className?: string }) {
  const friendly = userFacingError(message);
  return <div className={className} role="alert"><p>{friendly}</p>{friendly !== message && <details><summary>查看技术详情</summary><p>{message}</p></details>}</div>;
}
