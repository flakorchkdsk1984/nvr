import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import fastifyHttpProxy from '@fastify/http-proxy';
import { z } from 'zod';
import { config } from './config.js';
import { addLog, getLogs } from './logger.js';
import { requireAuth, verifyUserCredentials, createToken, AUTH_COOKIE_OPTS, } from './auth.js';
import { PtzMoveSchema, PtzPresetSchema, executePtzMove, executePtzPreset, getPresetsList, } from './ptz.js';
import { getAvailableDays, scanDateFolder, validateRecordingPath, generateThumbnail, exportClip, deleteSegment, deleteDay, ProtectedDayError, initRecordingsWatcher, DATE_REGEX, } from './recordings.js';
import { getStorageStats, runRetentionCycle, initRetentionScheduler, } from './storage.js';
import { checkSystemHealth, getLiveSnapshotBuffer, startRecorder, stopRecorder, updateCameraConfig, } from './system.js';
import { getLightState } from './light.js';
import { getDayNightState, startDayNightPoller, dayNightEvents, } from './daynight.js';
import { getEvents, getEventSnapshot, getEventRecording, getTimelineEvents, closeOrphanedEvents, } from './events.js';
import { getMotionEngine, startMotionEngine } from './motion.js';
import { getRecorderManager, initRecorderManager } from './recorder-manager.js';
export const fastify = Fastify({
    logger: false,
});
// Register Plugins
await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false, // Allow embedding video streams and local canvas/webrtc
});
await fastify.register(fastifyCors, {
    origin: true,
    credentials: true,
});
await fastify.register(fastifyCookie);
// Proxy go2rtc Web, API, and WebSockets through the main backend port (8000)
await fastify.register(fastifyHttpProxy, {
    upstream: config.GO2RTC_URL,
    prefix: '/go2rtc',
    websocket: true,
    rewritePrefix: '',
});
// ==========================================
// 1. PUBLIC ROUTES
// ==========================================
fastify.get('/api/health', async () => {
    return await checkSystemHealth();
});
fastify.post('/api/auth/login', async (req, reply) => {
    const schema = z.object({
        username: z.string(),
        password: z.string(),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid username or password format' });
    }
    const valid = await verifyUserCredentials(parse.data.username, parse.data.password);
    if (!valid) {
        addLog('warn', `Failed login attempt for user: ${parse.data.username}`);
        return reply.status(401).send({ error: 'Invalid username or password' });
    }
    const token = createToken(parse.data.username);
    reply.setCookie('nvr_token', token, AUTH_COOKIE_OPTS);
    addLog('info', `User logged in: ${parse.data.username}`);
    return { success: true, user: parse.data.username };
});
fastify.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie('nvr_token', { path: '/' });
    return { success: true };
});
// ==========================================
// 2. PROTECTED ROUTES
// ==========================================
fastify.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', requireAuth);
    protectedRoutes.get('/api/auth/me', async (req) => {
        return { user: req.user };
    });
    // PTZ Endpoints
    protectedRoutes.post('/api/ptz/move', async (req, reply) => {
        const parse = PtzMoveSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'Invalid PTZ parameters', details: parse.error.format() });
        }
        const res = await executePtzMove(parse.data);
        if (!res.success) {
            return reply.status(502).send({ error: res.message });
        }
        return res;
    });
    protectedRoutes.post('/api/ptz/preset', async (req, reply) => {
        const parse = PtzPresetSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'Invalid preset parameters', details: parse.error.format() });
        }
        const res = await executePtzPreset(parse.data);
        if (!res.success) {
            return reply.status(502).send({ error: res.message });
        }
        return res;
    });
    protectedRoutes.get('/api/ptz/presets', async () => {
        return getPresetsList();
    });
    // Snapshot
    protectedRoutes.get('/api/snapshot', async (req, reply) => {
        try {
            const { buffer, contentType } = await getLiveSnapshotBuffer();
            reply.header('Content-Type', contentType);
            reply.header('Content-Disposition', 'inline; filename="snapshot.jpg"');
            return reply.send(buffer);
        }
        catch (err) {
            return reply.status(502).send({ error: `Snapshot error: ${err.message}` });
        }
    });
    // Recordings Listing
    protectedRoutes.get('/api/recordings', async (req, reply) => {
        const { date } = req.query;
        if (date) {
            if (!DATE_REGEX.test(date)) {
                return reply.status(400).send({ error: 'Invalid date format (must be YYYY-MM-DD)' });
            }
            return scanDateFolder(date);
        }
        return getAvailableDays();
    });
    // Stream Video with HTTP 206 Partial Content (Range Requests)
    protectedRoutes.get('/api/recordings/:date/:file', async (req, reply) => {
        const { date, file } = req.params;
        let filePath;
        try {
            filePath = validateRecordingPath(date, file);
        }
        catch (err) {
            return reply.status(400).send({ error: err.message });
        }
        if (!fs.existsSync(filePath)) {
            return reply.status(404).send({ error: 'Recording file not found' });
        }
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        reply.header('Content-Type', 'video/mp4');
        reply.header('Accept-Ranges', 'bytes');
        if (!range) {
            reply.header('Content-Length', fileSize);
            return reply.send(fs.createReadStream(filePath));
        }
        // Parse Range: bytes=start-end
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (start >= fileSize || end >= fileSize || start > end) {
            reply.header('Content-Range', `bytes */${fileSize}`);
            return reply.status(416).send({ error: 'Requested range not satisfiable' });
        }
        const chunksize = end - start + 1;
        reply.status(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        reply.header('Content-Length', chunksize);
        const stream = fs.createReadStream(filePath, { start, end });
        return reply.send(stream);
    });
    // Thumbnail
    protectedRoutes.get('/api/recordings/:date/:file/thumb', async (req, reply) => {
        const { date, file } = req.params;
        const { at } = req.query;
        const atSeconds = at !== undefined ? parseFloat(at) : undefined;
        try {
            const thumbPath = await generateThumbnail(date, file, !isNaN(Number(atSeconds)) ? atSeconds : undefined);
            reply.header('Content-Type', 'image/jpeg');
            reply.header('Cache-Control', 'public, max-age=86400');
            return reply.send(fs.createReadStream(thumbPath));
        }
        catch {
            reply.header('Content-Type', 'image/svg+xml');
            reply.header('Cache-Control', 'no-store');
            return reply.send(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#1e293b"/><text x="50%" y="50%" fill="#64748b" font-family="sans-serif" font-size="14" dominant-baseline="middle" text-anchor="middle">Sin Miniatura</text></svg>`);
        }
    });
    // Export Clip
    protectedRoutes.post('/api/recordings/clip', async (req, reply) => {
        const schema = z.object({
            date: z.string(),
            file: z.string(),
            startSeconds: z.number().min(0),
            durationSeconds: z.number().min(1).max(3600),
        });
        const parse = schema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'Invalid clip parameters', details: parse.error.format() });
        }
        try {
            const { clipFileName } = await exportClip(parse.data.date, parse.data.file, parse.data.startSeconds, parse.data.durationSeconds);
            return { success: true, downloadUrl: `/api/clips/${clipFileName}` };
        }
        catch (err) {
            return reply.status(500).send({ error: err.message });
        }
    });
    // Download Clip
    protectedRoutes.get('/api/clips/:file', async (req, reply) => {
        const { file } = req.params;
        const clipPath = path.resolve(config.DATA_DIR, 'clips', file);
        if (!clipPath.startsWith(path.resolve(config.DATA_DIR, 'clips')) || !fs.existsSync(clipPath)) {
            return reply.status(404).send({ error: 'Clip not found' });
        }
        reply.header('Content-Type', 'video/mp4');
        reply.header('Content-Disposition', `attachment; filename="${file}"`);
        return reply.send(fs.createReadStream(clipPath));
    });
    // Delete Day Recordings
    protectedRoutes.delete('/api/recordings/:date', async (req, reply) => {
        const { date } = req.params;
        try {
            const result = deleteDay(date);
            if (!result) {
                return reply.status(404).send({ error: 'Recording day folder not found' });
            }
            return { success: true, date, ...result };
        }
        catch (err) {
            if (err instanceof ProtectedDayError || err?.statusCode === 409) {
                return reply.status(409).send({ error: err.message });
            }
            return reply.status(400).send({ error: err.message });
        }
    });
    // Delete Segment
    protectedRoutes.delete('/api/recordings/:date/:file', async (req, reply) => {
        const { date, file } = req.params;
        try {
            const deleted = deleteSegment(date, file);
            if (!deleted) {
                return reply.status(404).send({ error: 'Recording file not found' });
            }
            return { success: true };
        }
        catch (err) {
            return reply.status(400).send({ error: err.message });
        }
    });
    // ==========================================
    // DAY / NIGHT & LIGHT
    // ==========================================
    protectedRoutes.get('/api/daynight', async () => {
        return getDayNightState();
    });
    protectedRoutes.post('/api/daynight', async (_req, reply) => {
        return reply.status(501).send({
            error: 'El modo día/noche se infiere de la imagen; su conmutación física solo es posible desde la aplicación móvil EseeCloud.',
            state: getDayNightState(),
        });
    });
    protectedRoutes.get('/api/light', async () => {
        return getLightState();
    });
    protectedRoutes.post('/api/light', async (_req, reply) => {
        return reply.status(501).send({
            error: 'El control físico del modo día/noche (luz) solo puede realizarse desde la aplicación móvil EseeCloud; la cámara no admite conmutación por API local.',
            state: getLightState(),
        });
    });
    // ==========================================
    // MOTION DETECTION & EVENTS
    // ==========================================
    protectedRoutes.get('/api/motion/status', async () => {
        return getMotionEngine().getStatus();
    });
    protectedRoutes.get('/api/events', async (req) => {
        const { date, limit } = req.query;
        const max = limit ? parseInt(limit, 10) : 100;
        return getEvents(date, isNaN(max) ? 100 : max);
    });
    protectedRoutes.get('/api/events/:id/snapshot', async (req, reply) => {
        const { id } = req.params;
        const idNum = parseInt(id, 10);
        if (isNaN(idNum)) {
            return reply.status(400).send({ error: 'ID de evento inválido' });
        }
        const snap = getEventSnapshot(idNum);
        if (!snap) {
            return reply.status(404).send({ error: 'Captura no encontrada para este evento' });
        }
        reply.header('Content-Type', snap.contentType);
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(snap.buffer);
    });
    protectedRoutes.get('/api/events/:id/recording', async (req, reply) => {
        const { id } = req.params;
        const idNum = parseInt(id, 10);
        if (isNaN(idNum)) {
            return reply.status(400).send({ error: 'ID de evento inválido' });
        }
        const rec = getEventRecording(idNum);
        return { eventId: idNum, ...rec };
    });
    protectedRoutes.get('/api/timeline', async (req) => {
        const query = req.query;
        return getTimelineEvents({
            page: query.page ? parseInt(query.page, 10) : 1,
            limit: query.limit ? parseInt(query.limit, 10) : 20,
            sort: query.sort === 'desc' ? 'desc' : 'asc',
            date: query.date,
            search: query.search,
        });
    });
    // SSE Live Stream for Motion Events
    protectedRoutes.get('/api/events/live', async (req, reply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        const engine = getMotionEngine();
        const initialDayNight = getDayNightState();
        reply.raw.write(`data: ${JSON.stringify({ type: 'init', status: engine.getStatus(), daynight: initialDayNight })}\n\n`);
        const onStart = (event) => {
            try {
                reply.raw.write(`data: ${JSON.stringify({ type: 'motion_start', event })}\n\n`);
            }
            catch { }
        };
        const onActive = (data) => {
            try {
                reply.raw.write(`data: ${JSON.stringify({ type: 'motion_active', data })}\n\n`);
            }
            catch { }
        };
        const onEnd = (event) => {
            try {
                reply.raw.write(`data: ${JSON.stringify({ type: 'motion_end', event })}\n\n`);
            }
            catch { }
        };
        const onDayNightChange = (data) => {
            try {
                reply.raw.write(`data: ${JSON.stringify({ type: 'daynight_change', data })}\n\n`);
            }
            catch { }
        };
        engine.on('motion-start', onStart);
        engine.on('motion-active', onActive);
        engine.on('motion-end', onEnd);
        dayNightEvents.on('change', onDayNightChange);
        const keepalive = setInterval(() => {
            try {
                reply.raw.write(': ping\n\n');
            }
            catch { }
        }, 15000);
        req.raw.on('close', () => {
            clearInterval(keepalive);
            engine.off('motion-start', onStart);
            engine.off('motion-active', onActive);
            engine.off('motion-end', onEnd);
            dayNightEvents.off('change', onDayNightChange);
        });
        return reply;
    });
    // ==========================================
    // RECORDER MODES
    // ==========================================
    protectedRoutes.get('/api/recorder/mode', async () => {
        return getRecorderManager().getStatus();
    });
    protectedRoutes.post('/api/recorder/mode', async (req, reply) => {
        const schema = z.object({
            mode: z.enum(['continuous', 'motion', 'paused']),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Modo inválido. Valores permitidos: continuous, motion, paused' });
        }
        const status = await getRecorderManager().setMode(parsed.data.mode);
        return { success: true, status };
    });
    // Recorder Start / Stop
    protectedRoutes.post('/api/recorder/start', async () => {
        return startRecorder();
    });
    protectedRoutes.post('/api/recorder/stop', async () => {
        return stopRecorder();
    });
    // Storage and Retention
    protectedRoutes.get('/api/storage', async () => {
        return getStorageStats();
    });
    protectedRoutes.post('/api/retention/run', async () => {
        return runRetentionCycle();
    });
    // System Configuration (Camera IP, Recordings Directory, Retention)
    protectedRoutes.get('/api/config', async () => {
        return {
            cameraHost: config.CAMERA_HOST,
            cameraPort: config.CAMERA_PORT,
            cameraUser: config.CAMERA_USER,
            recordingsDir: config.RECORDINGS_DIR,
            retentionDays: config.RETENTION_DAYS,
        };
    });
    protectedRoutes.post('/api/config', async (req, reply) => {
        const schema = z.object({
            cameraHost: z.string().min(1),
            cameraPort: z.coerce.number().min(1).max(65535).default(80),
            recordingsDir: z.string().optional(),
            retentionDays: z.coerce.number().min(1).max(365).optional(),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Parámetros de configuración inválidos' });
        }
        const { cameraHost, cameraPort, recordingsDir, retentionDays } = parsed.data;
        return await updateCameraConfig(cameraHost, cameraPort, recordingsDir, retentionDays);
    });
    // Logs
    protectedRoutes.get('/api/logs', async (req) => {
        const { limit } = req.query;
        const max = limit ? parseInt(limit, 10) : 50;
        return getLogs(isNaN(max) ? 50 : max);
    });
});
// ==========================================
// 3. FRONTEND STATIC SERVING (PRODUCTION)
// ==========================================
let frontendDist = path.resolve(__dirname, '../../frontend/dist/frontend/browser');
if (!fs.existsSync(frontendDist)) {
    frontendDist = path.resolve(__dirname, '../../frontend/dist/frontend');
}
if (fs.existsSync(frontendDist)) {
    await fastify.register(fastifyStatic, {
        root: frontendDist,
        prefix: '/',
        setHeaders: (res, pathName) => {
            if (pathName.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
        },
    });
    fastify.setNotFoundHandler((req, reply) => {
        if (req.raw.url && req.raw.url.startsWith('/api')) {
            reply.status(404).send({ error: 'API route not found' });
        }
        else {
            reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
            reply.header('Pragma', 'no-cache');
            reply.header('Expires', '0');
            reply.sendFile('index.html');
        }
    });
}
else {
    fastify.get('/', async () => {
        return {
            message: 'C2L-Y-A NVR API is running',
            frontend: 'Frontend build not found in dist. Run npm run build in web/frontend.',
            docs: '/api/health',
        };
    });
}
// ==========================================
// 4. START SERVER
// ==========================================
export async function startServer() {
    closeOrphanedEvents();
    initRecordingsWatcher();
    initRetentionScheduler();
    startMotionEngine();
    startDayNightPoller();
    initRecorderManager();
    try {
        await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
        addLog('info', `NVR Backend listening on http://0.0.0.0:${config.PORT}`);
        console.log(`\n======================================================`);
        console.log(`🚀 C2L NVR Backend Server started on http://0.0.0.0:${config.PORT}`);
        console.log(`📡 go2rtc WebRTC/MSE available on ${config.GO2RTC_URL}`);
        console.log(`======================================================\n`);
    }
    catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}
// If invoked directly
if (process.argv[1] && process.argv[1].endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
    startServer();
}
