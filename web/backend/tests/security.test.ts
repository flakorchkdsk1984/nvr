import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validateRecordingPath,
  parseFileNameTimestamp,
  FILE_REGEX,
  DATE_REGEX,
} from '../src/recordings.js';
import { PtzMoveSchema, PtzPresetSchema, getPresetsList } from '../src/ptz.js';

describe('Security & Validation Tests', () => {
  it('should accept valid recording filenames', () => {
    assert.strictEqual(FILE_REGEX.test('c2l_20261120_210513.mp4'), true);
    assert.strictEqual(FILE_REGEX.test('c2l_19990101_000000.mp4'), true);
  });

  it('should reject invalid or malicious recording filenames', () => {
    assert.strictEqual(FILE_REGEX.test('../etc/passwd'), false);
    assert.strictEqual(FILE_REGEX.test('c2l_20261120_210513.sh'), false);
    assert.strictEqual(FILE_REGEX.test('c2l_20261120_210513.mp4.exe'), false);
    assert.strictEqual(FILE_REGEX.test('test.mp4'), false);
  });

  it('should accept valid date strings', () => {
    assert.strictEqual(DATE_REGEX.test('2026-11-20'), true);
  });

  it('should reject invalid date strings or path traversal in dates', () => {
    assert.strictEqual(DATE_REGEX.test('..'), false);
    assert.strictEqual(DATE_REGEX.test('../../etc'), false);
    assert.strictEqual(DATE_REGEX.test('2026/11/20'), false);
  });

  it('should throw error when path traversal is attempted in validateRecordingPath', () => {
    assert.throws(() => {
      validateRecordingPath('../', 'c2l_20261120_210513.mp4');
    }, /Invalid date format/);

    assert.throws(() => {
      validateRecordingPath('2026-11-20', '../../etc/passwd');
    }, /Invalid recording file name/);
  });

  it('should parse filename timestamp correctly', () => {
    const res = parseFileNameTimestamp('c2l_20261120_210513.mp4');
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.date, '2026-11-20');
    assert.strictEqual(res?.time, '21:05:13');
    assert.strictEqual(res?.full, '2026-11-20T21:05:13');
  });

  it('should validate PTZ actions with Zod schema', () => {
    const validMove = PtzMoveSchema.safeParse({ action: 'left', speed: 5, step: 1 });
    assert.strictEqual(validMove.success, true);

    const invalidAction = PtzMoveSchema.safeParse({ action: 'reboot', speed: 5 });
    assert.strictEqual(invalidAction.success, false);

    const invalidSpeed = PtzMoveSchema.safeParse({ action: 'right', speed: 99 });
    assert.strictEqual(invalidSpeed.success, false);

    const validPreset = PtzPresetSchema.safeParse({ action: 'goto', number: 3 });
    assert.strictEqual(validPreset.success, true);

    const validPresetSix = PtzPresetSchema.safeParse({ action: 'meta', number: 6, name: 'Candado', emoji: '🔒' });
    assert.strictEqual(validPresetSix.success, true);

    const invalidPresetZero = PtzPresetSchema.safeParse({ action: 'goto', number: 0 });
    assert.strictEqual(invalidPresetZero.success, false);

    const invalidPresetSeven = PtzPresetSchema.safeParse({ action: 'goto', number: 7 });
    assert.strictEqual(invalidPresetSeven.success, false);

    assert.strictEqual(getPresetsList().length, 6);
  });
});
