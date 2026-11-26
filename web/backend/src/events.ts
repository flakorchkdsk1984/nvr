import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { addLog } from './logger.js';
import { findRecordingForEvent, EventRecordingMatch } from './recordings.js';

export interface MotionEvent {
  id: number;
  start_time: string;
  end_time: string | null;
  duration_s: number;
  score: number;
  snapshot_path: string | null;
  source: string;
  created_at: string;
}

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

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

export function recordMotionStart(
  source: string = 'software',
  score: number = 0,
  snapshotBuffer?: Buffer
): MotionEvent {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO motion_events (start_time, end_time, duration_s, score, snapshot_path, source, created_at)
    VALUES (?, NULL, 0, ?, NULL, ?, ?)
  `);

  const result = insertStmt.run(nowIso, score, source, nowIso);
  const id = Number(result.lastInsertRowid);

  let snapshotPath: string | null = null;
  if (snapshotBuffer && snapshotBuffer.length > 0) {
    try {
      const fileName = `snap_${id}_${Date.now()}.jpg`;
      const fullPath = path.join(config.DATA_DIR, 'events', fileName);
      fs.writeFileSync(fullPath, snapshotBuffer);
      snapshotPath = fileName;

      const updateSnapStmt = db.prepare(`UPDATE motion_events SET snapshot_path = ? WHERE id = ?`);
      updateSnapStmt.run(snapshotPath, id);
    } catch (err: any) {
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

export function recordMotionEnd(id: number, maxScore?: number): MotionEvent | null {
  const db = getDb();
  const selectStmt = db.prepare(`SELECT * FROM motion_events WHERE id = ?`);
  const row = selectStmt.get(id) as MotionEvent | undefined;

  if (!row) return null;

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

export function getEvents(date?: string, limit: number = 100): MotionEvent[] {
  const db = getDb();
  if (date) {
    const stmt = db.prepare(`
      SELECT * FROM motion_events
      WHERE start_time LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(`${date}%`, limit) as unknown as MotionEvent[];
  }

  const stmt = db.prepare(`
    SELECT * FROM motion_events
    ORDER BY id DESC
    LIMIT ?
  `);
  return stmt.all(limit) as unknown as MotionEvent[];
}

export function getEventById(id: number): MotionEvent | null {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM motion_events WHERE id = ?`);
  const row = stmt.get(id) as unknown as MotionEvent | undefined;
  return row || null;
}

export function getEventSnapshot(id: number): { buffer: Buffer; contentType: string } | null {
  const event = getEventById(id);
  if (!event || !event.snapshot_path) return null;

  const fullPath = path.join(config.DATA_DIR, 'events', event.snapshot_path);
  if (!fs.existsSync(fullPath)) return null;

  return {
    buffer: fs.readFileSync(fullPath),
    contentType: 'image/jpeg',
  };
}

export function cleanupOldEvents(retentionDays: number): number {
  try {
    const db = getDb();
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const oldRows = db.prepare(`SELECT id, snapshot_path FROM motion_events WHERE start_time < ?`).all(cutoffDate) as unknown as { id: number; snapshot_path: string | null }[];

    for (const row of oldRows) {
      if (row.snapshot_path) {
        try {
          const snapFile = path.join(config.DATA_DIR, 'events', row.snapshot_path);
          if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);
        } catch {}
      }
    }

    const deleteStmt = db.prepare(`DELETE FROM motion_events WHERE start_time < ?`);
    const res = deleteStmt.run(cutoffDate);
    return Number(res.changes);
  } catch (err: any) {
    addLog('error', `Error al limpiar eventos antiguos: ${err.message}`);
    return 0;
  }
}

export interface TimelineQuery {
  page?: number;
  limit?: number;
  sort?: 'asc' | 'desc';
  date?: string;
  search?: string;
}

export interface TimelineItem extends MotionEvent {
  camera: string;
  recording: EventRecordingMatch;
}

export interface TimelineResult {
  items: TimelineItem[];
  pagination: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
    sort: 'asc' | 'desc';
  };
}

export function getEventRecording(id: number): EventRecordingMatch {
  const event = getEventById(id);
  if (!event) {
    return {
      hasRecording: false,
      camera: 'C2L-Y-A (HD)',
      message: 'Evento no encontrado',
    };
  }
  return findRecordingForEvent(event.start_time, event.duration_s);
}

export function getTimelineEvents(query: TimelineQuery = {}): TimelineResult {
  const db = getDb();
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const sortDirection = query.sort === 'desc' ? 'DESC' : 'ASC'; // Default ASC per requirement!
  const offset = (page - 1) * limit;

  const whereConditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
    whereConditions.push('start_time LIKE ?');
    params.push(`${query.date}%`);
  }

  if (query.search && query.search.trim()) {
    const s = `%${query.search.trim()}%`;
    whereConditions.push('(id LIKE ? OR source LIKE ?)');
    params.push(s, s);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Get total count
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM motion_events ${whereClause}`);
  const countRow = countStmt.get(...params) as { count: number } | undefined;
  const totalItems = countRow ? Number(countRow.count) : 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));

  // Query paginated items
  const queryStmt = db.prepare(`
    SELECT * FROM motion_events
    ${whereClause}
    ORDER BY start_time ${sortDirection}
    LIMIT ? OFFSET ?
  `);

  const rows = queryStmt.all(...params, limit, offset) as unknown as MotionEvent[];

  const items: TimelineItem[] = rows.map((ev) => {
    const rec = findRecordingForEvent(ev.start_time, ev.duration_s);
    return {
      ...ev,
      camera: 'C2L-Y-A (HD)',
      recording: rec,
    };
  });

  return {
    items,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
      sort: query.sort === 'desc' ? 'desc' : 'asc',
    },
  };
}
