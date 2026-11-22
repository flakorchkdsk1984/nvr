import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Search for .env in candidate directories
const possibleEnvPaths = [
  process.env.ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../../.env'),
  path.resolve(__dirname, '../../../.env'),
  '/app/.env',
];

const envPath = possibleEnvPaths.find((p) => p && fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
}

const defaultFfmpeg = fs.existsSync('/usr/bin/ffmpeg')
  ? '/usr/bin/ffmpeg'
  : fs.existsSync('/home/chkdsk/bin/ffmpeg')
  ? '/home/chkdsk/bin/ffmpeg'
  : 'ffmpeg';

const defaultFfprobe = fs.existsSync('/usr/bin/ffprobe')
  ? '/usr/bin/ffprobe'
  : fs.existsSync('/home/chkdsk/bin/ffprobe')
  ? '/home/chkdsk/bin/ffprobe'
  : 'ffprobe';

const ConfigSchema = z.object({
  CAMERA_HOST: z.string().default('192.168.1.40'),
  CAMERA_PORT: z.coerce.number().default(80),
  CAMERA_USER: z.string().default('admin'),
  CAMERA_PASS: z.string().default(''),

  GO2RTC_URL: z.string().default('http://127.0.0.1:1984'),
  GO2RTC_RTSP: z.string().default('rtsp://127.0.0.1:8554'),

  RECORDINGS_DIR: z.string().default(process.env.RECORDINGS_DIR || '/home/chkdsk/c2l_nvr/recordings'),
  THUMBS_DIR: z.string().default(process.env.THUMBS_DIR || '/home/chkdsk/c2l_nvr/cache/thumbs'),
  DATA_DIR: z.string().default(process.env.DATA_DIR || '/home/chkdsk/c2l_nvr/data'),

  SEGMENT_SECONDS: z.coerce.number().default(900),
  RETENTION_DAYS: z.coerce.number().default(7),
  MAX_DISK_USAGE_PERCENT: z.coerce.number().default(90),

  MOTION_SOURCE: z.enum(['software', 'camera']).default('software'),
  MOTION_SENSITIVITY: z.coerce.number().default(3.0),
  MOTION_COOLDOWN_S: z.coerce.number().default(5),
  PREROLL_S: z.coerce.number().default(10),
  POSTROLL_S: z.coerce.number().default(15),
  RECORDING_MODE: z.enum(['continuous', 'motion', 'paused']).default('continuous'),

  // Day/Night Inference configuration
  DAYNIGHT_SAT_DAY_THRESHOLD: z.coerce.number().default(5.0),
  DAYNIGHT_SAT_NIGHT_THRESHOLD: z.coerce.number().default(1.0),
  DAYNIGHT_SWITCH_GRACE_S: z.coerce.number().default(8),
  DAYNIGHT_POLL_INTERVAL_S: z.coerce.number().default(10),

  PORT: z.coerce.number().default(8000),
  AUTH_USER: z.string().default('admin'),
  AUTH_PASS_HASH: z.string().default('$2a$10$r2JgGUv9lK7rxZ24sP2cKeQJi1s18b8oLB/UD8D08SNSihPFADscu'),
  JWT_SECRET: z.string().default('super_secret_jwt_c2l_nvr_key_2026_xyz987'),

  FFMPEG_PATH: z.string().default(process.env.FFMPEG_PATH || defaultFfmpeg),
  FFPROBE_PATH: z.string().default(process.env.FFPROBE_PATH || defaultFfprobe),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.format());
  process.exit(1);
}

export let config = parsed.data;
