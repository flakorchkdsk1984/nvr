import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { addLog } from './logger.js';
let dbInstance = null;
function getDb() {
    if (dbInstance)
        return dbInstance;
    const dbDir = config.DATA_DIR;
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const eventsDir = path.join(config.DATA_DIR, 'events');
    if (!fs.existsSync(eventsDir)) {
        fs.mkdirSync(eventsDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, 'events.sqlite');
    dbInstance = new DatabaseSync(dbPath);
    // Initialize schema
    dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS motion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration_s REAL DEFAULT 0,
      score REAL DEFAULT 0,
      snapshot_path TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON motion_events(start_time);
  `);
    return dbInstance;
}
export function recordMotionStart(source = 'software', score = 0, snapshotBuffer) {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const insertStmt = db.prepare(`
    INSERT INTO motion_events (start_time, end_time, duration_s, score, snapshot_path, source, created_at)
    VALUES (?, NULL, 0, ?, NULL, ?, ?)
  `);
    const result = insertStmt.run(nowIso, score, source, nowIso);
    const id = Number(result.lastInsertRowid);
    let snapshotPath = null;
    if (snapshotBuffer && snapshotBuffer.length > 0) {
        try {
            const fileName = `snap_${id}_${Date.now()}.jpg`;
            const fullPath = path.join(config.DATA_DIR, 'events', fileName);
            fs.writeFileSync(fullPath, snapshotBuffer);
            snapshotPath = fileName;
            const updateSnapStmt = db.prepare(`UPDATE motion_events SET snapshot_path = ? WHERE id = ?`);
            updateSnapStmt.run(snapshotPath, id);
        }
        catch (err) {
            addLog('warn', `No se pudo guardar la captura del evento ${id}: ${err.message}`);
        }
    }
    return {
        id,
        start_time: nowIso,
        end_time: null,
        duration_s: 0,
        score,
        snapshot_path: snapshotPath,
        source,
        created_at: nowIso,
    };
}
export function recordMotionEnd(id, maxScore) {
    const db = getDb();
    const selectStmt = db.prepare(`SELECT * FROM motion_events WHERE id = ?`);
    const row = selectStmt.get(id);
    if (!row)
        return null;
    const endIso = new Date().toISOString();
    const startMs = Date.parse(row.start_time);
    const endMs = Date.parse(endIso);
    const durationS = Math.max(0, Math.round(((endMs - startMs) / 1000) * 10) / 10);
    const finalScore = maxScore !== undefined ? Math.max(row.score, maxScore) : row.score;
    const updateStmt = db.prepare(`
    UPDATE motion_events
    SET end_time = ?, duration_s = ?, score = ?
    WHERE id = ?
  `);
    updateStmt.run(endIso, durationS, finalScore, id);
    return {
        ...row,
        end_time: endIso,
        duration_s: durationS,
        score: finalScore,
    };
}
export function getEvents(date, limit = 100) {
    const db = getDb();
    if (date) {
        const stmt = db.prepare(`
      SELECT * FROM motion_events
      WHERE start_time LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `);
        return stmt.all(`${date}%`, limit);
    }
    const stmt = db.prepare(`
    SELECT * FROM motion_events
    ORDER BY id DESC
    LIMIT ?
  `);
    return stmt.all(limit);
}
export function getEventById(id) {
    const db = getDb();
    const stmt = db.prepare(`SELECT * FROM motion_events WHERE id = ?`);
    const row = stmt.get(id);
    return row || null;
}
export function getEventSnapshot(id) {
    const event = getEventById(id);
    if (!event || !event.snapshot_path)
        return null;
    const fullPath = path.join(config.DATA_DIR, 'events', event.snapshot_path);
    if (!fs.existsSync(fullPath))
        return null;
    return {
        buffer: fs.readFileSync(fullPath),
        contentType: 'image/jpeg',
    };
}
export function cleanupOldEvents(retentionDays) {
    try {
        const db = getDb();
        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const oldRows = db.prepare(`SELECT id, snapshot_path FROM motion_events WHERE start_time < ?`).all(cutoffDate);
        for (const row of oldRows) {
            if (row.snapshot_path) {
                try {
                    const snapFile = path.join(config.DATA_DIR, 'events', row.snapshot_path);
                    if (fs.existsSync(snapFile))
                        fs.unlinkSync(snapFile);
                }
                catch { }
            }
        }
        const deleteStmt = db.prepare(`DELETE FROM motion_events WHERE start_time < ?`);
        const res = deleteStmt.run(cutoffDate);
        return Number(res.changes);
    }
    catch (err) {
        addLog('error', `Error al limpiar eventos antiguos: ${err.message}`);
        return 0;
    }
}
