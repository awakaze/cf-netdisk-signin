import test from 'node:test';
import assert from 'node:assert/strict';
import { BaiduClient, options, runAttempt, beijingDate } from '../src/core.js';
import { message, notify } from '../src/notify.js';
import worker, { SignInCoordinator } from '../src/worker.js';

const config = options({ BAIDU_COOKIE: 'BDUSS=secret; BAIDUCUID=device' });
const report = () => ({ date: '2026-10-22', attempts: 0, steps: [], errors: [] });
const rewards = { signinDays: 14, nextDay: 15, remainingDays: 1, claimable: [], tiers: [] };
const client = () => ({ growth: async () => 100, pcSign: async () => 'signed', appSign: async () => 'signed', awards: async () => rewards });

test('可选项默认、Cookie 派生设备标识、北京时间跨日', () => {
  assert.equal(config.cuid, 'device');
  assert.equal(options({}).retryMinutes, 30);
  assert.equal(beijingDate(Date.parse('2026-10-22T16:00:00Z')), '2026-10-23');
});

test('HTTP 200 的业务失败、重定向、缺失码均不能通过', async () => {
  for (const response of [Response.json({ errno: 8001 }), Response.json({}), new Response('', { status: 302 })]) {
    const api = new BaiduClient(config, async () => response);
    await assert.rejects(api.growth());
  }
});

test('请求只向百度发送账号和自定义设备请求头，且拒绝自动跟随重定向', async () => {
  const api = new BaiduClient({ ...config, headers: { 'X-Test': 'device-env' } }, async (url, init) => {
    assert.equal(url.origin, 'https://pan.baidu.com');
    assert.equal(url.searchParams.get('cuid'), 'device');
    assert.equal(init.headers.Cookie, config.cookie);
    assert.equal(init.headers['X-Test'], 'device-env');
    assert.equal(init.redirect, 'manual');
    return Response.json({ errno: 0, data: {} });
  });
  await api.mobile('signinlist');
});

test('兼容 Workers 原生 fetch 的接收者限制', async () => {
  const api = new BaiduClient(config, async function () {
    assert.equal(this, undefined, '不得把 BaiduClient 实例作为 fetch 的 this');
    return Response.json({ errno: 0, level_info: { current_value: 100 } });
  });
  assert.equal(await api.growth(), 100);
});

test('成长值查询失败则不执行对应写入，另一端仍有机会运行', async () => {
  let writes = 0;
  const api = { ...client(), growth: async () => { throw new Error('查询失败'); }, pcSign: async () => { writes++; } };
  const r = await runAttempt(report(), api, config);
  assert.equal(writes, 0);
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 2);
});

test('双端和每个累计档位均单独前后测量，动态奖励清单不写死', async () => {
  let balance = 100;
  let tiers = [{ day: 15, count: 2, received: 0 }, { day: 30, count: 2, received: 0 }];
  const events = [];
  const api = {
    growth: async () => { events.push('growth'); return balance; },
    pcSign: async () => { events.push('pc'); balance += 4; return 'signed'; },
    appSign: async () => { events.push('app'); balance += 13; return 'signed'; },
    awards: async () => ({ ...rewards, claimable: tiers.filter(t => t.received < 2), tiers }),
    claim: async day => { events.push(`award-${day}`); balance += day; tiers = tiers.map(t => t.day === day ? { ...t, received: 2 } : t); return 'claimed'; },
  };
  const r = await runAttempt(report(), api, config);
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map(s => s.delta), [4, 13, 15, 30]);
  assert.deepEqual(events, ['growth', 'pc', 'growth', 'growth', 'app', 'growth', 'growth', 'award-15', 'growth', 'growth', 'award-30', 'growth']);
});

test('首次部分失败不丢失成功项目及成长值，补试只跑未完成步骤', async () => {
  let pcCalls = 0;
  let appCalls = 0;
  let balance = 100;
  const api = {
    ...client(), growth: async () => balance,
    pcSign: async () => { pcCalls++; balance += 4; return 'signed'; },
    appSign: async () => { if (++appCalls === 1) throw new Error('失败'); balance += 13; return 'signed'; },
  };
  const r = await runAttempt(report(), api, config);
  assert.equal(r.ok, false);
  balance += 30; // 补试等待期间服务端自动成长。
  await runAttempt(r, api, config);
  assert.equal(r.ok, true);
  assert.equal(pcCalls, 1);
  assert.equal(appCalls, 2);
  assert.deepEqual(r.steps.map(s => s.delta), [4, 13]);
  assert.equal(r.finalGrowth, 147);
  assert.match(message(r).body, /还需签到 1 天/);
});

test('写入已被服务端执行但网络报错：仍测量后值，并补试复核状态', async () => {
  let balance = 100;
  let signed = false;
  const api = { ...client(), growth: async () => balance, pcSign: async () => {
    if (signed) return 'already_signed';
    signed = true; balance += 5; throw new Error('响应丢失');
  } };
  const cfg = { ...config, app: false, awards: false };
  const r = await runAttempt(report(), api, cfg);
  assert.equal(r.steps[0].delta, 5);
  assert.equal(r.ok, false);
  await runAttempt(r, api, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.steps[0].previous.delta, 5);
});

test('累计奖励部分 received 不能误判全部领取', async () => {
  const api = new BaiduClient(config, async url => url.pathname.endsWith('signinaward')
    ? Response.json({ errno: 0 })
    : Response.json({ errno: 0, data: { signin_days: 15, reward_list: [{ day: 15, received: 1, prize: [{}, {}] }] } }));
  await assert.rejects(api.claim(15), /全部领取/);
});

