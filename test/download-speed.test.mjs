import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const cli = fileURLToPath(new URL('../download-speed.mjs', import.meta.url));
const count = 10;

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const execFileAsync = promisify(execFile);

async function run(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (!Number.isInteger(error.code) || error.killed || error.signal) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function report(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const match = result.stdout.match(/^Среднее время запроса: (\d+\.\d{2}) мс\r?\nВсего скачано: (\d+) байт\r?\nСкорость скачивания: (\d+\.\d{3}) МиБ\/с\r?\n$/u);
  assert.ok(match, `Неожиданный вывод: ${result.stdout}`);
  return { average: Number(match[1]), bytes: Number(match[2]), speed: Number(match[3]) };
}

function assertFailure(result) {
  assert.equal(result.code, 1, `Ожидалась ошибка: ${result.stdout}`);
  assert.ok(result.stderr.trim(), 'Ожидалось сообщение об ошибке');
  assert.equal(result.stdout, '');
}

test('десять последовательных GET полностью скачивают тела разного размера', async (t) => {
  const bodies = Array.from({ length: count }, (_, i) => Buffer.alloc(12_000 + i * 731, 65 + i));
  const durations = [];
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const methods = [];
  await withServer((req, res) => {
    const body = bodies[requests++];
    methods.push(req.method);
    active++;
    maxActive = Math.max(maxActive, active);
    const start = performance.now();
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      active--;
      durations.push(performance.now() - start);
    };
    res.once('finish', release);
    res.once('close', release);
    if (!body) { res.writeHead(500).end(); return; }
    // Отправка двух блоков без Content-Length проверяет получение всего chunked-тела.
    const split = Math.floor(body.length / 2);
    res.writeHead(200);
    res.write(body.subarray(0, split));
    setTimeout(() => res.end(body.subarray(split)), 35);
  }, async (base) => {
    const start = performance.now();
    const result = await run(base);
    const output = report(result);
    const elapsed = performance.now() - start;
    assert.equal(requests, count);
    assert.deepEqual(methods, Array(count).fill('GET'));
    assert.equal(maxActive, 1);
    assert.equal(output.bytes, bodies.reduce((sum, body) => sum + body.length, 0));
    const serverAverage = durations.reduce((sum, duration) => sum + duration, 0) / count;
    assert.ok(output.average >= serverAverage - 5, `Среднее ${output.average} мс меньше длительности передачи ${serverAverage} мс`);
    assert.ok(output.average <= elapsed / count + 0.01, 'Среднее превышает общее время процесса');
    // Учитываем округление времени до 0,01 мс и скорости до 0,001 МиБ/с.
    const numerator = output.bytes * 1000 / (1024 ** 2 * count);
    const lower = numerator / (output.average + 0.005);
    const upper = numerator / (output.average - 0.005);
    assert.ok(output.speed + 0.000501 >= lower && output.speed - 0.000501 <= upper,
      `Скорость ${output.speed} несовместима с объёмом и средним временем`);
    for (const line of result.stdout.trim().split(/\r?\n/)) t.diagnostic(line);
  });
});

test('считает сжатые байты gzip, а не распакованное тело', async () => {
  const raw = Buffer.alloc(20_000, 'a');
  const compressed = gzipSync(raw);
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(compressed);
  }, async (base) => {
    const output = report(await run(base));
    assert.equal(requests, count);
    assert.notEqual(compressed.length, raw.length);
    assert.equal(output.bytes, count * compressed.length);
  });
});

test('при ответе 204 сообщает нулевой объём и скорость', async () => {
  let requests = 0;
  await withServer((req, res) => { requests++; res.writeHead(204).end(); }, async (base) => {
    const output = report(await run(base));
    assert.equal(requests, count);
    assert.equal(output.bytes, 0);
    assert.equal(output.speed, 0);
  });
});

test('отклоняет неверные аргументы', async () => {
  for (const args of [[], ['не URL'], ['file:///tmp/file'], ['http://127.0.0.1', 'http://127.0.0.1']]) {
    assertFailure(await run(...args));
  }
});

test('останавливается при HTTP 404 в середине серии', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    res.writeHead(requests === 4 ? 404 : 200).end('body');
  }, async (base) => {
    const result = await run(base);
    assertFailure(result);
    assert.equal(requests, 4);
    assert.match(result.stderr, /404/u);
  });
});

test('отклоняет незавершённый ответ', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-length': 1000 });
    res.write('partial');
    setTimeout(() => res.destroy(), 20);
  }, async (base) => {
    assertFailure(await run(base));
    assert.equal(requests, 1);
  });
});

test('отклоняет перенаправление как ответ вне диапазона 2xx', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    res.writeHead(302, { location: '/target' }).end();
  }, async (base) => {
    assertFailure(await run(base));
    assert.equal(requests, 1);
  });
});
