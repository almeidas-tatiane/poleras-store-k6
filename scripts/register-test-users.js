// One-off helper for PT-21 P1 fix: registers users.json entries against the live users-api
// so cart.test.js stress runs don't hit 401s for VUs beyond the previous 400-user dataset.
const BASE_URL = process.env.BASE_URL_AUTH || 'http://localhost:3001';
const FROM = parseInt(process.argv[2] || '401', 10);
const TO = parseInt(process.argv[3] || '2000', 10);
const CONCURRENCY = 20;

async function register(i) {
  const email = `user${i}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstname: 'Test',
      lastname: `User${i}`,
      email,
      password: 'Test1234!',
    }),
  });
  if (res.status === 201 || res.status === 409) return { i, status: res.status };
  const body = await res.text();
  return { i, status: res.status, body };
}

async function main() {
  const indices = [];
  for (let i = FROM; i <= TO; i++) indices.push(i);

  let created = 0, existing = 0, failed = 0;
  for (let start = 0; start < indices.length; start += CONCURRENCY) {
    const batch = indices.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map(register));
    for (const r of results) {
      if (r.status === 201) created++;
      else if (r.status === 409) existing++;
      else { failed++; console.error(`user${r.i}@test.com -> ${r.status} ${r.body}`); }
    }
  }
  console.log(`Done. created=${created} existing=${existing} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