test('成功失败推送隔离、支持 JSON 嵌套模板且正文正确转义', async () => {
  const r = { ...report(), ok: true, attempts: 1, awards: rewards };
  const env = {
    PUSH_SUCCESS: JSON.stringify({ url: 'https://push.example/success', body: { title: '{{title}}', content: '{{body}}', extra: { status: '{{status}}' } } }),
    PUSH_FAILURE: JSON.stringify({ url: 'https://push.example/failure' }),
  };
  let calls = [];
  const fetcher = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return Response.json({ ok: true }); };
  await notify(env, r, fetcher);
  r.ok = false;
  await notify(env, r, fetcher);
  assert.equal(calls[0][0], 'https://push.example/success');
  assert.equal(calls[0][1].extra.status, 'success');
  assert.match(calls[0][1].content, /还需签到 1 天/);
  assert.equal(calls[1][0], 'https://push.example/failure');
  assert.match(calls[1][1].body, /存在失败/);
});

test('推送失败输出不泄漏 URL 或密钥；业务码可配置', async () => {
  const env = { PUSH_SUCCESS: JSON.stringify({ url: 'https://push.example/secret', successField: 'code', successValue: 0 }) };
  const r = { ...report(), ok: true, attempts: 1 };
  await assert.rejects(notify(env, r, async () => { throw new Error('https://push.example/secret'); }), { message: '推送网络失败' });
  await assert.rejects(notify(env, r, async () => Response.json({ code: 1 })), /业务状态/);
});

test('累计奖励通知显示实际领取成长值，领取后显示下一档，不再提示自动成长', () => {
  const r = { ...report(), ok: true, attempts: 1, initialGrowth: 100, finalGrowth: 120,
    steps: [{ id: 'award-15', label: '累计 15 天奖励', ok: true, state: 'claimed', before: 100, after: 120, delta: 20 }],
    awards: { signinDays: 15, nextDay: 30, remainingDays: 15 } };
  const body = message(r).body;
  assert.match(body, /累计 15 天奖励：已领取，实得成长值 \+20/);
  assert.match(body, /下一档累计 30 天奖励：还需签到 15 天/);
  assert.match(body, /本轮余额变化：100 → 120（\+20）/);
  assert.doesNotMatch(body, /自动成长/);
});

test('Telegram MarkdownV2 保留字符按渠道转义，普通渠道保持原文', async () => {
  const r = { ...report(), ok: true, attempts: 1, steps: [{ label: 'PC 签到', ok: true, state: 'signed', before: 100, after: 104, delta: 4 }] };
  const env = { PUSH_SUCCESS: JSON.stringify({ url: 'https://push.example/tg', escape: 'telegram-markdown-v2' }) };
  let payload;
  await notify(env, r, async (url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({});
  });
  assert.ok(payload.title.includes('2026\\-10\\-22'));
  assert.ok(payload.body.includes('（\\+4）'));
});

test('MoePush 插值不转义反斜线时仍可解析完整 MarkdownV2 正文', async () => {
  const r = { ...report(), ok: true, attempts: 1 };
  const env = { PUSH_SUCCESS: JSON.stringify({ url: 'https://push.example/tg', escape: 'telegram-markdown-v2', doubleBackslash: true }) };
  let payload;
  await notify(env, r, async (url, init) => { payload = JSON.parse(init.body); return Response.json({}); });
  // 复现 MoePush safeInterpolate 的字符串处理顺序（不转义反斜线）。
  const interpolate = value => value.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/"/g, '\\"');
  const forwarded = JSON.parse('{"text":"' + interpolate(payload.title) + '\\n' + interpolate(payload.body) + '"}');
  assert.ok(forwarded.text.includes('2026\\-10\\-22'));
  assert.ok(forwarded.text.includes('\n日期：'));
});

function coordinator(env = {}) {
  const data = new Map();
  const storage = {
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)); },
    setAlarm: async value => { data.set('alarm', value); },
    deleteAlarm: async () => { data.delete('alarm'); },
  };
  return { object: new SignInCoordinator({ storage }, env), storage, data };
}

test('管理接口无令牌保持关闭，健康检查不暴露报告', async () => {
  assert.equal((await worker.fetch(new Request('https://x/run', { method: 'POST' }), {})).status, 401);
  assert.equal((await worker.fetch(new Request('https://x/health'), {})).status, 200);
});

test('同日重复及并发调用不重复执行', async () => {
  const { object } = coordinator();
  let executions = 0;
  object.execute = async r => { executions++; r.phase = 'complete'; await object.ctx.storage.put('report', r); };
  const req = () => new Request('https://internal/run', { method: 'POST' });
  await Promise.all([object.fetch(req()), object.fetch(req())]);
  assert.equal(executions, 1);
});

test('首次失败不推送，30分钟后只补试一次，最终发异常渠道', async () => {
  const { object, data } = coordinator();
  const r = report(); r.date = beijingDate();
  await object.execute(r, options({})); // 无 Cookie 的真实 client 本地拒绝，不会联网。
  assert.equal(r.phase, 'waiting_retry');
  assert.equal(r.notification, undefined);
  assert.ok(data.get('alarm') - Date.now() > 29 * 60000);
  await object.alarm();
  const final = data.get('report');
  assert.equal(final.attempts, 2);
  assert.equal(final.phase, 'complete');
  assert.equal(final.notification.state, 'disabled');
  assert.equal(data.has('alarm'), false);
});

test('隔天收到旧 alarm 不执行旧任务', async () => {
  const { object, storage, data } = coordinator();
  await storage.put('report', { ...report(), date: '2000-01-01', phase: 'waiting_retry' });
  object.execute = async () => { throw new Error('不应执行'); };
  await object.alarm();
  assert.equal(data.has('alarm'), false);
});
