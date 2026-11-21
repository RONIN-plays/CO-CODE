// Room passwords: scrypt hashes stored in data/<room>.meta.json, plus a simple
// per-IP limiter for failed password attempts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PASSWORD_LENGTH = 128;
const KEY_LEN = 64;
const SALT_LEN = 16;

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function metaFile(dataDir, room) {
  return path.join(dataDir, `${room}.meta.json`);
}

/** Returns {salt, hash} (hex strings) or null when the room has no password. */
export function loadPassword(dataDir, room) {
  const file = metaFile(dataDir, room);
  if (!fs.existsSync(file)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      typeof meta?.salt === 'string' &&
      typeof meta?.hash === 'string' &&
      /^[0-9a-f]+$/i.test(meta.salt) &&
      /^[0-9a-f]+$/i.test(meta.hash) &&
      meta.hash.length === KEY_LEN * 2
    ) {
      return { salt: meta.salt, hash: meta.hash };
    }
  } catch {
    /* fall through */
  }
  // A corrupt meta file must never silently unlock a room: keep it locked with
  // a record no password can match until an admin fixes/deletes the file.
  console.error(`Corrupt password file for room "${room}" (${file}); room stays locked.`);
  return { salt: '00', hash: '' };
}

/** Hashes the password and writes it to the room's meta file. Returns the stored record. */
export async function savePassword(dataDir, room, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(password, salt);
  const record = { salt: salt.toString('hex'), hash: key.toString('hex') };
  const file = metaFile(dataDir, room);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
  return record;
}

export async function verifyPassword(record, password) {
  const expected = Buffer.from(record.hash, 'hex');
  const key = await scrypt(password, Buffer.from(record.salt, 'hex'));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ---------- brute-force protection ----------
/** @type {Map<string, number[]>} ip -> timestamps of recent failures */
const failures = new Map();

function recent(ip, now = Date.now()) {
  const list = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

export function isBlocked(ip) {
  return recent(ip).length >= MAX_FAILURES;
}

export function recordFailure(ip) {
  const list = recent(ip);
  list.push(Date.now());
  failures.set(ip, list);
}

// Forget stale entries so the map cannot grow without bound.
setInterval(() => {
  for (const ip of [...failures.keys()]) recent(ip);
}, 60 * 1000).unref();
