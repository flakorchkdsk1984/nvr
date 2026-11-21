import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
const COOKIE_NAME = 'nvr_token';
export async function verifyUserCredentials(username, pass) {
    if (username !== config.AUTH_USER) {
        return false;
    }
    return bcrypt.compare(pass, config.AUTH_PASS_HASH);
}
export function createToken(username) {
    return jwt.sign({ user: username }, config.JWT_SECRET, { expiresIn: '7d' });
}
export function verifyToken(token) {
    try {
        return jwt.verify(token, config.JWT_SECRET);
    }
    catch {
        return null;
    }
}
export async function requireAuth(req, reply) {
    const cookieToken = req.cookies[COOKIE_NAME];
    let token = cookieToken;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
        token = req.headers.authorization.substring(7);
    }
    if (!token) {
        reply.status(401).send({ error: 'Unauthorized: missing authentication token' });
        return;
    }
    const payload = verifyToken(token);
    if (!payload || payload.user !== config.AUTH_USER) {
        reply.status(401).send({ error: 'Unauthorized: invalid or expired session' });
        return;
    }
    // Attach user to request
    req.user = payload.user;
}
export const AUTH_COOKIE_OPTS = {
    path: '/',
    httpOnly: true,
    secure: false, // Local LAN
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600, // 7 days in seconds
};
