import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { getTimelineEvents, getEventRecording } from '../src/events.js';
import { findRecordingForEvent } from '../src/recordings.js';
import { fastify } from '../src/server.js';
import { createToken } from '../src/auth.js';
import { config } from '../src/config.js';
import { getRecorderManager } from '../src/recorder-manager.js';

describe('Timeline & Event Recording Tests', () => {
  test('should return paginated timeline events with ascending order by default', () => {
    const result = getTimelineEvents({ page: 1, limit: 10 });
    assert.ok(result.items);
    assert.ok(Array.isArray(result.items));
    assert.strictEqual(result.pagination.page, 1);
    assert.strictEqual(result.pagination.limit, 10);
    assert.strictEqual(result.pagination.sort, 'asc');
    assert.ok(result.pagination.totalItems >= 0);
    assert.ok(result.pagination.totalPages >= 1);

    if (result.items.length >= 2) {
      const firstTime = new Date(result.items[0].start_time).getTime();
      const secondTime = new Date(result.items[1].start_time).getTime();
      assert.ok(firstTime <= secondTime, 'Default order must be ascending (oldest first)');
    }
  });

  test('should preserve ascending chronological order and zero duplicates across page 1, middle page, and last page', () => {
    const limit = 10;
    const page1 = getTimelineEvents({ page: 1, limit, sort: 'asc' });
    const totalPages = page1.pagination.totalPages;

    if (totalPages >= 3) {
      const midPageNum = Math.ceil(totalPages / 2);
      const midPage = getTimelineEvents({ page: midPageNum, limit, sort: 'asc' });
      const lastPage = getTimelineEvents({ page: totalPages, limit, sort: 'asc' });

      assert.strictEqual(page1.pagination.page, 1);
      assert.strictEqual(midPage.pagination.page, midPageNum);
      assert.strictEqual(lastPage.pagination.page, totalPages);

      const page1Ids = new Set(page1.items.map(i => i.id));
      const midIds = new Set(midPage.items.map(i => i.id));
      const lastIds = new Set(lastPage.items.map(i => i.id));

      for (const id of midIds) {
        assert.strictEqual(page1Ids.has(id), false, `Duplicate ID ${id} between page 1 and mid page`);
      }
      if (midPageNum !== totalPages) {
        for (const id of lastIds) {
          assert.strictEqual(midIds.has(id), false, `Duplicate ID ${id} between mid page and last page`);
        }
      }

      if (page1.items.length > 0 && midPage.items.length > 0 && lastPage.items.length > 0) {
        const t1Last = new Date(page1.items[page1.items.length - 1].start_time).getTime();
        const tMidFirst = new Date(midPage.items[0].start_time).getTime();
        const tMidLast = new Date(midPage.items[midPage.items.length - 1].start_time).getTime();
        const tLastFirst = new Date(lastPage.items[0].start_time).getTime();

        assert.ok(t1Last <= tMidFirst, 'Page 1 last event must be <= middle page first event');
        assert.ok(tMidLast <= tLastFirst, 'Middle page last event must be <= last page first event');
      }
    }
  });

  test('should maintain consistent adjacency on consecutive pages (page 1 -> page 2)', () => {
    const page1 = getTimelineEvents({ page: 1, limit: 5, sort: 'asc' });
    if (page1.pagination.totalPages >= 2) {
      const page2 = getTimelineEvents({ page: 2, limit: 5, sort: 'asc' });
      const p1Ids = new Set(page1.items.map(i => i.id));
      for (const item of page2.items) {
        assert.strictEqual(p1Ids.has(item.id), false, `Duplicate ID ${item.id} across consecutive pages`);
      }
      if (page1.items.length > 0 && page2.items.length > 0) {
        const lastP1 = new Date(page1.items[page1.items.length - 1].start_time).getTime();
        const firstP2 = new Date(page2.items[0].start_time).getTime();
        assert.ok(lastP1 <= firstP2, 'Page 2 must continue chronologically after Page 1');
      }
    }
  });

  test('should support descending sort order when explicitly requested', () => {
    const result = getTimelineEvents({ page: 1, limit: 10, sort: 'desc' });
    assert.strictEqual(result.pagination.sort, 'desc');

    if (result.items.length >= 2) {
      const firstTime = new Date(result.items[0].start_time).getTime();
      const secondTime = new Date(result.items[1].start_time).getTime();
      assert.ok(firstTime >= secondTime, 'Descending order must have newest first');
    }
  });

  test('each timeline item must identify the camera and have recording metadata', () => {
    const result = getTimelineEvents({ page: 1, limit: 5 });
    for (const item of result.items) {
      assert.ok(item.camera, 'Item must have camera identifier');
      assert.strictEqual(typeof item.camera, 'string');
      assert.ok(item.recording, 'Item must have recording metadata');
      assert.strictEqual(typeof item.recording.hasRecording, 'boolean');
      if (item.recording.hasRecording) {
        assert.ok(item.recording.videoUrl, 'Resolved recording must have videoUrl');
        assert.ok(item.recording.fileName, 'Resolved recording must have fileName');
      }
    }
  });

  test('should resolve recording for a given event ID', () => {
    const timeline = getTimelineEvents({ page: 1, limit: 1 });
    if (timeline.items.length > 0) {
      const eventId = timeline.items[0].id;
      const rec = getEventRecording(eventId);
      assert.ok(rec);
      assert.strictEqual(typeof rec.hasRecording, 'boolean');
      assert.ok(rec.camera);
    }
  });

  test('should handle nonexistent event ID gracefully', () => {
    const rec = getEventRecording(99999999);
    assert.strictEqual(rec.hasRecording, false);
    assert.strictEqual(rec.message, 'Evento no encontrado');
  });

  test('findRecordingForEvent returns false gracefully for invalid timestamps', () => {
    const match = findRecordingForEvent('not-a-valid-date');
    assert.strictEqual(match.hasRecording, false);
    assert.strictEqual(match.message, 'Timestamp de evento inválido');
  });

  test('findRecordingForEvent does not bind short motion clips with large false time offsets', () => {
    // Event 1595 (2026-11-26T03:51:00.857Z) occurred 14m after 03:36:47 clip (only ~32s long)
    const match = findRecordingForEvent('2026-11-26T03:51:00.857Z', 0);
    if (match.hasRecording) {
      assert.ok(
        (match.offsetSeconds ?? 0) <= (match.durationSeconds ?? 0),
        `Offset ${match.offsetSeconds}s cannot exceed clip duration ${match.durationSeconds}s`
      );
    }
  });

  describe('HTTP API Endpoints: Timeline, Event Recording & Range Streaming', () => {
    const validToken = createToken(config.AUTH_USER);

    test('GET /api/timeline returns 401 without auth', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/timeline' });
      assert.strictEqual(res.statusCode, 401);
    });

    test('GET /api/timeline returns 200 with paginated items in ascending order by default', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/timeline?page=1&limit=5',
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.items));
      assert.strictEqual(body.pagination.page, 1);
      assert.strictEqual(body.pagination.limit, 5);
      assert.strictEqual(body.pagination.sort, 'asc');
    });

    test('GET /api/events/:id/recording returns 200 and resolves recording or graceful fallback', async () => {
      const timelineRes = await fastify.inject({
        method: 'GET',
        url: '/api/timeline?page=1&limit=5&sort=desc',
        headers: { authorization: `Bearer ${validToken}` },
      });
      const timeline = JSON.parse(timelineRes.body);
      if (timeline.items.length > 0) {
        const target = timeline.items.find((i: any) => i.recording?.hasRecording) || timeline.items[0];
        const recRes = await fastify.inject({
          method: 'GET',
          url: `/api/events/${target.id}/recording`,
          headers: { authorization: `Bearer ${validToken}` },
        });
        assert.strictEqual(recRes.statusCode, 200);
        const recJson = JSON.parse(recRes.body);
        assert.strictEqual(recJson.eventId, target.id);
        assert.strictEqual(typeof recJson.hasRecording, 'boolean');

        // Also validate HTTP 206 Range request on the video URL if recording exists
        if (recJson.hasRecording && recJson.videoUrl) {
          const rangeRes = await fastify.inject({
            method: 'GET',
            url: recJson.videoUrl,
            headers: {
              authorization: `Bearer ${validToken}`,
              range: 'bytes=0-1023',
            },
          });
          assert.strictEqual(rangeRes.statusCode, 206);
          assert.strictEqual(rangeRes.headers['content-type'], 'video/mp4');
          assert.ok(String(rangeRes.headers['content-range']).startsWith('bytes 0-1023/'));
        }
      }
    });

    test('DELETE /api/recordings/:date validates date, returns 404 when missing, and deletes entire day folder', async () => {
      const badRes = await fastify.inject({
        method: 'DELETE',
        url: '/api/recordings/invalid-date',
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(badRes.statusCode, 400);

      const missRes = await fastify.inject({
        method: 'DELETE',
        url: '/api/recordings/1998-01-01',
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(missRes.statusCode, 404);

      const testDate = '1999-01-01';
      const testDir = path.join(config.RECORDINGS_DIR, testDate);
      const testFile = path.join(testDir, 'c2l_19990101_000001.mp4');
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, Buffer.alloc(2048, 1));

      const latestDate = '2099-01-01';
      const latestDir = path.join(config.RECORDINGS_DIR, latestDate);
      const latestFile = path.join(latestDir, 'c2l_20990101_000001.mp4');
      fs.mkdirSync(latestDir, { recursive: true });
      fs.writeFileSync(latestFile, Buffer.alloc(2048, 1));

      // Latest/current day must be protected (409 Conflict)
      const protRes = await fastify.inject({
        method: 'DELETE',
        url: `/api/recordings/${latestDate}`,
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(protRes.statusCode, 409);
      assert.strictEqual(fs.existsSync(latestDir), true);

      // Historical older day can be deleted cleanly (200 OK)
      const delRes = await fastify.inject({
        method: 'DELETE',
        url: `/api/recordings/${testDate}`,
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(delRes.statusCode, 200);
      const delJson = JSON.parse(delRes.body);
      assert.strictEqual(delJson.success, true);
      assert.strictEqual(delJson.deletedCount, 1);
      assert.strictEqual(fs.existsSync(testDir), false);

      // Clean up synthetic latest test fixture
      fs.rmSync(latestDir, { recursive: true, force: true });
    });

    test('Manual quick-record endpoints require auth, report idle state, and generate collision-free unique filenames', async () => {
      const unauthRes = await fastify.inject({
        method: 'POST',
        url: '/api/recorder/manual/toggle',
      });
      assert.strictEqual(unauthRes.statusCode, 401);

      const modeRes = await fastify.inject({
        method: 'GET',
        url: '/api/recorder/mode',
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(modeRes.statusCode, 200);
      const modeJson = JSON.parse(modeRes.body);
      assert.strictEqual(modeJson.isRecordingManual, false);

      const stopIdleRes = await fastify.inject({
        method: 'POST',
        url: '/api/recorder/manual/stop',
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.strictEqual(stopIdleRes.statusCode, 200);
      const stopJson = JSON.parse(stopIdleRes.body);
      assert.strictEqual(stopJson.success, false);
      assert.strictEqual(stopJson.status.isRecordingManual, false);

      // Verify collision-avoidance when continuous/motion already occupies the exact timestamp
      const rm = getRecorderManager();
      const collisionDate = new Date(2098, 4, 15, 12, 30, 0);
      const existingDir = path.join(config.RECORDINGS_DIR, '2098-05-15');
      const existingFile = path.join(existingDir, 'c2l_20980515_123000.mp4');
      fs.mkdirSync(existingDir, { recursive: true });
      fs.writeFileSync(existingFile, Buffer.alloc(64, 0));
      try {
        const res = (rm as any).buildUniqueManualTarget(collisionDate);
        assert.strictEqual(res.dateStr, '2098-05-15');
        assert.strictEqual(path.basename(res.targetFile), 'c2l_20980515_123001.mp4');
      } finally {
        fs.rmSync(existingDir, { recursive: true, force: true });
      }
    });
  });
});
