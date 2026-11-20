import http from 'node:http';
import https from 'node:https';

const requestCount = 10;
const bytesPerMebibyte = 1024 ** 2;

async function downloadBytes(url) {
  const client = url.protocol === 'https:' ? https : http;
  const response = await new Promise((resolve, reject) => {
    const request = client.get(url, resolve);
    request.on('error', reject);
    request.setTimeout(30_000, () => {
      request.destroy(new Error('Соединение бездействовало 30 секунд.'));
    });
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new Error(`HTTP ${response.statusCode}. Укажите конечный URL с ответом 2xx.`);
  }

  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
  }
  return bytes;
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
    const start = performance.now();
    try {
      totalBytes += await downloadBytes(url);
    } catch (error) {
      throw new Error(`Запрос ${i} из ${requestCount}: ${error.message}`);
    }
    totalMs += performance.now() - start;
  }

  const averageMs = totalMs / requestCount;
  const speedMiBPerSecond = (totalBytes / bytesPerMebibyte) / (totalMs / 1000);
  console.log(`Среднее время запроса: ${averageMs.toFixed(2)} мс`);
  console.log(`Всего скачано: ${totalBytes} байт`);
  console.log(`Скорость скачивания: ${speedMiBPerSecond.toFixed(3)} МиБ/с`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
