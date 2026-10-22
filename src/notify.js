function render(value, variables) {
  if (typeof value === 'string') return value.replace(/\{\{(title|body|date|status)\}\}/g, (_, key) => variables[key]);
  if (Array.isArray(value)) return value.map(item => render(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, variables)]));
  return value;
}

export function message(report) {
  const states = { signed: '已完成', claimed: '已领取', already_signed: '今日已签到', already_claimed: '此前已领取' };
  const change = n => n >= 0 ? `+${n}` : String(n);
  const lines = [`日期：${report.date}（北京时间）`, `执行：${report.attempts === 1 ? '首次' : `${report.retryMinutes ?? 30} 分钟后补试`}；${report.ok ? '全部成功' : '存在失败或异常'}`];
  for (const step of report.steps) {
    const claimedGrowth = step.ok && step.state === 'claimed' && step.delta != null ? `，实得成长值 ${change(step.delta)}` : '';
    lines.push(`${step.ok ? '✅' : '❌'} ${step.label}：${states[step.state] || '未确认完成'}${claimedGrowth}`);
    if (step.before != null) lines.push(`  成长值：${step.before} → ${step.after ?? '查询失败'}${step.delta != null ? `（${change(step.delta)}）` : ''}`);
    if (step.previous) {
      const p = step.previous;
      lines.push(`  首次尝试：${p.before} → ${p.after ?? '未知'}${p.delta != null ? `（${change(p.delta)}）` : ''}；${p.message || states[p.state] || '结果未知'}`);
    }
    if (step.message) lines.push(`  原因：${step.message}`);
  }
  const info = report.awards;
  if (info) {
    lines.push(`本周期累计签到：${info.signinDays} 天`);
    lines.push(info.nextDay == null ? '累计奖励：本周期已全部领取' : `下一档累计 ${info.nextDay} 天奖励：${info.remainingDays ? `还需签到 ${info.remainingDays} 天` : '已达标，待领取'}`);
  }
  if (report.finalGrowth != null) lines.push(`当前成长值：${report.finalGrowth}`);
  if (report.initialGrowth != null && report.finalGrowth != null) lines.push(`本轮余额变化：${report.initialGrowth} → ${report.finalGrowth}（${change(report.finalGrowth - report.initialGrowth)}）`);
  for (const error of report.errors || []) lines.push(`❌ ${error}`);
  return { title: `百度网盘签到${report.ok ? '成功' : '异常'} · ${report.date}`, body: lines.join('\n'), date: report.date, status: report.ok ? 'success' : 'failure' };
}

export async function notify(env, report, fetcher = fetch) {
  const raw = report.ok ? env.PUSH_SUCCESS : env.PUSH_FAILURE;
  if (!raw) return { state: 'disabled' };
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('推送配置不是有效 JSON'); }
  if (!config.url || !config.url.startsWith('https://')) throw new Error('推送需要 HTTPS URL');
  const variables = message(report);
  for (const key of Object.keys(variables)) {
    if (config.escape === 'telegram-markdown-v2') {
      variables[key] = variables[key].replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    } else if (config.escape === 'html') {
      variables[key] = variables[key].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    // MoePush 的模板插值未转义反斜线；先加倍以穿过其 JSON.parse。
    if (config.doubleBackslash) variables[key] = variables[key].replace(/\\/g, '\\\\');
  }
  let response;
  try {
    const method = (config.method || 'POST').toUpperCase();
    response = await fetcher(config.url, {
      method,
      headers: render({ 'Content-Type': 'application/json', ...config.headers }, variables),
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(render(config.body ?? { title: '{{title}}', body: '{{body}}' }, variables)) }),
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('推送网络失败'); }
  if (!response.ok) throw new Error(`推送 HTTP ${response.status}`);
  // 可配置服务商业务码；不把 HTTP 200 一律视作业务成功。
  if (config.successField) {
    let data;
    try { data = await response.json(); } catch { throw new Error('推送响应不是 JSON'); }
    const value = config.successField.split('.').reduce((obj, key) => obj?.[key], data);
    if (value !== config.successValue) throw new Error('推送服务业务状态未成功');
  }
  return { state: 'sent', time: new Date().toISOString() };
}
