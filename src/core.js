const ORIGIN = 'https://pan.baidu.com';
const TASK_FROM = 'task_sys_beginner task_sys_daily task_sys_space task_sys_ai task_sys_function task_sys_growth';

export function options(env) {
  const retry = Number(env.RETRY_MINUTES ?? 30);
  const timeout = Number(env.TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(retry) || retry < 1 || retry > 1440) throw new Error('RETRY_MINUTES 应为 1–1440');
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) throw new Error('TIMEOUT_MS 应为 100–60000');
  return {
    cookie: env.BAIDU_COOKIE || '',
    cuid: env.BAIDU_CUID || cookieField(env.BAIDU_COOKIE, 'BAIDUCUID'),
    retryMinutes: retry,
    timeout,
    pc: env.ENABLE_PC !== 'false',
    app: env.ENABLE_APP !== 'false',
    awards: env.ENABLE_AWARDS !== 'false',
    headers: env.BAIDU_HEADERS ? JSON.parse(env.BAIDU_HEADERS) : {},
  };
}

export function cookieField(cookie = '', name) {
  return cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

export function beijingDate(time = Date.now()) {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10);
}

export class BaiduClient {
  constructor(config, fetcher = fetch) {
    this.config = config;
    // Workers 的原生 fetch 不接受类实例作为 this，必须通过独立函数调用。
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async call(path, params, allowed = [0]) {
    if (!this.config.cookie || /[\r\n]/.test(this.config.cookie)) throw new Error('Cookie 未配置或格式错误');
    const url = new URL(path, ORIGIN);
    url.search = new URLSearchParams(params).toString();
    let response;
    let data;
    try {
      response = await this.fetcher(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: `${ORIGIN}/operation/activitys/taskSystem/growth`,
          'X-Requested-With': 'XMLHttpRequest',
          ...this.config.headers, Cookie: this.config.cookie,
        },
        redirect: 'manual', signal: AbortSignal.timeout(this.config.timeout),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
    } catch {
      throw new Error(response && response.status !== 200 ? `百度接口 HTTP ${response.status}` : '百度网络超时或响应不是 JSON');
    }
    const code = data?.errno ?? data?.error_code;
    if (!Number.isInteger(code) || !allowed.includes(code)) {
      throw new Error(Number.isInteger(code) ? `百度业务失败（${code}）` : '百度响应缺少业务状态码');
    }
    return data;
  }

  mobile(path, params = {}) {
    if (!this.config.cuid || /[\r\n]/.test(this.config.cuid)) throw new Error('缺少有效 cuid：请配置 BAIDU_CUID 或包含 BAIDUCUID 的 Cookie');
    return this.call(`/coins/taskcenter/${path}`, { cuid: this.config.cuid, ...params });
  }

  async growth() {
    const data = await this.call('/rest/2.0/membership/user', { method: 'query' });
    const value = data?.level_info?.current_value;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('成长值响应缺少有效数值');
    return value;
  }

  async pcSign() {
    const data = await this.call('/rest/2.0/membership/level', { method: 'signin' }, [0, 421001]);
    if (data.error_code === 421001) {
      if (data.error_msg !== 'repeat signin') throw new Error('PC 重复签到状态无法确认');
      return 'already_signed';
    }
    return 'signed';
  }

  async appSign() {
    const state = (await this.mobile('signinlist')).data;
    if (state?.signed_today === 1) return 'already_signed';
    if (state?.signed_today !== 0) throw new Error('App 签到状态无法确认');
    const tasks = (await this.mobile('tasklist', { task_from: TASK_FROM })).result?.list;
    const task = Array.isArray(tasks) && tasks.find(t => String(t.task_type) === '166');
    const keys = ['task_id', 'task_id_str', 'task_from'];
    if (!task || keys.some(k => task[k] == null || task[k] === '')) throw new Error('未找到有效 App 签到任务');
    await this.mobile('signin', Object.fromEntries(keys.map(k => [k, task[k]])));
    if ((await this.mobile('signinlist')).data?.signed_today !== 1) throw new Error('App 请求成功，但签到状态未确认');
    return 'signed';
  }

  async awards() {
    const state = (await this.mobile('signinlist')).data;
    if (!Number.isInteger(state?.signin_days) || !Array.isArray(state?.reward_list)) throw new Error('累计奖励状态格式错误');
    const tiers = state.reward_list.map(t => {
      if (!Number.isInteger(t?.day) || t.day < 1 || !Number.isInteger(t.received) || t.received < 0 || !Array.isArray(t.prize) || t.prize.length === 0) {
        throw new Error('累计奖励档位格式错误');
      }
      return { day: t.day, received: t.received, count: t.prize.length };
    }).sort((a, b) => a.day - b.day);
    const next = tiers.find(t => t.received < t.count);
    return {
      signinDays: state.signin_days,
      nextDay: next?.day ?? null,
      remainingDays: next ? Math.max(0, next.day - state.signin_days) : 0,
      claimable: tiers.filter(t => state.signin_days >= t.day && t.received < t.count),
      tiers,
    };
  }

  async claim(day) {
    await this.mobile('signinaward', { day });
    const info = await this.awards();
    const tier = info.tiers.find(t => t.day === day);
    if (!tier || tier.received < tier.count) throw new Error('累计奖励请求成功，但尚未确认该档全部领取');
    return 'claimed';
  }
}

// 每步落盘，补试保留已完成项目及其首次测量数据。
export async function runAttempt(report, client, config, save = async () => {}) {
  report.attempts += 1;
  report.retryMinutes = config.retryMinutes;
  report.time = new Date().toISOString();
  report.errors = [];
  async function measured(id, label, action) {
    const old = report.steps.find(s => s.id === id);
    if (old?.ok) return;
    const step = { id, label, ok: false, attempt: report.attempts };
    if (old) report.steps[report.steps.indexOf(old)] = step;
    else report.steps.push(step);
    try {
      step.before = await client.growth();
      report.initialGrowth ??= step.before;
      step.phase = 'before_operation';
      await save(report);
      step.state = await action();
      step.phase = 'operation_confirmed';
      await save(report);
    } catch (error) {
      step.message = error.message;
    }
    // 即使操作抛错也读取余额：请求可能已经到达服务端。
    if (step.before != null) {
      try {
        step.after = await client.growth();
        step.delta = step.after - step.before;
        report.finalGrowth = step.after;
      } catch (error) { step.message = [step.message, error.message].filter(Boolean).join('；'); }
    }
    step.ok = !!step.state && step.after != null && !step.message;
    // 补试若发现已完成，不把跨 30 分钟的余额差归入该操作。
    if (old && old.before != null) step.previous = { before: old.before, after: old.after, delta: old.delta, state: old.state, message: old.message };
    await save(report);
  }

  if (config.pc) await measured('pc', 'PC 签到', () => client.pcSign());
  if (config.app) await measured('app', 'App 签到', () => client.appSign());
  if (config.awards || config.app) {
    try {
      report.awards = await client.awards();
      if (config.awards) {
        // 遍历服务端动态档位，无本地固定档位上限。
        for (const tier of report.awards.claimable) {
          await measured(`award-${tier.day}`, `累计 ${tier.day} 天奖励`, async () => {
            const latest = await client.awards();
            if (!latest.claimable.some(t => t.day === tier.day)) return 'already_claimed';
            return client.claim(tier.day);
          });
        }
        report.awards = await client.awards();
        if (report.awards.claimable.length) report.errors.push('仍有已达标奖励未领取');
      }
    } catch (error) { report.errors.push(error.message); }
  }
  if (!config.pc && !config.app && !config.awards) report.errors.push('全部任务均已关闭');
  report.ok = report.steps.every(s => s.ok) && report.errors.length === 0;
  await save(report);
  return report;
}

export async function readStatus(client, config) {
  return { growth: await client.growth(), awards: config.app || config.awards ? await client.awards() : null };
}
