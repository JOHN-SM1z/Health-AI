/** Synthetic pilot fixtures and local app runner. Never accepts a hosted URL.
 * Usage: node scripts/pilot-local.mjs /private/tmp/local-status.json /private/tmp/fixtures.json [serve]
 * Obtain status privately: supabase status --workdir <isolated-stack> -o json > <status.json>
 * Fixture files contain generated credentials. Keep them outside the repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
(async () => {
  const [statusFile, fixtureFile, mode] = process.argv.slice(2);
  if (!statusFile || !fixtureFile) throw Error('Status and private fixture paths required');
  const relative = path.relative(process.cwd(), path.resolve(fixtureFile));
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw Error('Credentials must be stored outside the repository');
  if (!mode && fs.existsSync(fixtureFile)) throw Error('Choose a new private fixture file');
  const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  const url = new URL(s.API_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Only disposable loopback stacks are allowed');
  const env = { ...process.env, SUPABASE_URL: s.API_URL, NEXT_PUBLIC_SUPABASE_URL: s.API_URL, SUPABASE_ANON_KEY: s.ANON_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY: s.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY, PAYMENT_PROVIDER: 'manual' };
  if (mode === 'serve') {
    const result = spawnSync('npm', ['run', 'dev', '--', '--webpack', '--port', '3105'], { env, stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
  if (mode === 'test') {
    const result = spawnSync('npm', ['test'], { env, stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
  const db = createClient(s.API_URL, s.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  async function one(table, value) {
    const { data, error } = await db.from(table).insert(value).select().single();
    if (error) throw Error(`${table} fixture failed (${error.code})`);
    return data;
  }
  const clinic = await one('clinics', { name: 'Synthetic Pilot Clinic', slug: `browser-${randomUUID()}`, timezone: 'Asia/Tashkent' });
  const users = {};
  for (const role of ['owner', 'receptionist', 'doctor']) {
    const email = `${role}-${randomUUID()}@example.test`, password = randomUUID() + randomUUID();
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw Error('Synthetic auth fixture failed');
    const id = data.user.id;
    const profile = await db.from('profiles').upsert({ id, full_name: `Synthetic ${role}` });
    if (profile.error) throw Error('Synthetic profile fixture failed');
    await one('staff_roles', { clinic_id: clinic.id, profile_id: id, role });
    users[role] = { id, email, password };
  }
  const doctor = await one('doctors', { clinic_id: clinic.id, profile_id: users.doctor.id, name: 'Synthetic Doctor', active: true });
  const service = await one('services', { clinic_id: clinic.id, name: 'Synthetic Consultation', price: 100000, duration_minutes: 30, active: true });
  const patient = await one('patients', { clinic_id: clinic.id, full_name: 'Synthetic Pilot Patient', phone: '+998900001234' });
  fs.writeFileSync(fixtureFile, JSON.stringify({ clinic, doctor, service, patient, users }), { mode: 0o600, flag: 'wx' });
  console.log('Synthetic fixture created; credentials saved privately.');
})().catch(e => { console.error(e.message); process.exit(1); });
