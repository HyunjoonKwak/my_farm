import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';

const exec = promisify(execFile);
export class BackupValidationError extends Error {}
export const backupScheduleSchema = z.object({
  enabled: z.boolean(),
  dayOfWeek: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  retentionDays: z.number().int().min(1).max(365),
});
export const defaultSchedule = { enabled: true, dayOfWeek: 0, hour: 2, minute: 0, retentionDays: 30 };
export const backupFilenameSchema = z.string().regex(/^(backup_|pre_restore_)[A-Za-z0-9_-]+\.db(?:\.gz)?$/, '유효하지 않은 백업 파일명입니다.');

export function backupDirectory() { return path.resolve(/* turbopackIgnore: true */ process.env.BACKUP_DIR || './backups'); }
export function configDirectory() { return path.resolve(/* turbopackIgnore: true */ process.env.CONFIG_DIR || path.join(backupDirectory(), 'config')); }
export function databasePath() {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith('file:')) throw new Error('SQLite DATABASE_URL이 필요합니다.');
  const value = url.slice(5);
  if (!value || value.includes('?') || value === ':memory:') throw new Error('파일 SQLite DATABASE_URL이 필요합니다.');
  return path.isAbsolute(value) ? value : path.resolve(/* turbopackIgnore: true */ process.cwd(), 'prisma', value);
}
export function pendingRestorePath() { return `${databasePath()}.restore-pending`; }
/** @param {string} file */
async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('일반 파일만 사용할 수 있습니다.');
  return stat;
}
// quick_check는 DB 크기·디스크 속도에 비례한다 (NAS 480MB 기준 약 2.5분). 기본 15분, SQLITE_TIMEOUT_MS로 조정.
const SQLITE_TIMEOUT_MS = Number(process.env.SQLITE_TIMEOUT_MS) > 0 ? Number(process.env.SQLITE_TIMEOUT_MS) : 15 * 60 * 1000;
/** @param {string} database @param {string[]} commands @param {boolean} readOnly */
async function sqlite(database, commands, readOnly = true) {
  const result = await exec(process.env.SQLITE_BIN || 'sqlite3',
    ['-batch', '-bail', ...(readOnly ? ['-readonly'] : []), database, '.timeout 10000', ...commands],
    { timeout: SQLITE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
/** @param {string} file */
export async function validateDatabase(file) {
  await regularFile(file);
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (header.toString() !== 'SQLite format 3\0') throw new BackupValidationError('SQLite 백업 파일이 아닙니다.');
  } finally { await handle.close(); }
  if (await sqlite(file, ['PRAGMA quick_check;']) !== 'ok') throw new BackupValidationError('SQLite 무결성 검사가 실패했습니다.');
  const tables = await sqlite(file, ["SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('User','Crop','FundingSource','SetupCostItem','_prisma_migrations');"]);
  if (tables !== '5') throw new BackupValidationError('이 앱의 백업 스키마가 아닙니다.');
  const foreignKeys = await sqlite(file, ['PRAGMA foreign_key_check;']);
  if (foreignKeys) throw new BackupValidationError('백업의 데이터 참조 무결성 검사가 실패했습니다.');
  if (await sqlite(file, ['SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;']) !== '0') throw new BackupValidationError('완료되지 않은 마이그레이션이 있는 백업입니다.');
  const applied = await sqlite(file, ['SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;']);
  const known = await fs.readdir(path.resolve(process.cwd(), 'prisma/migrations'));
  if (applied.split('\n').filter(Boolean).some(name => !known.includes(name))) {
    throw new BackupValidationError('현재 앱보다 새롭거나 알 수 없는 마이그레이션의 백업입니다.');
  }
  // 필수 사용자 키도 확인한다. 기존 버전의 백업은 시작 시 migrate deploy가 갱신한다.
  await sqlite(file, ['SELECT id, role, kakaoId FROM User LIMIT 0;']);
}
/** @param {string} [prefix] */
export async function createBackup(prefix = 'backup') {
  const db = databasePath();
  await regularFile(db);
  await fs.mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
  const filename = `${prefix}_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.db`;
  const destination = path.join(backupDirectory(), filename);
  const temporary = `${destination}.tmp`;
  try {
    await sqlite(db, [`.backup ${JSON.stringify(temporary)}`]);
    await fs.chmod(temporary, 0o600);
    // The private snapshot must be a portable single file, independent of WAL sidecars.
    await sqlite(temporary, ['PRAGMA journal_mode=DELETE;'], false);
    await validateDatabase(temporary);
    await fs.rename(temporary, destination);
    return { filename, size: (await fs.stat(destination)).size };
  } finally { await fs.rm(temporary, { force: true }); }
}
/** @param {string} filename */
export async function backupFile(filename) {
  backupFilenameSchema.parse(filename);
  const file = path.join(backupDirectory(), filename);
  await regularFile(file);
  return file;
}
/** Stage only: live Prisma connections are never overwritten by an HTTP handler. @param {string} filename */
export async function stageRestore(filename) {
  const source = await backupFile(filename);
  const pending = pendingRestorePath();
  const temporary = `${pending}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(pending), { recursive: true });
    if (filename.endsWith('.gz')) {
      await pipeline(createReadStream(/* turbopackIgnore: true */ source), createGunzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    } else {
      await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      await fs.chmod(temporary, 0o600);
    }
    await validateDatabase(temporary);
    // link is atomic and refuses to overwrite an already queued restore.
    await fs.link(temporary, pending);
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function hasPendingRestore() {
  try { await regularFile(pendingRestorePath()); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function cancelPendingRestore() { await fs.rm(pendingRestorePath(), { force: true }); }

/** Must run before migrations/server startup, with every other DB writer stopped. */
export async function applyPendingRestore() {
  const pending = pendingRestorePath();
  const applying = `${pending}.applying`;
  try {
    await fs.access(applying);
    throw new Error('이전 복원이 중단되었습니다. 안전 백업과 .applying 파일을 확인한 뒤 수동으로 복구하세요.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!await hasPendingRestore()) return null;
  await validateDatabase(pending);
  const safety = await createBackup('pre_restore'); // Failure must prevent all overwrites.
  await fs.rename(pending, applying);
  // SQLite backup API restore is transactional; it also handles existing WAL state.
  await sqlite(databasePath(), [`.restore ${JSON.stringify(applying)}`], false);
  await fs.rm(applying);
  return safety;
}
export async function readSchedule() {
  try { return backupScheduleSchema.parse(JSON.parse(await fs.readFile(path.join(configDirectory(), 'backup-schedule.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { ...defaultSchedule }; throw error; }
}
/** @param {z.infer<typeof backupScheduleSchema>} input */
export async function saveSchedule(input) {
  const schedule = backupScheduleSchema.parse(input);
  await fs.mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  const destination = path.join(configDirectory(), 'backup-schedule.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(schedule, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
  return schedule;
}
/** @param {Date} [now] */
export async function runScheduledBackup(now = new Date()) {
  const schedule = await readSchedule();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (/** @type {string} */ type) => parts.find(p => p.type === type)?.value;
  if (!schedule.enabled || schedule.dayOfWeek !== ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday') || '') || schedule.hour !== Number(get('hour')) || schedule.minute !== Number(get('minute'))) return null;
  await fs.mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  const slot = now.toISOString().slice(0, 16);
  const marker = path.join(configDirectory(), 'backup-last-run');
  try { if ((await fs.readFile(marker, 'utf8')) === slot) return null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const backup = await createBackup();
  await fs.writeFile(marker, slot, { mode: 0o600 });
  const cutoff = now.getTime() - schedule.retentionDays * 86400000;
  for (const name of await fs.readdir(/* turbopackIgnore: true */ backupDirectory())) {
    if (!name.startsWith('backup_') || !backupFilenameSchema.safeParse(name).success) continue;
    const file = path.join(backupDirectory(), name);
    const stat = await fs.lstat(file);
    if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(file);
  }
  return backup;
}

if (process.argv[1] && path.resolve(/* turbopackIgnore: true */ process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    const result = command === 'apply-pending' ? await applyPendingRestore()
      : command === 'scheduled' ? await runScheduledBackup()
      : command === 'create' ? await createBackup() : null;
    if (!['apply-pending', 'scheduled', 'create'].includes(command)) throw new Error('사용법: sqlite-backup.mjs apply-pending|scheduled|create');
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
