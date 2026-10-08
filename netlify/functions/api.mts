import type { Config } from "@netlify/functions"
import { getDatabase } from "@netlify/database"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"

const db = getDatabase()
const pool = db.pool

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
const FORBIDDEN = "You do not have permission to access this resource."
const LOGIN_REQ = "Please log in to continue."
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10)

const Q = async (c: any, text: string, params: any[] = []) => (await c.query(text, params)).rows as any[]
async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query("BEGIN")
    const r = await fn(c)
    await c.query("COMMIT")
    return r
  } catch (e) {
    await c.query("ROLLBACK")
    throw e
  } finally {
    c.release()
  }
}
const nextId = async (c: any, name: string, prefix: string, w: number) => {
  const [r] = await Q(c, "INSERT INTO seq(name,n) VALUES($1,1) ON CONFLICT (name) DO UPDATE SET n = seq.n + 1 RETURNING n", [name])
  return prefix + String(r.n).padStart(w, "0")
}
const logEvent = (c: any, type: string, detail: string) => Q(c, "INSERT INTO events(type,detail) VALUES($1,$2)", [type, detail])

const secret = () => {
  const s = Netlify.env.get("JWT_SECRET")
  if (!s || s.length < 32) throw new Error("JWT_SECRET (32+ characters) is not configured")
  return s
}
const pubUser = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, balance: u.balance, createdAt: u.created_at })
const pubStation = (s: any) => ({ id: s.id, name: s.name, location: s.location, status: s.status, qr: s.qr, qrActive: s.qr_active, createdAt: s.created_at, updatedAt: s.updated_at })
const pubTx = (t: any) => ({
  id: t.id, deviceEventId: t.device_event_id, sessionId: t.session_id, userId: t.user_id, stationId: t.station_id,
  category: t.category, subcategory: t.subcategory, weightKg: Number(t.weight_kg), pointRateUsed: Number(t.rate_used),
  pointsAwarded: t.points_awarded, createdAt: t.created_at, status: t.status, source: t.source,
})

let seeded = false
async function ensureSeed() {
  if (seeded) return
  const email = Netlify.env.get("ADMIN_EMAIL"), pw = Netlify.env.get("ADMIN_PASSWORD")
  if (!email || !pw) return // admin is seeded server-side from env vars only; no registration route exists
  const [a] = await Q(pool, "SELECT 1 FROM users WHERE role='ADMIN' LIMIT 1")
  if (!a) {
    await Q(pool, "INSERT INTO users(id,role,name,email,password_hash) VALUES('ADMIN-001','ADMIN','Administrator',$1,$2) ON CONFLICT DO NOTHING",
      [email.trim().toLowerCase(), await bcrypt.hash(pw, 10)])
  }
  seeded = true
}

async function authUser(req: Request) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") || "")
  if (!m) throw new HttpError(401, LOGIN_REQ)
  let sub: string
  try { sub = (jwt.verify(m[1], secret(), { algorithms: ["HS256"] }) as any).sub } catch { throw new HttpError(401, LOGIN_REQ) }
  const [u] = await Q(pool, "SELECT * FROM users WHERE id=$1", [sub]) // role always comes from the DB
  if (!u) throw new HttpError(401, LOGIN_REQ)
  return u
}

async function login(body: any, role: string): Promise<[number, any]> {
  const email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || "")
  const [u] = await Q(pool, "SELECT * FROM users WHERE email=$1 AND role=$2", [email, role])
  const ok = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH)
  if (!u || !ok) throw new HttpError(401, "Invalid email or password.")
  return [200, { token: jwt.sign({ sub: u.id }, secret(), { algorithm: "HS256", expiresIn: "8h" }), user: pubUser(u) }]
}

const findStation = async (qr: any) => {
  const [s] = await Q(pool, "SELECT * FROM stations WHERE qr=$1 AND qr_active", [String(qr || "").trim()])
  if (!s) throw new HttpError(404, "Station not found.")
  if (s.status !== "ACTIVE") throw new HttpError(409, "This station is currently unavailable.")
  return s
}

