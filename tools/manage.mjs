import { readFile, mkdir, writeFile } from 'node:fs/promises';

// 私密配置不会作为命令行参数或日志输出。
const command = process.argv[2] || 'status';
const configPath = process.env.LOCAL_CONFIG || 'secrets.local.json';
const secrets = JSON.parse(await readFile(configPath, 'utf8'));
let deployment = {};
try { deployment = JSON.parse(await readFile('deployment.local.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('本地部署信息格式错误'); }
const base = process.env.WORKER_URL || deployment.url || 'http://localhost:8787';
if (!['health', 'status', 'report', 'run', 'notify'].includes(command)) throw new Error('用法：node tools/manage.mjs health|status|report|run|notify');
try {
  const response = await fetch(`${base}/${command}`, {
    method: command === 'run' || command === 'notify' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${secrets.ADMIN_TOKEN}` },
    signal: AbortSignal.timeout(180000),
  });
  const result = await response.json();
  await mkdir('captures', { recursive: true });
  await writeFile(`captures/${command}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ http: response.status, result }, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Worker 请求失败，未输出带凭据的原始异常');
  process.exitCode = 1;
}
