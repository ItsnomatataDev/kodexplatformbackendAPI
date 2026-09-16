import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { generateOpaqueToken } from './opaque-token.js';

export const REFRESH_COOKIE = 'kode_refresh';
export const CSRF_COOKIE = 'kode_csrf';

export type CookieSettings = {
  secure: boolean;
  refreshMaxAgeSeconds: number;
};

export function setAuthCookies(
  c: Context,
  refreshToken: string,
  settings: CookieSettings,
) {
  setCookie(c, REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: settings.refreshMaxAgeSeconds,
  });

  setCookie(c, CSRF_COOKIE, generateOpaqueToken(), {
    httpOnly: false,
    secure: settings.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: settings.refreshMaxAgeSeconds,
  });
}

export function clearAuthCookies(c: Context, settings: CookieSettings) {
  deleteCookie(c, REFRESH_COOKIE, {
    path: '/auth',
    secure: settings.secure,
  });
  deleteCookie(c, CSRF_COOKIE, {
    path: '/',
    secure: settings.secure,
  });
}

export function readRefreshToken(c: Context, bodyToken?: string): string | undefined {
  return bodyToken || getCookie(c, REFRESH_COOKIE);
}