const TOP = ["WET", "DRY", "SANITARY", "SPECIAL"]
const DRY_SUBS = ["PLASTIC", "METAL", "PAPER", "GLASS", "MIXED"]

// One DB transaction: duplicate check, validation, transaction row, balance update and events commit together or not at all.
async function recordTransaction(user: any, b: any): Promise<any> {
  const eid = String(b.eventId || "").trim()
  if (!eid || eid.length > 80) throw new HttpError(400, "Missing event identifier.")
  const existing = async (c: any) => {
    const [d] = await Q(c, "SELECT * FROM transactions WHERE device_event_id=$1", [eid])
    if (!d) return null
    if (d.user_id !== user.id) throw new HttpError(403, FORBIDDEN)
    const [u] = await Q(c, "SELECT balance FROM users WHERE id=$1", [user.id])
    return { duplicate: true, tx: pubTx(d), balance: u.balance, message: "This contribution has already been recorded." }
  }
  try {
    return await tx(async (c) => {
      const dup = await existing(c)
      if (dup) { await logEvent(c, "Duplicate transaction blocked", eid); return dup }

      const [ss] = await Q(c, "SELECT * FROM sessions WHERE id=$1", [String(b.sessionId || "")])
      if (!ss || ss.user_id !== user.id) throw new HttpError(403, FORBIDDEN)
      if (ss.status !== "ACTIVE" || new Date(ss.expires_at).getTime() < Date.now()) throw new HttpError(409, "Session expired. Scan the station QR again.")
      const [st] = await Q(c, "SELECT * FROM stations WHERE id=$1", [ss.station_id])
      if (!st || st.status !== "ACTIVE" || !st.qr_active) throw new HttpError(409, "This station is currently unavailable.")

      const category = String(b.category || "").toUpperCase()
      if (!TOP.includes(category)) throw new HttpError(400, "Invalid waste category.")
      let sub: string | null = null
      if (category === "DRY") {
        sub = String(b.subcategory || "").toUpperCase()
        if (!DRY_SUBS.includes(sub)) throw new HttpError(400, "Invalid waste subcategory.")
      }
      if (b.weight === undefined || b.weight === null || b.weight === "" || typeof b.weight === "boolean") throw new HttpError(400, "Invalid weight received.")
      const w = Number(b.weight)
      if (!Number.isFinite(w) || (b.unit !== "kg" && b.unit !== "g")) throw new HttpError(400, "Invalid weight received.")
      const weightKg = Math.round((b.unit === "g" ? w / 1000 : w) * 1e4) / 1e4 // converted exactly once
      if (weightKg < 0.001 || weightKg > 50) throw new HttpError(400, "Invalid weight received.")

      const [r] = await Q(c, "SELECT points_per_kg FROM rates WHERE key=$1", [(sub || category).toLowerCase()])
      const rate = Number(r.points_per_kg)
      const points = Math.round(weightKg * rate) // one rounding rule: nearest whole point
      const id = await nextId(c, "txn", "PURNA-TXN-", 4)
      const [row] = await Q(c,
        `INSERT INTO transactions(id,device_event_id,session_id,user_id,station_id,category,subcategory,weight_kg,rate_used,points_awarded,status,source)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'COMPLETED','PROTOTYPE') RETURNING *`,
        [id, eid, ss.id, user.id, st.id, category, sub, weightKg, rate, points])
      const [u] = await Q(c, "UPDATE users SET balance = balance + $1 WHERE id=$2 RETURNING balance", [points, user.id])
      await logEvent(c, "Transaction received", id)
      await logEvent(c, "Points credited", `${id} +${points}`)
      return { duplicate: false, tx: pubTx(row), previousBalance: u.balance - points, balance: u.balance, message: "Contribution recorded successfully." }
    })
  } catch (e: any) {
    // Two concurrent requests with the same event id: the UNIQUE constraint stops the second; return the first result.
    if (e?.code === "23505" && String(e.constraint || "").includes("device_event_id")) {
      const dup = await existing(pool)
      if (dup) return dup
    }
    throw e
  }
}

