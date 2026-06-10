import http from 'k6/http';
import { check } from 'k6';

/**
 * Calls POST /api/auth/login and returns the JWT token.
 * Reusable by cart, orders, and payments scripts (PT-10, PT-11, PT-12).
 *
 * @param {string} baseUrl - e.g. 'http://localhost:3001'
 * @param {string} email
 * @param {string} password
 * @returns {string|null} JWT token or null if login failed
 */
export function getAuthToken(baseUrl, email, password) {
  const res = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({ email, password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags:    { service: 'auth' },
    }
  );

  check(res, { 'auth: login ok': (r) => r.status === 200 });

  return res.json('data.token');
}
