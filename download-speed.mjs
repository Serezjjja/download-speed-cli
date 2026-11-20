import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const requestCount = 10;
const idleTimeoutMs = 30_000;
const bytesPerMebibyte = 1024 ** 2;

function download(url) {
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const start = performance.now();
    const request = client.get(url, { timeout: idleTimeoutMs }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        reject(new Error(`HTTP ${response.statusCode}. Укажите конечный URL с ответом 2xx.`));
        return;
      }

      let bytes = 0;
      response.on('error', reject);
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => {
        resolve({ bytes, elapsedMs: performance.now() - start });
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('Соединение бездействовало 30 секунд.'));
    });
  });
}

async function main(args) {
  if (args.length !== 1 || !URL.canParse(args[0])) {
    throw new Error('Запуск: node download-speed.mjs "https://example.org/image.jpg"');
  }
  const url = new URL(args[0]);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Укажите URL с протоколом http или https.');
  }

  let totalBytes = 0;
  let totalMs = 0;
  for (let i = 1; i <= requestCount; i++) {
    try {
      const { bytes, elapsedMs } = await download(url);
      totalBytes += bytes;
      totalMs += elapsedMs;
    } catch (error) {
      throw new Error(`Запрос ${i} из ${requestCount}: ${error.message}`);
    }
  }

  const speed = (totalBytes / bytesPerMebibyte) / (totalMs / 1000);
  console.log(`Среднее время запроса: ${(totalMs / requestCount).toFixed(2)} мс`);
  console.log(`Всего скачано: ${totalBytes} байт`);
  console.log(`Скорость скачивания: ${speed.toFixed(3)} МиБ/с`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
