import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from '@supabase/supabase-js';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
// ---------------------------------------------------------------------------
// Config (mirrors hutsy/config.py constants; override via env vars)
// ---------------------------------------------------------------------------
const INITIAL_CONNECT_SUPPRESS_MIN = Number(Deno.env.get('INITIAL_CONNECT_SUPPRESS_MIN') ?? 30);
const LOW_BALANCE_THRESHOLD = Number(Deno.env.get('LOW_BALANCE_THRESHOLD') ?? 100);
const LOW_BALANCE_COOLDOWN_MIN = Number(Deno.env.get('LOW_BALANCE_COOLDOWN_MIN') ?? 60);
const TXN_NOTIFY_CODES = new Set([
  'DEFAULT_UPDATE',
  'SYNC_UPDATES_AVAILABLE'
]);
// ---------------------------------------------------------------------------
// In-process burst dedupe (per isolate; sufficient to collapse Plaid retries)
// ---------------------------------------------------------------------------
const _dedupeCache = new Map();
const DEDUPE_TTL_MS = 10_000;
function dedupeOk(key) {
  const now = Date.now();
  for (const [k, ts] of _dedupeCache){
    if (now - ts > DEDUPE_TTL_MS) _dedupeCache.delete(k);
  }
  if (_dedupeCache.has(key)) return false;
  _dedupeCache.set(key, now);
  return true;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildAdminClient() {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
}

function buildPlaidClient(plaidEnv) {
  const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID');
  const PLAID_SECRET = Deno.env.get('PLAID_SECRET');
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) throw new Error('Missing Plaid credentials');
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[plaidEnv] ?? PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET
      }
    }
  }));
}
async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const data = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  // @ts-ignore: Web Crypto API sign returns ArrayBuffer, but we convert to Uint8Array for HMAC
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(sig)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
function fmtMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency
    }).format(amount);
  } catch  {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
function nowMsStr() {
  return String(Date.now());
}
function minutesSince(isoTs) {
  if (!isoTs) return Infinity;
  const dt = new Date(isoTs);
  if (isNaN(dt.getTime())) return Infinity;
  return (Date.now() - dt.getTime()) / 60_000;
}
// ---------------------------------------------------------------------------
// Supabase upsert helpers (mirrors PHP sb_* functions)
// ---------------------------------------------------------------------------
async function sbUpsertAccounts(db, userId, itemId, accounts, plaidEnv) {
  console.log(`[plaid-webhook] sbUpsertAccounts item_id=${itemId} user_id=${userId} accounts=${accounts.length}`);
  if (!accounts.length) {
    console.log(`[plaid-webhook] sbUpsertAccounts skipping, no accounts to upsert item_id=${itemId}`);
    return;
  }
  const rows = accounts.map((a)=>({
      user_id: userId,
      item_id: itemId,
      account_id: a['account_id'] ?? '',
      name: a['name'] ?? '',
      official_name: a['official_name'] ?? '',
      type: a['type'] ?? '',
      subtype: a['subtype'] ?? '',
      mask: a['mask'] ?? '',
      balances: a['balances'] ?? null,
      updated_at: new Date().toISOString(),
      plaid_env: plaidEnv
    }));
  const { error } = await db.from('plaid_accounts').upsert(rows, {
    onConflict: 'account_id'
  });
  if (error) console.error('[plaid-webhook] sbUpsertAccounts error:', error);
  else console.log(`[plaid-webhook] sbUpsertAccounts ok item_id=${itemId} rows=${rows.length}`);
}
async function sbUpsertTransactions(db, userId, itemId, txns, plaidEnv) {
  console.log(`[plaid-webhook] sbUpsertTransactions item_id=${itemId} user_id=${userId} txns=${txns.length}`);
  if (!txns.length) {
    console.log(`[plaid-webhook] sbUpsertTransactions skipping, no transactions item_id=${itemId}`);
    return;
  }
  const CHUNK = 200;
  for(let i = 0; i < txns.length; i += CHUNK){
    const chunk = txns.slice(i, i + CHUNK).map((t)=>({
        user_id: userId,
        item_id: itemId,
        account_id: t['account_id'] ?? '',
        transaction_id: t['transaction_id'] ?? '',
        name: t['name'] ?? t['merchant_name'] ?? '',
        merchant_name: t['merchant_name'] ?? '',
        amount: t['amount'] ?? 0,
        iso_currency_code: t['iso_currency_code'] ?? t['unofficial_currency_code'] ?? 'USD',
        date_posted: t['date'] ?? null,
        authorized_date: t['authorized_date'] ?? null,
        raw: t,
        updated_at: new Date().toISOString(),
        plaid_env: plaidEnv
      }));
    console.log(`[plaid-webhook] sbUpsertTransactions upserting chunk offset=${i} size=${chunk.length} item_id=${itemId}`);
    const { error } = await db.from('plaid_transactions').upsert(chunk, {
      onConflict: 'transaction_id'
    });
    if (error) console.error('[plaid-webhook] sbUpsertTransactions error:', error);
    else console.log(`[plaid-webhook] sbUpsertTransactions chunk ok offset=${i} item_id=${itemId}`);
  }
}
async function sbUpsertRecurring(db, userId, itemId, rec, plaidEnv) {
  console.log(`[plaid-webhook] sbUpsertRecurring item_id=${itemId} user_id=${userId} outflows=${rec['outflow_streams']?.length ?? 0} inflows=${rec['inflow_streams']?.length ?? 0}`);
  const { error } = await db.from('plaid_recurring').upsert({
    user_id: userId,
    item_id: itemId,
    outflow_streams: rec['outflow_streams'] ?? [],
    inflow_streams: rec['inflow_streams'] ?? [],
    raw: rec,
    updated_at: new Date().toISOString(),
    plaid_env: plaidEnv
  }, {
    onConflict: 'item_id'
  });
  if (error) console.error('[plaid-webhook] sbUpsertRecurring error:', error);
  else console.log(`[plaid-webhook] sbUpsertRecurring ok item_id=${itemId}`);
}
async function sbLogWebhookEvent(db, userId, itemId, payload, plaidEnv) {
  const wtype = payload['webhook_type'] ?? null;
  const wcode = payload['webhook_code'] ?? null;
  console.log(`[plaid-webhook] sbLogWebhookEvent item_id=${itemId} user_id=${userId} type=${wtype} code=${wcode}`);
  const { error } = await db.from('plaid_webhook_events').insert({
    user_id: userId,
    item_id: itemId,
    webhook_type: wtype,
    webhook_code: wcode,
    payload: payload,
    created_at: new Date().toISOString(),
    plaid_env: plaidEnv
  });
  if (error) console.error('[plaid-webhook] sbLogWebhookEvent error:', error);
  else console.log(`[plaid-webhook] sbLogWebhookEvent ok item_id=${itemId}`);
}
// ---------------------------------------------------------------------------
// Plaid data fetchers
// ---------------------------------------------------------------------------
async function plaidFetchAccounts(plaid, accessToken) {
  console.log('[plaid-webhook] plaidFetchAccounts fetching accounts from Plaid');
  const res = await plaid.accountsGet({
    access_token: accessToken
  });
  const accounts = res.data.accounts ?? [];
  console.log(`[plaid-webhook] plaidFetchAccounts fetched accounts=${accounts.length}`);
  return accounts;
}
async function plaidFetchTransactionsAll(plaid, accessToken, days = 90) {
  const startDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  console.log(`[plaid-webhook] plaidFetchTransactionsAll start_date=${startDate} end_date=${endDate} days=${days}`);
  let txns = [];
  let offset = 0;
  const count = 100;
  while(true){
    console.log(`[plaid-webhook] plaidFetchTransactionsAll fetching page offset=${offset} count=${count}`);
    const res = await plaid.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count,
        offset
      }
    });
    const batch = res.data.transactions ?? [];
    txns = [
      ...txns,
      ...batch
    ];
    const total = res.data.total_transactions ?? txns.length;
    console.log(`[plaid-webhook] plaidFetchTransactionsAll page fetched batch=${batch.length} total_available=${total} fetched_so_far=${txns.length}`);
    offset += count;
    if (offset >= total || offset > 1000) break;
  }
  console.log(`[plaid-webhook] plaidFetchTransactionsAll done total_txns=${txns.length}`);
  return txns;
}
async function plaidFetchRecurring(plaid, accessToken, accounts) {
  console.log('[plaid-webhook] plaidFetchRecurring fetching recurring streams from Plaid');
  const res = await plaid.transactionsRecurringGet({
    access_token: accessToken
  });
  //@ts-ignore
  const data = res.data;
  const currencyMap = {};
  for (const a of accounts){
    const balances = a['balances'];
    currencyMap[a['account_id']] = balances?.['iso_currency_code'] ?? 'USD';
  }
  for (const key of [
    'outflow_streams',
    'inflow_streams'
  ]){
    const streams = data[key];
    if (!streams) continue;
    for (const stream of streams){
      const accId = stream['account_id'];
      if (accId && currencyMap[accId]) {
        const avg = stream['average_amount'] ?? {};
        avg['iso_currency_code'] = currencyMap[accId];
        stream['average_amount'] = avg;
      }
    }
  }
  const outflowCount = data['outflow_streams']?.length ?? 0;
  const inflowCount = data['inflow_streams']?.length ?? 0;
  console.log(`[plaid-webhook] plaidFetchRecurring fetched outflows=${outflowCount} inflows=${inflowCount}`);
  return data;
}
// ---------------------------------------------------------------------------
// Refresh all Plaid data for an item
// ---------------------------------------------------------------------------
async function refreshItemNow(db, plaid, userId, itemId, accessToken, plaidEnv, reason) {
  console.log(`[plaid-webhook] refresh start item=${itemId} reason=${reason}`);
  const accounts = await plaidFetchAccounts(plaid, accessToken);
  await sbUpsertAccounts(db, userId, itemId, accounts, plaidEnv);
  const txns = await plaidFetchTransactionsAll(plaid, accessToken, 90);
  await sbUpsertTransactions(db, userId, itemId, txns, plaidEnv);
  try {
    const rec = await plaidFetchRecurring(plaid, accessToken, accounts);
    await sbUpsertRecurring(db, userId, itemId, rec, plaidEnv);
  } catch (err) {
    console.warn('[plaid-webhook] recurring fetch skipped:', err.message);
  }
  try {
    const balRes = await plaid.accountsBalanceGet({
      access_token: accessToken
    });
    const freshAccounts = balRes.data.accounts ?? [];
    await sbUpsertAccounts(db, userId, itemId, freshAccounts, plaidEnv);
  } catch (err) {
    console.warn('[plaid-webhook] balance refresh skipped:', err.message);
  }
  console.log(`[plaid-webhook] refresh done item=${itemId} txns=${txns.length}`);
}
async function buildSnapshot(db, userId) {
  console.log(`[plaid-webhook] buildSnapshot start user_id=${userId}`);
  // 1) Accounts (join with items for institution name)
  const { data: accs } = await db.from('plaid_accounts').select('account_id, name, mask, balances, item_id').eq('user_id', userId);
  const itemIds = [
    ...new Set((accs ?? []).map((a)=>a['item_id']))
  ];
  const { data: items } = itemIds.length ? await db.from('plaid_items').select('item_id, institution_name').in('item_id', itemIds) : {
    data: []
  };
  const bankMap = {};
  for (const it of items ?? []){
    bankMap[it['item_id']] = it['institution_name'] ?? 'Bank';
  }
  const maskedAccounts = (accs ?? []).map((a)=>{
    const balances = a['balances'] ?? {};
    return {
      account_id: a['account_id'],
      bank: bankMap[a['item_id']] ?? 'Bank',
      name: a['name'] ?? 'Account',
      last4: a['mask'] ?? '—',
      currency: balances['iso_currency_code'] ?? 'USD',
      available_balance: balances['available'] != null ? Number(balances['available']) : null,
      current_balance: balances['current'] != null ? Number(balances['current']) : null
    };
  });
  const defaultCurrency = maskedAccounts[0]?.currency ?? 'USD';
  // 2) Recent transactions (latest 20 by date, then id)
  const { data: txnRows } = await db.from('plaid_transactions').select('transaction_id, name, merchant_name, amount, iso_currency_code, date_posted').eq('user_id', userId).order('date_posted', {
    ascending: false
  }).order('id', {
    ascending: false
  }).limit(20);
  const transactions = (txnRows ?? []).map((t)=>({
      transaction_id: t['transaction_id'],
      name: t['merchant_name'] || t['name'] || 'Transaction',
      amount: Number(t['amount'] ?? 0),
      currency: t['iso_currency_code'] ?? defaultCurrency,
      date: t['date_posted'] ?? null
    }));
  // 3) Next bill from outflow recurring streams
  const { data: recRows } = await db.from('plaid_recurring').select('outflow_streams').eq('user_id', userId).order('updated_at', {
    ascending: false
  }).limit(1);
  let nextBill = null;
  const outflows = recRows?.[0]?.outflow_streams ?? [];
  if (outflows.length) {
    const today = new Date().toISOString().slice(0, 10);
    let best = null;
    let bestDate = '';
    for (const s of outflows){
      const nd = s['next_date'] ?? '';
      if (nd >= today && (!bestDate || nd < bestDate)) {
        best = s;
        bestDate = nd;
      }
    }
    if (best) {
      const avg = best['average_amount'] ?? {};
      nextBill = {
        label: best['merchant_name'] ?? best['description'] ?? 'Bill',
        amount: Math.abs(Number(avg['amount'] ?? 0)),
        next_date: bestDate || null
      };
    }
  }
  console.log(`[plaid-webhook] buildSnapshot done user_id=${userId} accounts=${maskedAccounts.length} txns=${transactions.length} next_bill=${nextBill?.label ?? 'none'}`);
  return {
    default_currency: defaultCurrency,
    transactions,
    masked_accounts: maskedAccounts,
    next_bill: nextBill
  };
}
// ---------------------------------------------------------------------------
// FCM push (Firebase Cloud Messaging HTTP v1 — JWT assertion, mirrors fcm.py)
// ---------------------------------------------------------------------------
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const _fcmTokenCache = {
  accessToken: null,
  expTs: 0
};
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++)buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}
function b64url(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function loadServiceAccount() {
  const json = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!json) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${e}`);
  }
}
async function getFcmAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_fcmTokenCache.accessToken && now < _fcmTokenCache.expTs - 60) {
    return _fcmTokenCache.accessToken;
  }
  const sa = loadServiceAccount();
  const clientEmail = sa['client_email'];
  const privateKeyPem = sa['private_key'];
  const tokenUri = sa['token_uri'] ?? 'https://oauth2.googleapis.com/token';
  if (!clientEmail || !privateKeyPem) {
    throw new Error('Service account missing client_email/private_key');
  }
  const iat = now;
  const exp = now + 3600;
  const header = b64url(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT'
  }));
  const payload = b64url(JSON.stringify({
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: tokenUri,
    iat,
    exp
  }));
  const signingInput = `${header}.${payload}`;
  const keyDer = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey('pkcs8', keyDer, {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const sig = b64url(String.fromCharCode(...new Uint8Array(sigBuf)));
  const assertion = `${signingInput}.${sig}`;
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!resp.ok) throw new Error(`FCM token exchange failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json();
  const accessToken = j['access_token'];
  const expiresIn = Number(j['expires_in'] ?? 3600);
  if (!accessToken) throw new Error('FCM token exchange returned no access_token');
  _fcmTokenCache.accessToken = accessToken;
  _fcmTokenCache.expTs = now + expiresIn;
  return accessToken;
}
async function disableToken(db, token) {
  try {
    await db.from('device_push_tokens').update({
      is_enabled: false,
      updated_at: new Date().toISOString()
    }).eq('token', token);
  } catch (e) {
    console.warn('[plaid-webhook] disableToken failed:', e);
  }
}
async function pushToUser(db, userId, title, body, data) {
  const PUSH_DISABLE = Deno.env.get('PUSH_DISABLE') === '1';
  if (PUSH_DISABLE) return;
  const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID');
  if (!FIREBASE_PROJECT_ID) {
    console.warn('[plaid-webhook] FIREBASE_PROJECT_ID not set, skipping push');
    return;
  }
  const { data: tokenRows } = await db.from('device_push_tokens').select('token').eq('user_id', userId).eq('is_enabled', true).order('updated_at', {
    ascending: false
  }).limit(50);
  const tokens = (tokenRows ?? []).map((r)=>r['token']).filter(Boolean);
  if (!tokens.length) return;
  let accessToken;
  try {
    accessToken = await getFcmAccessToken();
  } catch (e) {
    console.error('[plaid-webhook] getFcmAccessToken failed:', e);
    return;
  }
  const url = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  // FCM data values must be strings
  const safeData = {};
  for (const [k, v] of Object.entries(data)){
    if (v != null) safeData[k] = String(v);
  }
  let sent = 0, failed = 0;
  for (const tok of tokens){
    const fcmPayload = {
      message: {
        token: tok,
        notification: {
          title,
          body
        },
        data: safeData,
        android: {
          priority: 'HIGH'
        },
        apns: {
          headers: {
            'apns-priority': '10'
          }
        }
      }
    };
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(fcmPayload)
      });
      if (r.status >= 200 && r.status < 300) {
        sent++;
      } else {
        failed++;
        const txt = await r.text();
        if (txt.includes('UNREGISTERED') || txt.includes('NotRegistered') || txt.includes('InvalidRegistration')) {
          await disableToken(db, tok);
        }
      }
    } catch (e) {
      failed++;
      console.warn('[plaid-webhook] push send failed:', e);
    }
  }
  console.log(`[plaid-webhook] FCM v1 sent=${sent} failed=${failed} user=${userId}`);
}
// ---------------------------------------------------------------------------
// Store system message in chat_messages (mirrors store_system_message)
// Dedupes on wa_message_id to prevent duplicate chat bubbles.
// ---------------------------------------------------------------------------
async function storeSystemMessage(db, userId, body, meta, dedupeKey) {
  // Skip if already stored
  const { data: existing } = await db.from('chat_messages').select('id').eq('user_id', userId).eq('wa_message_id', dedupeKey).limit(1);
  if (existing?.length) return;
  const { error } = await db.from('chat_messages').insert({
    user_id: userId,
    channel: 'push',
    role: 'assistant',
    direction: 'out',
    body,
    wa_message_id: dedupeKey,
    meta,
    created_at: new Date().toISOString()
  });
  if (error) console.error('[plaid-webhook] storeSystemMessage error:', error);
}
// ---------------------------------------------------------------------------
// Notification processor (replaces forwardToFastApi / mirrors plaid.py router)
// ---------------------------------------------------------------------------
async function processNotifications(db, userId, itemId, payload) {
  const wtype = payload['webhook_type'] ?? '';
  const wcode = payload['webhook_code'] ?? '';
  // ------------------------------------------------------------------
  // Initial connect suppression
  // ------------------------------------------------------------------
  const { data: prof } = await db.from('profiles').select('bank_connected_notified_at, low_balance_alert_at, last_txn_notify_key').eq('user_id', userId).single();
  if (minutesSince(prof?.bank_connected_notified_at) < INITIAL_CONNECT_SUPPRESS_MIN) {
    console.log('[plaid-webhook] suppressed (initial connect window)');
    return;
  }
  // ------------------------------------------------------------------
  // Build snapshot from freshly-upserted Supabase data
  // ------------------------------------------------------------------
  const snapshot = await buildSnapshot(db, userId);
  const defaultCcy = snapshot.default_currency;
  // ==================================================================
  // 1) TRANSACTION NOTIFICATIONS
  // ==================================================================
  if (wtype === 'TRANSACTIONS' && TXN_NOTIFY_CODES.has(wcode)) {
    const txns = snapshot.transactions;
    if (txns.length) {
      const lastKey = prof?.last_txn_notify_key ?? null;
      let picked = null;
      let pickedKey = null;
      for (const t of txns.slice(0, 10)){
        const k = `${t.transaction_id}:${t.date}:${t.amount}`;
        if (k && k !== lastKey) {
          picked = t;
          pickedKey = k;
          break;
        }
      }
      if (picked && pickedKey) {
        const direction = picked.amount > 0 ? 'outflow' : 'inflow';
        const label = direction === 'inflow' ? 'Credit' : 'Debit';
        const ccy = picked.currency ?? defaultCcy;
        const title = 'New transaction';
        const body = `${label}: ${picked.name} — ${fmtMoney(Math.abs(picked.amount), ccy)}`;
        const messageId = `txn:${itemId}:${pickedKey}`;
        const chatBody = `${title}\n${body}`;
        const data = {
          type: 'plaid_transaction',
          direction,
          amount: Math.abs(picked.amount).toFixed(2),
          currency: ccy,
          name: picked.name,
          date: picked.date ?? '',
          item_id: itemId,
          message_id: messageId,
          ts_ms: nowMsStr(),
          chat_body: chatBody
        };
        await pushToUser(db, userId, title, body, data);
        await storeSystemMessage(db, userId, chatBody, data, messageId);
        // Persist last notified txn key to profiles
        await db.from('profiles').update({
          last_txn_notify_key: pickedKey
        }).eq('user_id', userId);
      }
    }
  }
  // ==================================================================
  // 2) RECURRING UPDATES
  // ==================================================================
  if ([
    'RECURRING_TRANSACTIONS_UPDATE',
    'RECURRING_TRANSACTIONS_UPDATED'
  ].includes(wcode)) {
    const nb = snapshot.next_bill;
    if (nb) {
      const title = 'Recurring bill detected';
      const body = `Next: ${nb.label} — ${fmtMoney(nb.amount, defaultCcy)} on ${nb.next_date ?? 'N/A'}`;
      const messageId = `recurring:${itemId}:${nb.label}:${nb.next_date}`;
      const chatBody = `${title}\n${body}`;
      const data = {
        type: 'plaid_recurring',
        label: nb.label,
        amount: String(nb.amount),
        currency: defaultCcy,
        next_date: nb.next_date ?? '',
        item_id: itemId,
        message_id: messageId,
        ts_ms: nowMsStr(),
        chat_body: chatBody
      };
      await pushToUser(db, userId, title, body, data);
      await storeSystemMessage(db, userId, chatBody, data, messageId);
    }
  }
  // ==================================================================
  // 3) LOW BALANCE ALERT
  // ==================================================================
  if (wtype === 'TRANSACTIONS') {
    const lowAccounts = snapshot.masked_accounts.filter((a)=>{
      const bal = a.available_balance ?? a.current_balance;
      return bal !== null && bal <= LOW_BALANCE_THRESHOLD;
    });
    if (lowAccounts.length && minutesSince(prof?.low_balance_alert_at) >= LOW_BALANCE_COOLDOWN_MIN) {
      const a = lowAccounts[0];
      const bal = a.available_balance ?? a.current_balance;
      const ccy = a.currency ?? defaultCcy;
      const title = 'Low balance alert';
      const body = `${a.bank} • ${a.name} (•••• ${a.last4}): ${fmtMoney(bal, ccy)}`;
      const messageId = `low:${itemId}:${a.last4}:${Math.floor(bal)}`;
      const chatBody = `${title}\n${body}`;
      const data = {
        type: 'low_balance',
        bank: a.bank,
        account: a.name,
        last4: a.last4,
        balance: bal.toFixed(2),
        currency: ccy,
        item_id: itemId,
        message_id: messageId,
        ts_ms: nowMsStr(),
        chat_body: chatBody
      };
      await pushToUser(db, userId, title, body, data);
      await storeSystemMessage(db, userId, chatBody, data, messageId);
      await db.from('profiles').update({
        low_balance_alert_at: new Date().toISOString()
      }).eq('user_id', userId);
    }
  }
}
// ---------------------------------------------------------------------------
// Background processor
// ---------------------------------------------------------------------------
async function processWebhook(payload, itemId) {
  const db = buildAdminClient();
  const plaidEnv = Deno.env.get('PLAID_ENV') ?? 'sandbox';
  // 0) Burst dedupe — mirrors plaid.py _dedupe_ok, runs BEFORE any DB/API calls
  //    so duplicate Plaid retries don't trigger the full expensive refresh.
  const wtype = payload['webhook_type'] ?? '';
  const wcode = payload['webhook_code'] ?? '';
  const dkey = `${itemId}:${wtype}:${wcode}:${payload['new_transactions'] ?? ''}:${payload['removed_transactions'] ?? ''}:${payload['error'] ?? ''}`;
  if (!dedupeOk(dkey)) {
    console.log('[plaid-webhook] burst deduped, skipping');
    return;
  }
  // 1) Find owner from plaid_items
  const { data: items } = await db.from('plaid_items').select('user_id, plaid_env').eq('item_id', itemId).limit(1);
  const userId = items?.[0]?.user_id ?? null;
  const itemEnv = items?.[0]?.plaid_env ?? plaidEnv;
  // 2) Log webhook event (even if owner not found)
  await sbLogWebhookEvent(db, userId, itemId, payload, itemEnv);
  if (!userId) {
    console.error(`[plaid-webhook] no owner for item_id=${itemId}`);
    return;
  }
  // 3) Get access token
  const { data: secrets } = await db.from('plaid_item_secrets').select('access_token').eq('item_id', itemId).eq('user_id', userId).eq('plaid_env', itemEnv).limit(1);
  const accessToken = secrets?.[0]?.access_token;
  if (!accessToken) {
    console.error(`[plaid-webhook] no access_token for item_id=${itemId}`);
    return;
  }
  // 4) Refresh Plaid data → Supabase
  const webhookType = (payload['webhook_type'] ?? '').toLowerCase();
  const webhookCode = (payload['webhook_code'] ?? '').toLowerCase();
  const reason = `webhook-${webhookType}-${webhookCode}`;
  const plaid = buildPlaidClient(itemEnv);
  await refreshItemNow(db, plaid, userId, itemId, accessToken, itemEnv, reason);
  // 4b) Dedicated recurring upsert for RECURRING webhook codes.
  //     refreshItemNow silently swallows plaidFetchRecurring errors — this
  //     ensures plaid_recurring is always written for recurring webhooks and
  //     surfaces failures as errors (not warnings) in function logs.
  if ([
    'recurring_transactions_update',
    'recurring_transactions_updated'
  ].includes(webhookCode)) {
    try {
      const accounts = await plaidFetchAccounts(plaid, accessToken);
      const rec = await plaidFetchRecurring(plaid, accessToken, accounts);
      await sbUpsertRecurring(db, userId, itemId, rec, itemEnv);
      console.log(`[plaid-webhook] plaid_recurring explicit upsert ok item=${itemId}`);
    } catch (recErr) {
      console.error('[plaid-webhook] plaid_recurring explicit upsert failed:', recErr.message);
    }
  }
  // 5) Process notifications inline (was: forwardToFastApi)
  await processNotifications(db, userId, itemId, payload);
}
// ---------------------------------------------------------------------------
// Entry point — ACK Plaid immediately, run heavy work in background
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  const raw = await req.text();
  // ---------------------------------------------------------------------------
  // Signature verification (mirrors plaid.py X-Hutsy-Signature check)
  // Supports both raw-body HMAC and canonical-JSON HMAC fallback.
  // ---------------------------------------------------------------------------
  // const PLAID_FORWARD_SECRET = Deno.env.get('PLAID_FORWARD_SECRET')
  // if (PLAID_FORWARD_SECRET) {
  //   const sig = req.headers.get('x-hutsy-signature') ?? ''
  //   const expectedRaw = await hmacSha256Hex(PLAID_FORWARD_SECRET, raw)
  //   let valid = sig === expectedRaw
  //   if (!valid) {
  //     // canonical JSON fallback
  //     try {
  //       const parsed = JSON.parse(raw)
  //       const canon  = JSON.stringify(parsed, Object.keys(parsed).sort())
  //       const expectedCanon = await hmacSha256Hex(PLAID_FORWARD_SECRET, canon)
  //       valid = sig === expectedCanon
  //     } catch { /* invalid JSON handled below */ }
  //   }
  //   if (!valid) {
  //     console.warn('[plaid-webhook] bad signature')
  //     return new Response('bad signature', { status: 401, headers: { 'Content-Type': 'text/plain' } })
  //   }
  // }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch  {
    return new Response('invalid json', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }
  const itemId = payload['item_id'];
  if (!itemId) {
    return new Response('missing item_id', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }
  // Fire-and-forget: return 200 immediately so Plaid doesn't retry
  EdgeRuntime.waitUntil(processWebhook(payload, itemId).catch((err)=>console.error('[plaid-webhook] processWebhook uncaught:', err)));
  return new Response('ok', {
    headers: {
      'Content-Type': 'text/plain'
    }
  });
});
