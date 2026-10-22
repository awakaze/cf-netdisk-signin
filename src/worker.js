import { BaiduClient, beijingDate, options, readStatus, runAttempt } from './core.js';
import { notify } from './notify.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export class SignInCoordinator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }

  // 对请求及 alarm 串行处理；异步网络等待期间也不允许第二个任务抢入。
  async exclusive(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }

  async fetch(request) {
    return this.exclusive(async () => {
      const path = new URL(request.url).pathname;
      const config = options(this.env);
      if (path === '/status') {
        const client = new BaiduClient(config);
        try { return json(await readStatus(client, config)); }
        catch (error) { return json({ ok: false, error: error.message }, 502); }
      }
      if (path === '/report') return json(await this.ctx.storage.get('report') ?? { state: 'not_run' });
      if (path === '/notify' && request.method === 'POST') {
        const report = await this.ctx.storage.get('report');
        if (!report || report.phase !== 'complete') return json({ error: '没有可补发的已完成报告' }, 409);
        if (report.notification?.state === 'failed') await this.deliver(report);
        return json(report);
      }
      if (path !== '/run' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const date = beijingDate();
      let report = await this.ctx.storage.get('report');
      if (report?.date === date) return json(report); // 不通过 HTTP 绕过当日去重或提前补试。
      report = { date, attempts: 0, steps: [], errors: [], ok: false, phase: 'running' };
      await this.ctx.storage.put('report', report);
      await this.execute(report, config);
      return json(report);
    });
  }

  async execute(report, config) {
    // 先安排恢复 alarm。若运行中断，仍能恢复；绝不在隔天自动补领旧日期任务。
    const due = Date.now() + config.retryMinutes * 60000;
    await this.ctx.storage.setAlarm(due);
    report.retryAt = new Date(due).toISOString();
    try {
      await runAttempt(report, new BaiduClient(config), config, r => this.ctx.storage.put('report', r));
    } catch {
      report.ok = false;
      report.errors.push('执行出现内部异常，请检查配置');
    }
    if (report.ok || report.attempts >= 2) {
      report.phase = 'complete';
      await this.ctx.storage.put('report', report);
      await this.deliver(report);
    } else {
      report.phase = 'waiting_retry';
      await this.ctx.storage.put('report', report);
    }
  }

  async deliver(report) {
    if (report.notification?.state === 'sent' || report.notification?.state === 'disabled') {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const tries = (report.notification?.attempts || 0) + 1;
    try {
      report.notification = { ...await notify(this.env, report), attempts: tries };
      await this.ctx.storage.deleteAlarm();
      delete report.retryAt;
    } catch (error) {
      report.notification = { state: 'failed', message: error.message, attempts: tries };
      // 推送失败仅补发推送，不重新执行签到；最多补发一次。
      if (tries < 2) await this.ctx.storage.setAlarm(Date.now() + options(this.env).retryMinutes * 60000);
      else await this.ctx.storage.deleteAlarm();
    }
    await this.ctx.storage.put('report', report);
  }

  async alarm() {
    return this.exclusive(async () => {
      const report = await this.ctx.storage.get('report');
      if (!report || report.date !== beijingDate()) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (report.phase === 'complete') {
        await this.deliver(report);
      } else if (report.attempts < 2) {
        await this.execute(report, options(this.env));
      } else {
        report.ok = false;
        report.phase = 'complete';
        report.errors.push('补试中断，部分操作结果尚未确认');
        await this.deliver(report);
      }
    });
  }
}

export default {
  async scheduled(event, env, ctx) {
    const stub = env.SIGNIN.get(env.SIGNIN.idFromName('daily'));
    ctx.waitUntil(stub.fetch(new Request('https://internal/run', { method: 'POST' })).then(response => {
      if (!response.ok) throw new Error(`调度失败 HTTP ${response.status}`);
    }));
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ service: 'cf-netdisk-signin', ok: true });
    // 未设置管理令牌时关闭全部管理接口。
    if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
    if (!['/status', '/report', '/run', '/notify'].includes(path)) return json({ error: 'Not found' }, 404);
    const isWrite = path === '/run' || path === '/notify';
    if ((isWrite && request.method !== 'POST') || (!isWrite && request.method !== 'GET')) return json({ error: 'Method not allowed' }, 405);
    try {
      const stub = env.SIGNIN.get(env.SIGNIN.idFromName('daily'));
      return await stub.fetch(new Request(`https://internal${path}`, { method: request.method }));
    } catch { return json({ error: '执行失败，请检查配置或稍后重试' }, 500); }
  },
};