/* ---------- routes ---------- */
type Ctx = { body: any; user: any; m: RegExpMatchArray; url: URL }
type Role = "public" | "any" | "CUSTOMER" | "ADMIN"
const routes: [string, RegExp, Role, (c: Ctx) => Promise<[number, any]>][] = [
  ["GET", /^\/health$/, "public", async () => [200, { ok: true, mode: "Interactive Digital Prototype / Concept Simulation" }]],

  ["POST", /^\/auth\/register$/, "public", async ({ body }) => {
    const email = String(body.email || "").trim().toLowerCase(), name = String(body.name || "").trim(), pw = String(body.password || "")
    if (!name || name.length > 60 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 120 || pw.length < 8 || pw.length > 128)
      throw new HttpError(400, "Enter a name, a valid email and a password of 8-128 characters.")
    const hash = await bcrypt.hash(pw, 10)
    await tx(async (c) => {
      if ((await Q(c, "SELECT 1 FROM users WHERE email=$1", [email])).length) throw new HttpError(409, "An account with this email already exists.")
      const id = await nextId(c, "user", "USER-", 3) // role is always CUSTOMER; any role in the body is ignored
      await Q(c, "INSERT INTO users(id,role,name,email,password_hash) VALUES($1,'CUSTOMER',$2,$3,$4)", [id, name, email, hash])
    })
    return [201, { ok: true }]
  }],
  ["POST", /^\/auth\/login$/, "public", ({ body }) => login(body, "CUSTOMER")],
  ["POST", /^\/admin\/login$/, "public", ({ body }) => login(body, "ADMIN")],
  ["GET", /^\/me$/, "any", async ({ user }) => [200, { user: pubUser(user) }]],

  ["POST", /^\/stations\/verify$/, "CUSTOMER", async ({ body, user }) => {
    const s = await findStation(body.qr)
    await logEvent(pool, "Station verified", `${s.id} by ${user.id}`)
    return [200, { station: { id: s.id, name: s.name } }]
  }],
  ["POST", /^\/sessions$/, "CUSTOMER", async ({ body, user }) => {
    const s = await findStation(body.qr)
    const ss = await tx(async (c) => {
      await Q(c, "UPDATE sessions SET status='REPLACED' WHERE user_id=$1 AND status='ACTIVE'", [user.id])
      const id = await nextId(c, "session", "SESSION-", 4)
      const [row] = await Q(c, "INSERT INTO sessions(id,user_id,station_id,status,expires_at) VALUES($1,$2,$3,'ACTIVE', now() + interval '5 minutes') RETURNING *", [id, user.id, s.id])
      await logEvent(c, "Session created", id)
      return row
    })
    return [201, { session: { id: ss.id, userId: ss.user_id, stationId: ss.station_id, status: ss.status, createdAt: ss.created_at, expiresAt: ss.expires_at } }]
  }],
  ["POST", /^\/transactions$/, "CUSTOMER", async ({ body, user }) => {
    // Client-supplied points, rates, userId or balance are never read.
    const r = await recordTransaction(user, body)
    return [r.duplicate ? 200 : 201, r]
  }],
  ["GET", /^\/users\/([^/]+)\/transactions$/, "any", async ({ m, user }) => {
    if (user.id !== m[1] && user.role !== "ADMIN") throw new HttpError(403, FORBIDDEN)
    return [200, { txns: (await Q(pool, "SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC, id DESC", [m[1]])).map(pubTx) }]
  }],

  /* admin */
  ["GET", /^\/admin\/dashboard$/, "ADMIN", async () => {
    const [r] = await Q(pool, `SELECT
      (SELECT COUNT(*) FROM stations WHERE status='ACTIVE')::int AS stations,
      (SELECT COUNT(*) FROM users WHERE role='CUSTOMER')::int AS customers,
      (SELECT COUNT(*) FROM transactions)::int AS txns,
      (SELECT COALESCE(SUM(points_awarded),0) FROM transactions)::int AS points`)
    return [200, r]
  }],
  ["GET", /^\/admin\/stations$/, "ADMIN", async () => [200, { stations: (await Q(pool, "SELECT * FROM stations ORDER BY id")).map(pubStation) }]],
  ["POST", /^\/admin\/stations$/, "ADMIN", async ({ body }) => {
    const id = String(body.id || "").trim().toUpperCase(), qr = String(body.qr || id).trim()
    if (!/^PURNA-\d{3,}$/.test(id)) throw new HttpError(400, "Station ID must look like PURNA-004.")
    if ((await Q(pool, "SELECT 1 FROM stations WHERE id=$1", [id])).length) throw new HttpError(409, "Station ID already exists.")
    await Q(pool, "INSERT INTO stations(id,name,location,status,qr) VALUES($1,$2,$3,'INACTIVE',$4)",
      [id, String(body.name || id).slice(0, 60), String(body.location || "").slice(0, 80), qr]) // unique active-QR index rejects duplicates
    await logEvent(pool, "Station created", id)
    return [201, { ok: true }]
  }],
  ["PATCH", /^\/admin\/stations\/([^/]+)$/, "ADMIN", async ({ m, body: b }) => {
    const [s] = await Q(pool, "SELECT * FROM stations WHERE id=$1", [m[1]])
    if (!s) throw new HttpError(404, "Station not found.")
    const n = { name: s.name, location: s.location, status: s.status, qr: s.qr, qr_active: s.qr_active }
    if ("name" in b) n.name = String(b.name).slice(0, 60)
    if ("location" in b) n.location = String(b.location).slice(0, 80)
    if ("status" in b) { if (!["ACTIVE", "INACTIVE"].includes(b.status)) throw new HttpError(400, "Invalid status."); n.status = b.status }
    if ("qr" in b) { n.qr = String(b.qr).trim(); if (!n.qr) throw new HttpError(400, "QR cannot be empty.") }
    if ("qrActive" in b) n.qr_active = !!b.qrActive
    await Q(pool, "UPDATE stations SET name=$1,location=$2,status=$3,qr=$4,qr_active=$5,updated_at=now() WHERE id=$6", [n.name, n.location, n.status, n.qr, n.qr_active, s.id])
    if ("status" in b) await logEvent(pool, b.status === "ACTIVE" ? "Station activated" : "Station deactivated", s.id)
    if ("qr" in b || "qrActive" in b) await logEvent(pool, "QR updated", s.id)
    return [200, { ok: true }]
  }],
  ["GET", /^\/admin\/rates$/, "ADMIN", async () => [200, { rates: Object.fromEntries((await Q(pool, "SELECT key, points_per_kg FROM rates")).map((r) => [r.key, Number(r.points_per_kg)])) }]],
  ["PUT", /^\/admin\/rates$/, "ADMIN", async ({ body }) => {
    await tx(async (c) => {
      for (const [k, raw] of Object.entries<any>(body)) {
        const [cur] = await Q(c, "SELECT points_per_kg FROM rates WHERE key=$1", [k])
        const v = Number(raw)
        if (!cur) throw new HttpError(400, "Unknown rate.")
        if (raw === "" || raw === null || !Number.isFinite(v) || v < 0 || v > 1000) throw new HttpError(400, "Rates must be between 0 and 1000.")
        if (Number(cur.points_per_kg) !== v) { // future transactions only; stored transactions keep rate_used
          await Q(c, "UPDATE rates SET points_per_kg=$1, updated_at=now() WHERE key=$2", [v, k])
          await logEvent(c, "Point rate updated", `${k}: ${cur.points_per_kg} -> ${v}`)
        }
      }
    })
    return [200, { ok: true }]
  }],
  ["GET", /^\/admin\/customers$/, "ADMIN", async ({ url }) => {
    const q = `%${(url.searchParams.get("search") || "").toLowerCase()}%`
    const rows = await Q(pool, `SELECT u.id,u.name,u.email,u.role,u.balance,u.created_at,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id)::int AS count
      FROM users u WHERE u.role='CUSTOMER' AND (LOWER(u.name) LIKE $1 OR LOWER(u.id) LIKE $1 OR LOWER(u.email) LIKE $1) ORDER BY u.id`, [q])
    return [200, { customers: rows.map((r) => ({ ...pubUser(r), count: r.count })) }]
  }],
  ["GET", /^\/admin\/customers\/([^/]+)$/, "ADMIN", async ({ m }) => {
    const [r] = await Q(pool, "SELECT id,name,email,role,balance,created_at FROM users WHERE id=$1 AND role='CUSTOMER'", [m[1]])
    if (!r) throw new HttpError(404, "Customer not found.")
    const t = await Q(pool, "SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC", [r.id])
    return [200, { customer: pubUser(r), txns: t.map(pubTx) }]
  }],
  ["GET", /^\/admin\/transactions$/, "ADMIN", async ({ url }) => {
    const w: string[] = [], p: any[] = [], sp = url.searchParams
    const add = (cond: string, v: any) => { p.push(v); w.push(cond.replace("?", "$" + p.length)) }
    if (sp.get("station")) add("t.station_id=?", sp.get("station"))
    if (sp.get("category")) add("t.category=?", sp.get("category")!.toUpperCase())
    if (sp.get("user")) add("t.user_id=?", sp.get("user"))
    if (sp.get("status")) add("t.status=?", sp.get("status"))
    if (sp.get("date")) add("t.created_at::date=?::date", sp.get("date"))
    const rows = await Q(pool, `SELECT t.*, u.name AS user_name FROM transactions t JOIN users u ON u.id=t.user_id
      ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY t.created_at DESC LIMIT 500`, p)
    return [200, { txns: rows.map((r) => ({ ...pubTx(r), userName: r.user_name })) }]
  }],
  ["GET", /^\/admin\/events$/, "ADMIN", async () => [200, { events: await Q(pool, "SELECT type AS t, detail AS d, created_at AS at FROM events ORDER BY id DESC LIMIT 200") }]],
]

