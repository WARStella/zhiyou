const fs = require('node:fs');
const path = require('node:path');
module.exports = fs.readFileSync(path.join(__dirname, '../../data/guide-knowledge.seed.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
