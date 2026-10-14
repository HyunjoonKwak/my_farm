#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node 20 CommonJS recovery CLI. */
// NAS container: node scripts/market-backfill.cjs --from YYYY-MM-DD --to YYYY-MM-DD [--products 오이]
// --products limits collection to those products (e.g. a newly added item) instead of the settings' full list.
// Uses the authenticated collection endpoint; never deletes data or prints credentials.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');

function recoveryDates(from, to, now = new Date()) {
  function parse(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('YYYY-MM-DD required');
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date');
    return d.getTime();
  }
  const start = parse(from), end = parse(to);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (end > parse(today) || start > end || (end - start) / 86400000 >= 62) throw new Error('Range must be past/current dates, ordered, at most 62 days');
  return Array.from({ length: (end - start) / 86400000 + 1 }, (_, i) => new Date(end - i * 86400000).toISOString().slice(0, 10));
}

function scopeKey(setting, products) {
  return createHash('sha256').update(JSON.stringify([
    setting.corporationCodes.split(',').filter(Boolean).sort(),
    (products || setting.targetProducts).split(',').map(s => s.trim()).filter(Boolean).sort(),
  ])).digest('hex').slice(0, 16);
}

async function main() {
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, products: { type: 'string' } } });
  const products = values.products ? values.products.split(',').map(s => s.trim()).filter(Boolean).join(',') : undefined;
  const dates = recoveryDates(values.from, values.to);
  if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET is required');
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const logPath = path.resolve(process.env.BACKFILL_LOG || '/app/prisma/data/market-backfill.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const completed = new Set();
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
      try { const row = JSON.parse(line); if (row.complete) completed.add(`${row.scope}:${row.date}`); } catch { /* interrupted trailing record is retried */ }
    }
  }
  let incomplete = 0;
  try {
    const settings = await prisma.marketCollectionSettings.findMany({ where: { autoCollectEnabled: true }, select: { userId: true, corporationCodes: true, targetProducts: true } });
    if (!settings.length) throw new Error('No enabled collection settings');
    for (const date of dates) {
      for (const setting of settings) {
        const scope = scopeKey(setting, products), key = `${scope}:${date}`;
        if (completed.has(key)) continue;
        const started = Date.now();
        // Loopback only: secret cannot be redirected to another host.
        const response = await fetch('http://127.0.0.1:3000/api/market/garak/cron', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CRON_SECRET}` },
          body: JSON.stringify({ userId: setting.userId, date, ...(products ? { products } : {}) }),
        });
        if (!response.ok) throw new Error(`Collection endpoint HTTP ${response.status}`);
        const data = await response.json();
        const complete = data.complete === true && ['SUCCESS', 'EMPTY'].includes(data.status);
        const row = { at: new Date().toISOString(), date, scope, status: data.status, complete, totalCount: data.totalCount, newCount: data.newCount, issueCount: data.issues?.length ?? 0, elapsedMs: Date.now() - started };
        fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
        process.stdout.write(`${JSON.stringify(row)}\n`);
        if (complete) completed.add(key);
        else incomplete++;
        if (data.status === 'FAILED') throw new Error('Collection failed; remaining dates preserved for next run');
      }
    }
    if (incomplete) process.exitCode = 2;
    process.stdout.write(`${JSON.stringify({ finished: true, incomplete })}\n`);
  } finally { await prisma.$disconnect(); }
}

module.exports = { recoveryDates, scopeKey };
if (require.main === module) main().catch(error => { process.stderr.write(`Backfill stopped: ${error.name}\n`); process.exitCode = 1; });
