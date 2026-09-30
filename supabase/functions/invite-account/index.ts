import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json' },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'Account invitations are not configured.' }, 503);

  const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return json({ error: 'Please sign in again.' }, 401);

  const callerClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: identity, error: identityError } = await callerClient.auth.getUser(bearer);
  if (identityError || !identity.user) return json({ error: 'Please sign in again.' }, 401);

  const adminClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: caller, error: callerError } = await adminClient.from('profiles')
    .select('role').eq('id', identity.user.id).single();
  if (callerError || caller?.role !== 'admin') return json({ error: 'Only centre admins can invite accounts.' }, 403);

  let input: unknown;
  try { input = await request.json(); }
  catch { return json({ error: 'Invalid invitation details.' }, 400); }
  if (!input || typeof input !== 'object') return json({ error: 'Invalid invitation details.' }, 400);
  const values = input as Record<string, unknown>;
  const email = typeof values.email === 'string' ? values.email.trim().toLowerCase() : '';
  const displayName = typeof values.displayName === 'string' ? values.displayName.trim() : '';
  const role = values.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      displayName.length < 2 || displayName.length > 100 ||
      (role !== 'student' && role !== 'teacher')) {
    return json({ error: 'Enter a valid name, email, and student or teacher role.' }, 400);
  }

  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { display_name: displayName },
  });
  if (inviteError || !invited.user) return json({ error: inviteError?.message ?? 'Could not send the invitation.' }, 400);

  const { error: profileError } = await adminClient.from('profiles').update({ display_name: displayName, role })
    .eq('id', invited.user.id).select('id').single();
  if (profileError) {
    await adminClient.auth.admin.deleteUser(invited.user.id);
    return json({ error: 'The account could not be assigned its role. Please try again.' }, 500);
  }

  return json({ message: `Invitation sent to ${email}.` });
});
