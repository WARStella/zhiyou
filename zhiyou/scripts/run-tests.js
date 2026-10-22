/**
 * 测试入口 —— 在**单个进程内**依次加载全部测试文件。
 *
 * 为什么不用 `node --test test/`：
 * 内置测试运行器会为每个测试文件 spawn 子进程并使用管道 stdio，
 * 在受限沙箱下会以 `spawn EPERM` 失败。单进程 require 的方式等价、且更快，
 * 在没有沙箱的环境下两种方式都可以用。
 */

const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '..', 'test');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('未找到测试文件');
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件（单进程模式）\n`);

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  require(join(dir, f));
}
