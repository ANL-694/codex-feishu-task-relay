'use strict';

const { main } = require('./feishu-worker.cjs');

if (require.main === module) {
  main().catch((error) => {
    console.error(`飞书中继未启动：${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