/* ---------- entry ---------- */
const json = (status: number, data: any) => Response.json(data, { status, headers: { "cache-control": "no-store" } })

export default async (req: Request) => {
  try {
    await ensureSeed()
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/api/, "") || "/"
    const len = Number(req.headers.get("content-length") || 0)
    if (len > 10_000) throw new HttpError(413, "Request too large.")
    let body: any = {}
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      body = await req.json().catch(() => { throw new HttpError(400, "Invalid JSON.") })
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Invalid JSON.")
    }
    for (const [method, re, role, handler] of routes) {
      const m = method === req.method ? re.exec(path) : null
      if (!m) continue
      let user: any = null
      if (role !== "public") {
        user = await authUser(req)
        if (role !== "any" && user.role !== role) throw new HttpError(403, FORBIDDEN)
      }
      const [status, data] = await handler({ body, user, m, url })
      return json(status, data)
    }
    // Unknown /api/admin/* paths still require an admin so customers always get 403 there.
    if (path.startsWith("/admin/") && !path.startsWith("/admin/login")) {
      const u = await authUser(req)
      if (u.role !== "ADMIN") throw new HttpError(403, FORBIDDEN)
    }
    throw new HttpError(404, "Not found.")
  } catch (e: any) {
    if (e instanceof HttpError) return json(e.status, { error: e.message })
    if (e?.code === "23505") return json(409, { error: "Duplicate active QR or value: it already belongs to another record." })
    if (typeof e?.code === "string" && e.code.startsWith("22")) return json(400, { error: "Invalid input." })
    console.error(e) // details stay in server logs only
    return json(500, { error: "Unable to complete the request. No points were added." })
  }
}

export const config: Config = {
  path: "/api/*",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 120 },
}
