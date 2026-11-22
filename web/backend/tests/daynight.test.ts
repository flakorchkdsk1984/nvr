import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateDayNightTransition,
  getDayNightState,
} from '../src/daynight.js';
import { getMotionEngine } from '../src/motion.js';
import { getLightState } from '../src/light.js';
import { fastify } from '../src/server.js';
import { createToken } from '../src/auth.js';
import { config } from '../src/config.js';

describe('Day/Night Inference & Motion Suppression Tests', () => {
  describe('Hysteresis & Debounce Evaluation Logic', () => {
    it('should identify night candidate when saturation is <= night threshold (1.0%)', () => {
      const res = evaluateDayNightTransition(0.0, 'day', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(res.candidate, 'night');
      assert.strictEqual(res.isTransition, false); // Debounce requires 2 readings
      assert.strictEqual(res.nextState, 'day');
      assert.strictEqual(res.nextPending, 'night');
      assert.strictEqual(res.nextConsecutive, 1);
    });

    it('should complete transition to night after 2 consecutive readings', () => {
      const reading1 = evaluateDayNightTransition(0.2, 'day', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(reading1.candidate, 'night');
      assert.strictEqual(reading1.isTransition, false);
      assert.strictEqual(reading1.nextPending, 'night');
      assert.strictEqual(reading1.nextConsecutive, 1);

      const reading2 = evaluateDayNightTransition(0.1, 'day', reading1.nextPending, reading1.nextConsecutive, 1.0, 5.0, 2);
      assert.strictEqual(reading2.candidate, 'night');
      assert.strictEqual(reading2.isTransition, true);
      assert.strictEqual(reading2.nextState, 'night');
      assert.strictEqual(reading2.nextPending, null);
      assert.strictEqual(reading2.nextConsecutive, 0);
    });

    it('should identify day candidate when saturation is > day threshold (5.0%)', () => {
      const res = evaluateDayNightTransition(21.4, 'night', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(res.candidate, 'day');
      assert.strictEqual(res.isTransition, false); // First reading
      assert.strictEqual(res.nextPending, 'day');
      assert.strictEqual(res.nextConsecutive, 1);
    });

    it('should complete transition to day after 2 consecutive readings', () => {
      const reading1 = evaluateDayNightTransition(18.0, 'night', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(reading1.candidate, 'day');
      assert.strictEqual(reading1.isTransition, false);

      const reading2 = evaluateDayNightTransition(23.5, 'night', reading1.nextPending, reading1.nextConsecutive, 1.0, 5.0, 2);
      assert.strictEqual(reading2.candidate, 'day');
      assert.strictEqual(reading2.isTransition, true);
      assert.strictEqual(reading2.nextState, 'day');
    });

    it('should preserve existing state within the hysteresis band (1.0% - 5.0%)', () => {
      // In hysteresis band with current state 'day' -> maintains 'day'
      const resDay = evaluateDayNightTransition(3.2, 'day', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(resDay.candidate, 'day');
      assert.strictEqual(resDay.nextState, 'day');
      assert.strictEqual(resDay.isTransition, false);

      // In hysteresis band with current state 'night' -> maintains 'night'
      const resNight = evaluateDayNightTransition(3.2, 'night', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(resNight.candidate, 'night');
      assert.strictEqual(resNight.nextState, 'night');
      assert.strictEqual(resNight.isTransition, false);
    });

    it('should cancel pending transition if an outlier reading appears (debouncing protection)', () => {
      // First sample suggests night
      const reading1 = evaluateDayNightTransition(0.3, 'day', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(reading1.nextPending, 'night');
      assert.strictEqual(reading1.nextConsecutive, 1);

      // Spurious sample suggests day -> should reset pending state
      const reading2 = evaluateDayNightTransition(15.0, 'day', reading1.nextPending, reading1.nextConsecutive, 1.0, 5.0, 2);
      assert.strictEqual(reading2.candidate, 'day');
      assert.strictEqual(reading2.nextState, 'day');
      assert.strictEqual(reading2.nextPending, null);
      assert.strictEqual(reading2.nextConsecutive, 0);
      assert.strictEqual(reading2.isTransition, false);
    });

    it('should transition immediately on first valid reading if initial state is unknown', () => {
      const res = evaluateDayNightTransition(0.0, 'unknown', null, 0, 1.0, 5.0, 2);
      assert.strictEqual(res.candidate, 'night');
      assert.strictEqual(res.isTransition, true);
      assert.strictEqual(res.nextState, 'night');
    });
  });

  describe('Motion Suppression on Day/Night Switch', () => {
    it('should suppress motion detection for the specified grace period', () => {
      const engine = getMotionEngine();
      const graceSeconds = 8;
      engine.suppressMotion(graceSeconds);

      const internalEngine = engine as any;
      assert.strictEqual(typeof internalEngine.suppressUntil, 'number');
      assert.strictEqual(internalEngine.suppressUntil > Date.now(), true);
      assert.strictEqual(internalEngine.previousFrame, null);
    });

    it('should abort active motion event and reset score when suppressMotion is invoked', () => {
      const engine = getMotionEngine();
      const internalEngine = engine as any;

      // Simulate active motion
      internalEngine.inMotion = true;
      internalEngine.currentEvent = { id: 8888 };
      internalEngine.currentScore = 45.0;

      let motionEndEmitted = false;
      const listener = () => {
        motionEndEmitted = true;
      };
      engine.once('motion-end', listener);

      engine.suppressMotion(5);

      assert.strictEqual(internalEngine.inMotion, false);
      assert.strictEqual(internalEngine.currentEvent, null);
      assert.strictEqual(internalEngine.currentScore, 0);
      assert.strictEqual(motionEndEmitted, true);
    });
  });

  describe('HTTP API Endpoints: DayNight & Light', () => {
    const validToken = createToken(config.AUTH_USER);

    it('GET /api/daynight should return 200 with inferred status and metrics', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/daynight',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      assert.strictEqual(response.statusCode, 200);
      const json = JSON.parse(response.body);
      assert.strictEqual(json.source, 'inferred');
      assert.ok(['day', 'night', 'unknown'].includes(json.state));
      assert.strictEqual(typeof json.saturation, 'number');
      assert.strictEqual(typeof json.brightness, 'number');
      assert.ok(json.updatedAt);
    });

    it('POST /api/daynight should return 501 Not Implemented', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/daynight',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: { state: 'day' },
      });

      assert.strictEqual(response.statusCode, 501);
      const json = JSON.parse(response.body);
      assert.ok(json.error.includes('solo es posible desde la aplicación móvil'));
      assert.strictEqual(json.state.source, 'inferred');
    });

    it('GET /api/light should return 200 with light state linked to inferred daynight', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/light',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      assert.strictEqual(response.statusCode, 200);
      const json = JSON.parse(response.body);
      assert.strictEqual(typeof json.on, 'boolean');
      assert.strictEqual(json.source, 'inferred');
      assert.ok(json.updatedAt);
    });

    it('POST /api/light should return 501 Not Implemented and not toggle light', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/light',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: { enabled: true },
      });

      assert.strictEqual(response.statusCode, 501);
      const json = JSON.parse(response.body);
      assert.ok(json.error.includes('solo puede realizarse desde la aplicación móvil'));
      assert.strictEqual(json.state.source, 'inferred');
    });

    it('GET /api/daynight should return 401 Unauthorized without authentication', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/daynight',
      });

      assert.strictEqual(response.statusCode, 401);
    });
  });
});
