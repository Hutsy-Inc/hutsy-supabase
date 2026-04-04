import { createClient } from "npm:@supabase/supabase-js";
// ---------------------------------------------------------------------------
// CORS + response helpers
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function ok(data, status = 200) {
  return new Response(JSON.stringify({
    ok: true,
    ...data
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function err(message, status = 400, extra) {
  return new Response(JSON.stringify({
    ok: false,
    error: message,
    ...extra
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
function getEnv() {
  const ARRAY_APP_KEY = Deno.env.get('ARRAY_APP_KEY') ?? '';
  const ARRAY_API_BASE = (Deno.env.get('ARRAY_API_BASE') ?? '').replace(/\/$/, '');
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  return {
    ARRAY_APP_KEY,
    ARRAY_API_BASE,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY
  };
}
// ---------------------------------------------------------------------------
// Supabase clients
// ---------------------------------------------------------------------------
function adminClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getEnv();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
async function getUserIdFromBearer(req) {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    throw Object.assign(new Error('Missing bearer token'), {
      status: 401
    });
  }
  const token = auth.slice(7).trim();
  if (!token) throw Object.assign(new Error('Missing bearer token'), {
    status: 401
  });
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = getEnv();
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user?.id) throw Object.assign(new Error('Invalid auth token'), {
    status: 401
  });
  return user.id;
}
async function sbOne(table, match) {
  const db = adminClient();
  let q = db.from(table).select('*');
  for (const [k, v] of Object.entries(match))q = q.eq(k, v);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) {
    console.error(`[array] sbOne ${table}`, error);
    return null;
  }
  return data;
}
async function sbAll(table, match, opts) {
  const db = adminClient();
  let q = db.from(table).select('*');
  for (const [k, v] of Object.entries(match))q = q.eq(k, v);
  if (opts?.order) q = q.order(opts.order.column, {
    ascending: !(opts.order.desc ?? false)
  });
  if (opts?.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) {
    console.error(`[array] sbAll ${table}`, error);
    return [];
  }
  return data ?? [];
}
// ---------------------------------------------------------------------------
// Small type helpers (mirrors Python _to_int / _to_num / _clean_str)
// ---------------------------------------------------------------------------
function toInt(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Math.trunc(val);
  const s = String(val).trim();
  if (!s || s.toUpperCase() === 'N/A') return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}
function toNum(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  const s = String(val).trim();
  if (!s || s.toUpperCase() === 'N/A') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function cleanStr(val) {
  return String(val ?? '').trim();
}
function digitsOnly(val) {
  return String(val ?? '').replace(/\D/g, '');
}
function normalizePhone(val) {
  let s = cleanStr(val);
  if (!s) return '';
  s = s.replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) return s;
  const digits = digitsOnly(s);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return s;
}
// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------
function calcScoreBucket(score, bucket) {
  const b = cleanStr(bucket);
  if (b) return b;
  if (score === null) return null;
  if (score < 580) return 'poor';
  if (score < 670) return 'fair';
  if (score < 740) return 'good';
  if (score < 800) return 'very_good';
  return 'excellent';
}
function calcRiskTier(score) {
  if (score === null) return null;
  if (score < 580) return 'high_risk';
  if (score < 670) return 'elevated_risk';
  if (score < 740) return 'moderate_risk';
  return 'low_risk';
}
function validateBootstrapPayload(data) {
  const firstName = cleanStr(data['first_name']);
  const lastName = cleanStr(data['last_name']);
  const dob = cleanStr(data['dob']);
  const ssn = digitsOnly(data['ssn']);
  const email = cleanStr(data['email']).toLowerCase();
  const phone = normalizePhone(data['phone']);
  const addr = typeof data['address'] === 'object' && data['address'] !== null ? data['address'] : {};
  const street = cleanStr(addr['street']);
  const city = cleanStr(addr['city']);
  const state = cleanStr(addr['state']);
  const zipCode = cleanStr(addr['zip']);
  const country = cleanStr(addr['country']) || 'US';
  const missing = [];
  if (!firstName) missing.push('first_name');
  if (!lastName) missing.push('last_name');
  if (!dob) missing.push('dob');
  if (!ssn) missing.push('ssn');
  if (!email) missing.push('email');
  if (!phone) missing.push('phone');
  if (!street) missing.push('address.street');
  if (!city) missing.push('address.city');
  if (!state) missing.push('address.state');
  if (!zipCode) missing.push('address.zip');
  if (missing.length) {
    const e = Object.assign(new Error('missing_required_fields'), {
      status: 400,
      fields: missing
    });
    throw e;
  }
  return {
    first_name: firstName,
    last_name: lastName,
    dob,
    ssn,
    email,
    phone,
    address: {
      street,
      city,
      state,
      zip: zipCode,
      country
    }
  };
}
// ---------------------------------------------------------------------------
// Array API helpers
// ---------------------------------------------------------------------------
function extractArrayUserId(obj) {
  return cleanStr(obj['userId'] ?? obj['user_id'] ?? obj['userUuid'] ?? obj['array_user_id']);
}
function extractArrayAuthToken(obj) {
  return cleanStr(obj['authToken'] ?? obj['userToken'] ?? obj['user_token'] ?? obj['token']);
}
function extractVerificationHeaders(headers) {
  return {
    x_array_auth_efx_error: headers.get('x-array-auth-efx-error') ?? '',
    x_array_auth_exp_error: headers.get('x-array-auth-exp-error') ?? '',
    x_array_auth_tui_error: headers.get('x-array-auth-tui-error') ?? ''
  };
}
function questionTexts(questions) {
  if (!Array.isArray(questions)) return '';
  return questions.filter((q)=>typeof q === 'object' && q !== null).map((q)=>String(q['text'] ?? '')).join(' | ').toLowerCase();
}
function normalizeVerificationAuthMethod(rawAuthMethod, provider, questions) {
  const authMethod = cleanStr(rawAuthMethod).toLowerCase();
  const providerS = cleanStr(provider).toLowerCase();
  const questionsList = Array.isArray(questions) ? questions : [];
  const qText = questionTexts(questionsList);
  if ([
    'otp',
    'kba',
    'smfa'
  ].includes(authMethod)) return authMethod;
  if ([
    'exp',
    'efx'
  ].includes(providerS)) return 'kba';
  if (providerS === 'tui') {
    if (qText.includes('passcode') || qText.includes('text message') || qText.includes('voice call')) {
      return 'otp';
    }
  }
  if (questionsList.length > 1) return 'kba';
  if (qText.includes('passcode') || qText.includes('text message') || qText.includes('voice call')) {
    return 'otp';
  }
  return authMethod || null;
}
async function arrayRetrieveByArrayId(arrayUserId) {
  if (!arrayUserId) return [
    false,
    {}
  ];
  const { ARRAY_APP_KEY, ARRAY_API_BASE } = getEnv();
  const url = `${ARRAY_API_BASE}/api/user/v2?appKey=${encodeURIComponent(ARRAY_APP_KEY)}&userId=${encodeURIComponent(arrayUserId)}`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(25_000)
    });
    console.log(`🔎 [array bootstrap] retrieve by array_user_id status=${resp.status}`);
    if (resp.status === 200) {
      try {
        return [
          true,
          await resp.json()
        ];
      } catch  {
        return [
          true,
          {}
        ];
      }
    }
    return [
      false,
      {}
    ];
  } catch (e) {
    console.error(`❌ [array bootstrap] retrieve by array_user_id failed:`, e);
    return [
      false,
      {}
    ];
  }
}
async function arrayRetrieveByIdentity(payload) {
  const { ARRAY_APP_KEY, ARRAY_API_BASE } = getEnv();
  const params = new URLSearchParams({
    appKey: ARRAY_APP_KEY,
    firstName: payload.first_name,
    lastName: payload.last_name,
    dob: payload.dob,
    emailAddress: payload.email,
    phoneNumber: payload.phone,
    'address.street': payload.address.street,
    'address.city': payload.address.city,
    'address.state': payload.address.state,
    'address.zip': payload.address.zip
  });
  try {
    const resp = await fetch(`${ARRAY_API_BASE}/api/user/v2?${params}`, {
      signal: AbortSignal.timeout(25_000)
    });
    console.log(`🔎 [array bootstrap] retrieve by identity status=${resp.status}`);
    if (resp.status === 200) {
      try {
        return [
          true,
          await resp.json()
        ];
      } catch  {
        return [
          true,
          {}
        ];
      }
    }
    return [
      false,
      {}
    ];
  } catch (e) {
    console.error(`❌ [array bootstrap] retrieve by identity failed:`, e);
    return [
      false,
      {}
    ];
  }
}
async function arrayCreateUser(payload, hutsyUserId) {
  const { ARRAY_APP_KEY, ARRAY_API_BASE } = getEnv();
  const body = {
    appKey: ARRAY_APP_KEY,
    userId: hutsyUserId,
    firstName: payload.first_name,
    lastName: payload.last_name,
    dob: payload.dob,
    ssn: payload.ssn,
    emailAddress: payload.email,
    phoneNumber: payload.phone,
    address: {
      street: payload.address.street,
      city: payload.address.city,
      state: payload.address.state,
      zip: payload.address.zip,
      country: payload.address.country
    },
    language: 'en-US',
    metadata: {
      hutsy_user_id: hutsyUserId
    }
  };
  const resp = await fetch(`${ARRAY_API_BASE}/api/user/v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  console.log(`🆕 [array bootstrap] create user status=${resp.status}`);
  if (![
    200,
    201
  ].includes(resp.status)) {
    const raw = await resp.text();
    console.error(`❌ [array bootstrap] create user failed body=${raw}`);
    throw Object.assign(new Error('array_create_user_failed'), {
      status: 400,
      detail: {
        error: 'array_create_user_failed',
        status_code: resp.status,
        body: raw
      }
    });
  }
  try {
    return await resp.json();
  } catch  {
    return {};
  }
}
function upsertArrayIdentityMapping(userId, arrayUserId, userToken) {
  if (!userId || !arrayUserId) return;
  const db = adminClient();
  const payload = {
    user_id: String(userId),
    array_user_id: String(arrayUserId),
    updated_at: new Date().toISOString()
  };
  const clean = cleanStr(userToken);
  if (clean) {
    payload['last_user_token'] = clean;
    payload['last_user_token_at'] = Math.floor(Date.now() / 1000);
  }
  db.from('array_identities').upsert(payload, {
    onConflict: 'user_id'
  }).then(({ error })=>{
    if (error) console.error('[array] upsertArrayIdentityMapping error:', error);
  });
}
function getArrayUserIdForHutsyUser(ident) {
  if (!ident || !ident['array_user_id']) {
    throw Object.assign(new Error('array_identity_not_found'), {
      status: 400,
      detail: {
        error: 'array_identity_not_found',
        message: 'Array identity mapping not found for this user.'
      }
    });
  }
  return String(ident['array_user_id']);
}
// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
/** action: bootstrap */ async function handleBootstrap(req, body) {
  const hutsyUserId = await getUserIdFromBearer(req);
  const data = body;
  let payload;
  try {
    payload = validateBootstrapPayload(data);
  } catch (e) {
    const ex = e;
    return err(ex.message, 400, ex.fields ? {
      fields: ex.fields
    } : undefined);
  }
  console.log(`🚀 [array bootstrap] start user_id=${hutsyUserId}`);
  // 1) existing local mapping?
  const ident = await sbOne('array_identities', {
    user_id: hutsyUserId
  });
  if (ident?.array_user_id) {
    const existingArrayUserId = String(ident['array_user_id']);
    console.log(`ℹ️ [array bootstrap] found local mapping array_user_id=${existingArrayUserId}`);
    const [found, retrieved] = await arrayRetrieveByArrayId(existingArrayUserId);
    if (found) {
      const arrayUserId = extractArrayUserId(retrieved) || existingArrayUserId;
      const authToken = extractArrayAuthToken(retrieved);
      upsertArrayIdentityMapping(hutsyUserId, arrayUserId, authToken || undefined);
      return ok({
        exists_on_array: true,
        created_new_array_user: false,
        array_user_id: arrayUserId,
        next_step: 'start_verification',
        retrieve_source: 'local_mapping',
        array_user: retrieved
      });
    }
    console.warn('⚠️ [array bootstrap] local mapping exists but retrieve failed');
  }
  // 2) try retrieve by identity
  const [found2, retrieved2] = await arrayRetrieveByIdentity(payload);
  if (found2) {
    const arrayUserId = extractArrayUserId(retrieved2);
    if (!arrayUserId) {
      return err('array_retrieve_missing_user_id', 400, {
        body: retrieved2
      });
    }
    const authToken = extractArrayAuthToken(retrieved2);
    upsertArrayIdentityMapping(hutsyUserId, arrayUserId, authToken || undefined);
    console.log(`✅ [array bootstrap] found existing array user by identity array_user_id=${arrayUserId}`);
    return ok({
      exists_on_array: true,
      created_new_array_user: false,
      array_user_id: arrayUserId,
      next_step: 'start_verification',
      retrieve_source: 'identity',
      array_user: retrieved2
    });
  }
  // 3) create new user
  let created;
  try {
    created = await arrayCreateUser(payload, hutsyUserId);
  } catch (e) {
    const ex = e;
    const detail = ex.detail ?? {};
    const statusCode = Number(detail['status_code'] ?? 0);
    // If Array says conflict, user most likely already exists there with userId = hutsyUserId.
    if (ex.message === 'array_create_user_failed' && statusCode === 409) {
      console.warn(`⚠️ [array bootstrap] create returned 409, trying recovery by userId=${hutsyUserId}`);
      const [foundByUserId, recoveredByUserId] = await arrayRetrieveByArrayId(hutsyUserId);
      if (foundByUserId) {
        const recoveredArrayUserId = extractArrayUserId(recoveredByUserId) || hutsyUserId;
        const recoveredAuthToken = extractArrayAuthToken(recoveredByUserId);
        upsertArrayIdentityMapping(hutsyUserId, recoveredArrayUserId, recoveredAuthToken || undefined);
        console.log(`✅ [array bootstrap] recovered existing array user after 409 by userId array_user_id=${recoveredArrayUserId}`);
        return ok({
          exists_on_array: true,
          created_new_array_user: false,
          recovered_after_conflict: true,
          array_user_id: recoveredArrayUserId,
          next_step: 'start_verification',
          retrieve_source: 'conflict_user_id',
          array_user: recoveredByUserId
        });
      }
      // fallback: try identity one more time
      const [foundByIdentity, recoveredByIdentity] = await arrayRetrieveByIdentity(payload);
      if (foundByIdentity) {
        const recoveredArrayUserId = extractArrayUserId(recoveredByIdentity);
        if (!recoveredArrayUserId) {
          return err('array_create_conflict_recovery_missing_user_id', 400, {
            original_error: detail,
            recovered_body: recoveredByIdentity
          });
        }
        const recoveredAuthToken = extractArrayAuthToken(recoveredByIdentity);
        upsertArrayIdentityMapping(hutsyUserId, recoveredArrayUserId, recoveredAuthToken || undefined);
        console.log(`✅ [array bootstrap] recovered existing array user after 409 by identity array_user_id=${recoveredArrayUserId}`);
        return ok({
          exists_on_array: true,
          created_new_array_user: false,
          recovered_after_conflict: true,
          array_user_id: recoveredArrayUserId,
          next_step: 'start_verification',
          retrieve_source: 'conflict_identity',
          array_user: recoveredByIdentity
        });
      }
      console.warn(`⚠️ [array bootstrap] conflict recovery retrieve failed, falling back to hutsy user id as array_user_id=${hutsyUserId}`);
      upsertArrayIdentityMapping(hutsyUserId, hutsyUserId);
      return ok({
        exists_on_array: true,
        created_new_array_user: false,
        recovered_after_conflict: true,
        recovery_mode: 'assume_user_id',
        array_user_id: hutsyUserId,
        next_step: 'start_verification',
        array_user: {
          userId: hutsyUserId
        }
      });
    }
    return err(ex.message, 400, detail);
  }
  const arrayUserId = extractArrayUserId(created);
  if (!arrayUserId) {
    return err('array_create_missing_user_id', 400, {
      body: created
    });
  }
  const authToken = extractArrayAuthToken(created);
  upsertArrayIdentityMapping(hutsyUserId, arrayUserId, authToken || undefined);
  console.log(`✅ [array bootstrap] created new array user array_user_id=${arrayUserId}`);
  return ok({
    exists_on_array: false,
    created_new_array_user: true,
    array_user_id: arrayUserId,
    next_step: 'start_verification',
    array_user: created
  });
}
/** action: verification_start */ async function handleVerificationStart(req) {
  const hutsyUserId = await getUserIdFromBearer(req);
  const ident = await sbOne('array_identities', {
    user_id: hutsyUserId
  });
  const arrayUserId = getArrayUserIdForHutsyUser(ident);
  const { ARRAY_APP_KEY, ARRAY_API_BASE } = getEnv();
  const params = new URLSearchParams({
    appKey: ARRAY_APP_KEY,
    userId: arrayUserId,
    provider1: 'tui',
    provider2: 'efx',
    provider3: 'exp'
  });
  console.log(`🚀 [array verification start] hutsy_user_id=${hutsyUserId} array_user_id=${arrayUserId}`);
  const resp = await fetch(`${ARRAY_API_BASE}/api/authenticate/v2?${params}`, {
    headers: {
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(30_000)
  });
  const rawText = await resp.text();
  console.log(`🚀 [array verification start] status=${resp.status} body=${rawText}`);
  const verificationHeaders = extractVerificationHeaders(resp.headers);
  if (resp.status === 200) {
    let body = {};
    try {
      body = JSON.parse(rawText);
    } catch  {}
    const questions = body['questions'] ?? [];
    const provider = body['provider'];
    const authMethod = normalizeVerificationAuthMethod(body['authMethod'], provider, questions);
    console.log(`🚀 [array verification start] normalized auth_method=${authMethod} provider=${provider} questions=${questions.length}`);
    return ok({
      array_user_id: arrayUserId,
      auth_method: authMethod,
      provider,
      auth_token: body['authToken'],
      questions,
      verification_headers: verificationHeaders,
      raw: body
    });
  }
  if (resp.status === 204) {
    return err('array_verification_no_questions', 400, {
      status_code: resp.status,
      headers: verificationHeaders,
      body: rawText
    });
  }
  return err('array_verification_start_failed', 400, {
    status_code: resp.status,
    headers: verificationHeaders,
    body: rawText
  });
}
/** action: verification_continue */ async function handleVerificationContinue(req, body) {
  const hutsyUserId = await getUserIdFromBearer(req);
  const ident = await sbOne('array_identities', {
    user_id: hutsyUserId
  });
  const arrayUserId = getArrayUserIdForHutsyUser(ident);
  const data = body;
  const authToken = cleanStr(data['auth_token']);
  const answers = typeof data['answers'] === 'object' && data['answers'] !== null ? data['answers'] : {};
  const authPin = cleanStr(data['auth_pin']);
  if (!authToken) return err('missing_auth_token', 400);
  if (!Object.keys(answers).length) return err('missing_answers', 400);
  const { ARRAY_APP_KEY, ARRAY_API_BASE } = getEnv();
  const reqBody = {
    appKey: ARRAY_APP_KEY,
    userId: arrayUserId,
    authToken,
    answers
  };
  if (authPin) reqBody['authPin'] = authPin;
  console.log(`➡️ [array verification continue] hutsy_user_id=${hutsyUserId} array_user_id=${arrayUserId}`);
  const resp = await fetch(`${ARRAY_API_BASE}/api/authenticate/v2`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(30_000)
  });
  const rawText = await resp.text();
  console.log(`➡️ [array verification continue] status=${resp.status} body=${rawText}`);
  const verificationHeaders = extractVerificationHeaders(resp.headers);
  let parsedBody = {};
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch  {}
  }
  // 200 = verified
  if (resp.status === 200) {
    const userToken = cleanStr(parsedBody['userToken']);
    if (userToken) upsertArrayIdentityMapping(hutsyUserId, arrayUserId, userToken);
    return ok({
      status_code: resp.status,
      verified: true,
      pending: false,
      needs_more_questions: false,
      array_user_id: arrayUserId,
      user_token: userToken,
      verification_headers: verificationHeaders,
      raw: parsedBody
    });
  }
  // 202 = SMFA pending
  if (resp.status === 202) {
    return ok({
      status_code: resp.status,
      verified: false,
      pending: true,
      needs_more_questions: false,
      array_user_id: arrayUserId,
      verification_headers: verificationHeaders,
      raw: parsedBody
    });
  }
  // 206 = more questions / OTP passcode step / KBA fallback
  if (resp.status === 206) {
    const questions = parsedBody['questions'] ?? [];
    const provider = parsedBody['provider'];
    const normalizedAuthMethod = normalizeVerificationAuthMethod(parsedBody['authMethod'], provider, questions);
    console.log(`➡️ [array verification continue] normalized auth_method=${normalizedAuthMethod} provider=${provider} questions=${questions.length}`);
    return ok({
      status_code: resp.status,
      verified: false,
      pending: false,
      needs_more_questions: true,
      array_user_id: arrayUserId,
      auth_method: normalizedAuthMethod,
      provider,
      auth_token: parsedBody['authToken'] ?? authToken,
      questions,
      verification_headers: verificationHeaders,
      raw: parsedBody
    });
  }
  return err('array_verification_continue_failed', 400, {
    status_code: resp.status,
    headers: verificationHeaders,
    body: rawText
  });
}
/** action: report_order */ async function handleReportOrder(req, body) {
  const hutsyUserId = await getUserIdFromBearer(req);
  const ident = await sbOne('array_identities', {
    user_id: hutsyUserId
  });
  if (!ident) return err('array_identity_not_found', 400);
  const arrayUserId = cleanStr(ident['array_user_id']);
  const userToken = cleanStr(ident['last_user_token'] ?? ident['user_token']);
  if (!arrayUserId) return err('missing_array_user_id', 400);
  if (!userToken) return err('missing_array_user_token', 400);
  const productCode = cleanStr(body['product_code']) || 'exp1bReportScore';
  const { ARRAY_API_BASE } = getEnv();
  const reqBody = {
    userId: arrayUserId,
    productCode
  };
  console.log(`📄 [array report order] hutsy_user_id=${hutsyUserId} array_user_id=${arrayUserId} product_code=${productCode}`);
  const resp = await fetch(`${ARRAY_API_BASE}/api/report/v2`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-array-user-token': userToken
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(30_000)
  });
  const rawText = await resp.text();
  console.log(`📄 [array report order] status=${resp.status} body=${rawText}`);
  let parsedBody = {};
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch  {}
  }
  if ([
    200,
    201,
    202,
    204
  ].includes(resp.status)) {
    return ok({
      ordered: true,
      array_user_id: arrayUserId,
      product_code: productCode,
      status_code: resp.status,
      raw: Object.keys(parsedBody).length ? parsedBody : rawText
    });
  }
  return err('array_report_order_failed', 400, {
    status_code: resp.status,
    body: rawText
  });
}
/** action: report_status */ async function handleReportStatus(req) {
  const hutsyUserId = await getUserIdFromBearer(req);
  const rows = await sbAll('credit_reports', {
    user_id: hutsyUserId
  }, {
    order: {
      column: 'pulled_at',
      desc: true
    },
    limit: 1
  });
  if (!rows.length) return ok({
    has_report: false,
    report: null
  });
  const latest = rows[0];
  return ok({
    has_report: true,
    report: {
      id: latest['id'],
      user_id: latest['user_id'],
      provider: latest['provider'],
      credit_score: latest['credit_score'],
      bureau: latest['bureau'],
      product_code: latest['product_code'],
      report_key: latest['report_key'],
      score_model: latest['score_model'],
      score_bucket: latest['score_bucket'],
      risk_tier: latest['risk_tier'],
      pulled_at: latest['pulled_at'],
      created_at: latest['created_at']
    }
  });
}
/** action: array_token */ async function handleArrayToken(_req, data) {
  const userId = cleanStr(data['user_id']);
  const arrayUserId = cleanStr(data['array_user_id']);
  const userToken = cleanStr(data['user_token']);
  if (!userId || !arrayUserId || !userToken) {
    return new Response(JSON.stringify({
      ok: false
    }), {
      headers: CORS
    });
  }
  const db = adminClient();
  const nowTs = Math.floor(Date.now() / 1000);
  const { error } = await db.from('array_identities').upsert({
    user_id: userId,
    array_user_id: arrayUserId,
    last_user_token: userToken,
    last_user_token_at: nowTs,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'user_id'
  });
  if (error) console.error('[array] handleArrayToken upsert error:', error);
  return new Response(JSON.stringify({
    ok: true
  }), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
/** action: array_webhook */ async function handleArrayWebhook(_req, data) {
  console.log(`📥 [array webhook] payload=${JSON.stringify(data)}`);
  const service = cleanStr(data['service']);
  const method = cleanStr(data['method']).toLowerCase();
  const path = cleanStr(data['path']);
  const details = typeof data['details'] === 'object' && data['details'] !== null ? data['details'] : {};
  console.log(`📥 [array webhook] gate check service=${service} method=${method} path=${path}`);
  if (service !== 'report') return new Response(JSON.stringify({
    ok: true
  }), {
    headers: CORS
  });
  if (path !== '/api/report/v2') return new Response(JSON.stringify({
    ok: true
  }), {
    headers: CORS
  });
  const arrayUserId = cleanStr(data['array_user_id'] ?? data['userId'] ?? data['user_id'] ?? details['userId'] ?? details['user_id']);
  console.log(`📥 [array webhook] resolved array_user_id=${arrayUserId}`);
  if (!arrayUserId) return new Response(JSON.stringify({
    ok: false
  }), {
    headers: CORS
  });
  const ident = await sbOne('array_identities', {
    array_user_id: arrayUserId
  });
  if (!ident) return new Response(JSON.stringify({
    ok: false
  }), {
    headers: CORS
  });
  const userId = String(ident['user_id']);
  const userToken = cleanStr(ident['last_user_token'] ?? ident['user_token']);
  const displayToken = cleanStr(details['displayToken']);
  const reportKey = cleanStr(details['reportKey']);
  const productCode = cleanStr(details['productCode']);
  const { ARRAY_APP_KEY, ARRAY_API_BASE } = getEnv();
  if (!displayToken || !reportKey || !userToken || !ARRAY_APP_KEY) {
    return new Response(JSON.stringify({
      ok: false
    }), {
      headers: CORS
    });
  }
  // idempotency guard
  const already = await sbOne('credit_reports', {
    user_id: userId,
    provider: 'array',
    report_key: reportKey
  });
  if (already) return new Response(JSON.stringify({
    ok: true
  }), {
    headers: CORS
  });
  // previous score (for delta)
  const existingFinance = await sbAll('finance_snapshots', {
    user_id: userId
  }, {
    order: {
      column: 'created_at',
      desc: true
    },
    limit: 1
  });
  const prevScore = existingFinance.length ? toInt(existingFinance[0]['credit_score']) : null;
  // fetch full report from Array (retry up to 10x with 2s delay for 202)
  let reportPayload = null;
  let lastStatus = null;
  let lastBody = '';
  for(let attempt = 1; attempt <= 10; attempt++){
    const params = new URLSearchParams({
      appKey: ARRAY_APP_KEY,
      displayToken,
      reportKey
    });
    const resp = await fetch(`${ARRAY_API_BASE}/api/report/v2?${params}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-user-token': userToken
      },
      signal: AbortSignal.timeout(30_000)
    });
    lastStatus = resp.status;
    lastBody = await resp.text();
    console.log(`📥 [array webhook] fetch attempt=${attempt} report_key=${reportKey} status=${resp.status} body=${lastBody.slice(0, 500)}`);
    if (resp.status === 200) {
      try {
        reportPayload = JSON.parse(lastBody);
      } catch  {
        reportPayload = {};
      }
      break;
    }
    if (resp.status === 202) {
      await new Promise((r)=>setTimeout(r, 2000));
      continue;
    }
    console.error(`❌ [array webhook] report fetch failed status=${resp.status} body=${lastBody}`);
    return new Response(JSON.stringify({
      ok: false
    }), {
      headers: CORS
    });
  }
  if (reportPayload === null) {
    console.error(`❌ [array webhook] report never became ready report_key=${reportKey} last_status=${lastStatus}`);
    return new Response(JSON.stringify({
      ok: false
    }), {
      headers: CORS
    });
  }
  console.log(`✅ [array webhook] fetched report report_key=${reportKey} product_code=${productCode} user_id=${userId}`);
  // ---------------------------------------------------------------------------
  // Normalize & extract fields
  // ---------------------------------------------------------------------------
  const report = reportPayload['report'] ?? reportPayload['creditReport'] ?? reportPayload;
  const summary = report['summary'] ?? {};
  let score = toInt(report['score'] ?? report['creditScore'] ?? report['vantageScore'] ?? report['ficoScore'] ?? summary['score']);
  const bucket = report['bucket'] ?? report['band'] ?? report['rating'] ?? summary['rating'];
  let model = report['model'] ?? report['scoreModel'] ?? report['scoreName'] ?? summary['scoreModel'] ?? summary['scoreName'];
  let asOf = report['asOf'] ?? report['pulledAt'] ?? report['pulled_at'] ?? summary['asOf'] ?? new Date().toISOString();
  let bureau = null;
  let scoreMin = null;
  let scoreMax = null;
  let scoreDate = null;
  let totalTradelines = null;
  let openTradelines = null;
  let closedTradelines = null;
  let avgAgeOpenTradesMonths = null;
  let oldestTradeMonths = null;
  let openCreditCards = null;
  const openInstallmentLoans = null;
  const openAutoLoans = null;
  const openMortgages = null;
  let revolvingUtilizationPct = null;
  let totalRevolvingLimit = null;
  let totalRevolvingBalance = null;
  let openToBuy = null;
  const totalOpenCreditLimit = null;
  const hardInquiries6m = null;
  let hardInquiries12m = null;
  const hardInquiries24m = null;
  let lastInquiryDate = null;
  let collectionsCount = null;
  const collectionsWithBalance = null;
  let publicRecordsCount = null;
  let bankruptciesCount = null;
  let lastPublicRecordMonthsAgo = null;
  let delinq30dpdEver = null;
  let delinq30dpd12m = null;
  let delinq30dpd24m = null;
  let delinq60dpdEver = null;
  const delinq90dpdEver = null;
  let monthlyPaymentTotal = null;
  let pastDueTotal = null;
  let openTradesSatisfactoryPct = null;
  let tradesOpened24mPct = null;
  const negativeFactors = [];
  const positiveFactors = [];
  // Experian CREDIT_RESPONSE specific parsing
  const creditResponse = reportPayload['CREDIT_RESPONSE'];
  if (typeof creditResponse === 'object' && creditResponse !== null) {
    const cr = creditResponse;
    const creditScoreNode = cr['CREDIT_SCORE'] ?? {};
    if (score === null) score = toInt(creditScoreNode['@_Value']);
    const scoreDateStr = cleanStr(creditScoreNode['@_Date']);
    scoreDate = scoreDateStr || null;
    if (scoreDateStr && !asOf) asOf = scoreDateStr;
    model = cleanStr(creditScoreNode['@_ModelNameTypeOtherDescription'] ?? creditScoreNode['@_ModelNameType']) || model;
    bureau = cleanStr(creditScoreNode['@CreditRepositorySourceType']) || null;
    scoreMin = toInt(creditScoreNode['@RiskBasedPricingMin']);
    scoreMax = toInt(creditScoreNode['@RiskBasedPricingMax']);
    let factors = creditScoreNode['_FACTOR'];
    if (!Array.isArray(factors)) factors = factors ? [
      factors
    ] : [];
    for (const f of factors){
      negativeFactors.push({
        code: f['@_Code'],
        text: f['@_Text']
      });
    }
    let pos = creditScoreNode['_POSITIVE_FACTOR'];
    if (!Array.isArray(pos)) pos = pos ? [
      pos
    ] : [];
    for (const f of pos){
      positiveFactors.push({
        code: f['@_Code'],
        text: f['@_Text']
      });
    }
    const summaryNode = cr['CREDIT_SUMMARY'] ?? {};
    let dsList = summaryNode['_DATA_SET'];
    if (!Array.isArray(dsList)) dsList = dsList ? [
      dsList
    ] : [];
    const summaryMap = {};
    for (const ds of dsList){
      const code = cleanStr(ds['@_ID']);
      const val = ds['@_Value'];
      if (code) summaryMap[code] = val;
    }
    totalTradelines = toInt(summaryMap['AP001']);
    avgAgeOpenTradesMonths = toInt(summaryMap['AP002']);
    hardInquiries12m = toInt(summaryMap['AP004']);
    revolvingUtilizationPct = toNum(summaryMap['AP006']);
    openTradelines = toInt(summaryMap['AT02S']);
    oldestTradeMonths = toInt(summaryMap['AT20S']);
    totalRevolvingLimit = toNum(summaryMap['BC28S'] ?? summaryMap['AT28B']);
    totalRevolvingBalance = toNum(summaryMap['BC33S'] ?? summaryMap['AT33B']);
    openCreditCards = toInt(summaryMap['BC02S']);
    openToBuy = toNum(summaryMap['G202A']);
    openTradesSatisfactoryPct = toNum(summaryMap['AT103S']);
    tradesOpened24mPct = toNum(summaryMap['AT104S']);
    monthlyPaymentTotal = toNum(summaryMap['ATAP01']);
    pastDueTotal = toNum(summaryMap['G217S'] ?? summaryMap['AT57S']);
    collectionsCount = toInt(summaryMap['G215B']);
    publicRecordsCount = toInt(summaryMap['G093S']);
    bankruptciesCount = toInt(summaryMap['G094S']);
    lastPublicRecordMonthsAgo = toInt(summaryMap['G095S']);
    hardInquiries12m = toInt(summaryMap['G238S'] ?? summaryMap['G244S']) ?? hardInquiries12m;
    delinq30dpdEver = toInt(summaryMap['G250A']);
    delinq30dpd12m = toInt(summaryMap['G250B']);
    delinq30dpd24m = toInt(summaryMap['G250C']);
    delinq60dpdEver = toInt(summaryMap['G251A']);
    let inquiryNode = cr['CREDIT_INQUIRY'];
    if (Array.isArray(inquiryNode)) inquiryNode = inquiryNode[inquiryNode.length - 1];
    if (typeof inquiryNode === 'object' && inquiryNode !== null) {
      lastInquiryDate = cleanStr(inquiryNode['@_Date']) || null;
    }
  }
  if (totalTradelines !== null && openTradelines !== null) {
    closedTradelines = totalTradelines - openTradelines;
  }
  const scoreBucket = calcScoreBucket(score, bucket);
  const riskTier = calcRiskTier(score);
  const scoreReasons = negativeFactors.length || positiveFactors.length ? {
    negative: negativeFactors,
    positive: positiveFactors
  } : null;
  const aiSummary = {
    score,
    bucket: scoreBucket,
    model,
    bureau,
    score_date: scoreDate,
    revolving_utilization_pct: revolvingUtilizationPct,
    total_revolving_limit: totalRevolvingLimit,
    total_revolving_balance: totalRevolvingBalance,
    open_to_buy: openToBuy,
    hard_inquiries_12m: hardInquiries12m,
    collections: collectionsCount,
    public_records: publicRecordsCount,
    bankruptcies: bankruptciesCount,
    monthly_payment_total: monthlyPaymentTotal,
    past_due_total: pastDueTotal,
    reason_codes: scoreReasons,
    as_of: asOf
  };
  const db = adminClient();
  // Insert into credit_reports
  const creditReportsPayload = {
    user_id: userId,
    provider: 'array',
    bureau,
    product_code: productCode,
    report_key: reportKey,
    credit_score: score,
    score_model: model,
    score_range_min: scoreMin,
    score_range_max: scoreMax,
    score_bucket: scoreBucket,
    risk_tier: riskTier,
    score_date: scoreDate,
    total_tradelines: totalTradelines,
    open_tradelines: openTradelines,
    closed_tradelines: closedTradelines,
    avg_age_open_trades_months: avgAgeOpenTradesMonths,
    oldest_trade_months: oldestTradeMonths,
    open_credit_cards: openCreditCards,
    open_installment_loans: openInstallmentLoans,
    open_auto_loans: openAutoLoans,
    open_mortgages: openMortgages,
    revolving_utilization_pct: revolvingUtilizationPct,
    total_revolving_limit: totalRevolvingLimit,
    total_revolving_balance: totalRevolvingBalance,
    open_to_buy: openToBuy,
    total_open_credit_limit: totalOpenCreditLimit ?? totalRevolvingLimit,
    hard_inquiries_6m: hardInquiries6m,
    hard_inquiries_12m: hardInquiries12m,
    hard_inquiries_24m: hardInquiries24m,
    last_inquiry_date: lastInquiryDate,
    collections_count: collectionsCount,
    collections_with_balance: collectionsWithBalance ?? collectionsCount,
    public_records_count: publicRecordsCount,
    bankruptcies_count: bankruptciesCount,
    last_public_record_months_ago: lastPublicRecordMonthsAgo,
    delinq_30dpd_ever: delinq30dpdEver,
    delinq_30dpd_12m: delinq30dpd12m,
    delinq_30dpd_24m: delinq30dpd24m,
    delinq_60dpd_ever: delinq60dpdEver,
    delinq_90dpd_ever: delinq90dpdEver,
    monthly_payment_total: monthlyPaymentTotal,
    past_due_total: pastDueTotal,
    open_trades_satisfactory_pct: openTradesSatisfactoryPct,
    trades_opened_24m_pct: tradesOpened24mPct,
    score_reasons: scoreReasons,
    ai_summary: aiSummary,
    bands: {
      bucket,
      model,
      service,
      path,
      product_code: productCode,
      report_key: reportKey
    },
    raw: reportPayload,
    pulled_at: asOf
  };
  await db.from('credit_reports').insert(creditReportsPayload);
  console.log(`✅ [array webhook] stored credit report user_id=${userId} report_key=${reportKey} score=${score}`);
  // Sync finance_snapshots
  try {
    if (existingFinance.length) {
      await db.from('finance_snapshots').update({
        credit_score: score,
        updated_at: new Date().toISOString()
      }).eq('id', existingFinance[0]['id']);
    } else {
      await db.from('finance_snapshots').insert({
        user_id: userId,
        credit_score: score
      });
    }
  } catch  {}
  // Push notification if score changed
  if (score !== null && prevScore !== null) {
    const delta = score - prevScore;
    if (delta !== 0) {
      const direction = delta > 0 ? 'up' : 'down';
      const msg = `Your credit score moved ${direction} by ${Math.abs(delta)} points to ${score}.`;
      const reportKeyStr = String(reportKey);
      const messageId = `credit:${reportKeyStr}`;
      const tsMs = String(Date.now());
      const dataPayload = {
        type: 'credit_score_change',
        direction,
        delta: String(Math.abs(delta)),
        score: String(score),
        message_id: messageId,
        ts_ms: tsMs,
        chat_body: msg
      };
      // Fire-and-forget push via push function (if available in your setup)
      // Mirrors Python's push_to_user + store_system_message
      // These are handled by separate services in your architecture
      console.log(`📣 [array webhook] score changed ${prevScore} -> ${score} (${direction} ${Math.abs(delta)}) user_id=${userId}`);
      console.log(`📣 [array webhook] push payload=${JSON.stringify(dataPayload)}`);
    }
  }
  return new Response(JSON.stringify({
    ok: true
  }), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ---------------------------------------------------------------------------
// Entry point — dispatch by action
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('invalid json');
  }
  const action = body['action'];
  try {
    switch(action){
      case 'bootstrap':
        return await handleBootstrap(req, body);
      case 'verification_start':
        return await handleVerificationStart(req);
      case 'verification_continue':
        return await handleVerificationContinue(req, body);
      case 'report_order':
        return await handleReportOrder(req, body);
      case 'report_status':
        return await handleReportStatus(req);
      case 'array_token':
        return await handleArrayToken(req, body);
      case 'array_webhook':
        return await handleArrayWebhook(req, body);
      default:
        return await handleArrayWebhook(req, body);
    }
  } catch (e) {
    const ex = e;
    const status = ex.status ?? 500;
    console.error(`[array-backend] action=${action ?? 'webhook'} error:`, ex.message);
    return err(ex.message ?? 'internal error', status);
  }
});
