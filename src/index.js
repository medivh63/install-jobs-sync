// 两家太阳能公司 job/appointment 聚合 —— Cloudflare Worker + Cron + D1
//  - 定时拉取 Firefly(GraphQL,安装单 + 售后服务单两个源)+ North Energy(SubcontractorHub 平台,REST)
//  - 归一化成统一"未来排期"记录,upsert 进 D1,状态/日期变化时通知
//  - fetch handler 暴露只读接口 /jobs(支持按 source / 日期区间查)给下游(如 solarcrew)消费
//
// 统一记录结构:
//   { source, kind, external_id, ref, customer, address, phone, email,
//     panels, panel_model, note, description, install_date, status }
//
// source 是"数据源"而非"公司":firefly / firefly_service / north_energy。
// Firefly 的安装单和服务单来自两个 query、两套 id 空间(job_id vs service_issue_id),
// 合成一个 source 会在 (source, external_id) 主键上撞车,所以分开。
// kind 是语义:"install" | "service" —— 下游据此决定派什么活,不必认识每个 source。
// install_date 对服务单是 scheduled_fix_date_start(上门修的日子),同一列复用。

const cfg = (env) => ({
  windowDays: Number(env.WINDOW_DAYS ?? 30),
  ffCrewId: env.FF_CREW_ID ?? "15",
  schOrgId: env.SCH_ORG_ID ?? "4973",
  schTz: env.SCH_TZ ?? "America/Edmonton",
  schDetailTtlH: Number(env.SCH_DETAIL_TTL_H ?? 24),
  ffDetailTtlH: Number(env.FF_DETAIL_TTL_H ?? env.SCH_DETAIL_TTL_H ?? 24),
});

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    // 两个接口都要鉴权:/jobs 返回客户 PII,/run 会打供应商接口。
    const denied = authorize(req, env);
    if (denied) return denied;

    // 只读接口:/jobs  可选 ?source=firefly&from=2026-08-01&to=2026-08-31
    if (url.pathname === "/jobs") {
      await ensureSchema(env);
      const p = url.searchParams;
      // 默认只给在途记录。供应商撤掉的行留在库里(审计+复活),但不该再被下游当成活儿。
      const where = p.get("include_gone") ? [] : ["gone_at IS NULL"];
      const binds = [];
      if (p.get("source")) { where.push("source = ?"); binds.push(p.get("source")); }
      if (p.get("from"))   { where.push("install_date >= ?"); binds.push(p.get("from")); }
      if (p.get("to"))     { where.push("install_date <= ?"); binds.push(p.get("to")); }

      const sql =
        "SELECT source, kind, external_id, ref, customer, address, phone, email, panels, panel_model, note, description, install_date, status FROM items" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY install_date";
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return Response.json(results);
    }

    // 手动触发一次(调试用)。必须鉴权:每次都会打两家供应商的接口,
    // 被人反复触发会耗掉配额、把 token 打到限流甚至封禁。
    if (url.pathname === "/run") {
      await runAll(env);
      return new Response("ok\n");
    }

    return new Response("not found", { status: 404 });
  },
};

// 每次运行都确保表存在(CREATE TABLE IF NOT EXISTS,幂等且便宜)。
// 不做内存缓存——否则手动 DROP 表后,warm 实例会以为表还在、不再重建。
async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS items (
      source TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT, ref TEXT, customer TEXT,
      address TEXT, phone TEXT, email TEXT, panels INTEGER, panel_model TEXT, note TEXT,
      description TEXT,
      install_date TEXT, status TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
      gone_at TEXT,
      PRIMARY KEY (source, external_id))`
  ).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_items_install_date ON items (install_date)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_items_source ON items (source)`).run();

  // 老库补列:CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段
  const { results } = await env.DB.prepare(`PRAGMA table_info(items)`).all();
  const have = new Set((results ?? []).map((col) => col.name));
  for (const [name, type] of [["email", "TEXT"], ["kind", "TEXT"], ["panels", "INTEGER"], ["panel_model", "TEXT"], ["note", "TEXT"], ["description", "TEXT"], ["gone_at", "TEXT"]]) {
    if (!have.has(name)) await env.DB.prepare(`ALTER TABLE items ADD COLUMN ${name} ${type}`).run();
  }

  // SCH project 详情缓存(见 loadSchDetails):只存用得上的字段
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sch_projects (
      project_id TEXT PRIMARY KEY, customer TEXT, address TEXT, phone TEXT, email TEXT,
      panels INTEGER, panel_model TEXT, fetched_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ff_jobs (
      job_id TEXT PRIMARY KEY, phone TEXT, email TEXT, panel_model TEXT,
      fetched_at TEXT NOT NULL)`
  ).run();

  const sp = await env.DB.prepare(`PRAGMA table_info(sch_projects)`).all();
  const spHave = new Set((sp.results ?? []).map((col) => col.name));
  for (const [name, type] of [["panels", "INTEGER"], ["panel_model", "TEXT"]]) {
    if (!spHave.has(name)) await env.DB.prepare(`ALTER TABLE sch_projects ADD COLUMN ${name} ${type}`).run();
  }
}

async function runAll(env) {
  await ensureSchema(env);
  const c = cfg(env);
  const { start, end } = futureWindow(c.windowDays);

  const vendors = [
    { id: "firefly", run: () => fetchFirefly(env, c, start, end) },
    { id: "firefly_service", run: () => fetchFireflyService(env, c, start, end) },
    { id: "north_energy", run: () => fetchSch(env, c, start, end) },
  ];

  // 一家挂不能拖垮另一家
  const results = await Promise.allSettled(vendors.map((v) => v.run()));

  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    const r = results[i];
    if (r.status === "rejected") {
      console.error(`[${v.id}] FAILED:`, r.reason?.message || r.reason);
      await alert(env, `${v.id} 拉取失败: ${r.reason?.message || r.reason}`);
      continue; // D1 里上次成功的行原样保留,无需回填
    }
    const n = await syncVendor(env, v.id, r.value, start, end);
    console.log(`[${v.id}] synced ${n} items (${start}~${end})`);
  }
}

// 读旧状态做 diff,再批量 upsert
async function syncVendor(env, source, items, start, end) {
  // 只跟窗口内的旧行比。窗口外的行本来就不会被供应商返回,拿它们比会把"日期已过"
  // 误判成"被取消"。
  const res = await env.DB
    .prepare(
      `SELECT external_id, status, install_date, gone_at FROM items
       WHERE source = ? AND install_date BETWEEN ? AND ?`
    )
    .bind(source, start, end)
    .all();
  const prev = res.results ?? [];

  // 供应商返回空数组、而我们上轮明明有货 —— 更可能是它那边出了问题(token 悄悄失效、
  // 接口降级返回空页),而不是所有工单同时被取消。这时候标记消失会把整个窗口清空,
  // 代价太大。告警,本轮什么都不做。
  if (items.length === 0 && prev.length > 0) {
    await alert(env, `${source} 返回空列表,但窗口内有 ${prev.length} 条在途记录 —— 本轮跳过,不做消失判定`);
    return 0;
  }

  const changes = diff(prev, items);

  const now = new Date().toISOString();
  const upsert = env.DB.prepare(
    `INSERT INTO items
       (source, external_id, kind, ref, customer, address, phone, email, panels, panel_model, note, description, install_date, status, first_seen, last_seen, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       kind=excluded.kind, ref=excluded.ref, customer=excluded.customer, address=excluded.address,
       phone=excluded.phone, email=excluded.email, panels=excluded.panels,
       panel_model=excluded.panel_model, note=excluded.note, description=excluded.description,
       install_date=excluded.install_date, status=excluded.status,
       last_seen=excluded.last_seen,
       gone_at=NULL,
       updated_at=CASE WHEN items.status <> excluded.status OR items.install_date <> excluded.install_date
                       THEN excluded.updated_at ELSE items.updated_at END`
  );
  const batch = items.map((it) =>
    upsert.bind(source, it.external_id, it.kind ?? null, it.ref, it.customer, it.address, it.phone,
                it.email ?? null, it.panels ?? null, it.panel_model ?? null, it.note ?? null,
                it.description ?? null,
                it.install_date, it.status,
                now, now, now)
  );
  if (batch.length) await env.DB.batch(batch); // 原子批量写

  // 本轮没被 upsert 到的窗口内旧行 = 供应商不再上报它了(取消/改到窗口外/被删)。
  // 打上 gone_at,/jobs 从此不再返回它们。行本身留着:是审计线索,而且工单回来时
  // (上面的 gone_at=NULL)能原地复活,不会丢 first_seen。
  await env.DB
    .prepare(
      `UPDATE items SET gone_at = ?
       WHERE source = ? AND install_date BETWEEN ? AND ? AND last_seen < ? AND gone_at IS NULL`
    )
    .bind(now, source, start, end, now)
    .run();

  if (changes.length) await notify(env, source, changes);
  return items.length;
}

// Firefly 的两个数据源共用一个入口。两个查询都不支持服务端日期,统一客户端筛。
async function ffQuery(env, operationName, query, variables) {
  const res = await fetch("https://gql.fireflysolar.tech/graphql/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `ff_session=${must(env.FF_SESSION, "FF_SESSION")}`,
    },
    body: JSON.stringify({ operationName, variables, query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error("firefly graphql: " + JSON.stringify(json.errors).slice(0, 200));
  return json.data ?? {};
}

// ---------- 适配器 A:Firefly 安装单 ----------
async function fetchFirefly(env, c, start, end) {
  const data = await ffQuery(
    env,
    "GetInstallerJobsByCrewId",
    "query GetInstallerJobsByCrewId($installer_crew_id: ID!) {" +
      " getInstallerJobsByCrewId(installer_crew_id: $installer_crew_id) {" +
      " job_id job_number customer_name project_address job_status" +
      " scheduled_install_date_start module_quantity } }",
    { installer_crew_id: c.ffCrewId }
  );

  // 先筛到窗口再拉详情 —— 详情是按 job 一次一个请求的,不筛就会为窗口外的工单白跑。
  const jobs = (data.getInstallerJobsByCrewId ?? []).filter((j) => {
    const d = (j.scheduled_install_date_start || "").slice(0, 10);
    return d && d >= start && d <= end;
  });

  const details = await loadFfDetails(env, c, jobs.map((j) => String(j.job_id)));

  return jobs.map((j) => {
    const d = details.get(String(j.job_id));
    return {
      source: "firefly",
      kind: "install",
      external_id: String(j.job_id),
      ref: j.job_number,
      customer: j.customer_name,
      address: j.project_address ?? null,
      // 列表接口不带联系方式,详情接口才有(getJobDetailsTabByJobId)。
      phone: d?.phone ?? null,
      email: d?.email ?? null,
      panels: j.module_quantity ?? null,
      panel_model: d?.panelModel ?? null,
      note: null,
      install_date: (j.scheduled_install_date_start || "").slice(0, 10) || null,
      status: j.job_status,
    };
  });
}

// Firefly 详情缓存。和 SCH 那套同样的理由:详情是一 job 一请求,不缓存的话每轮
// cron 会把窗口内所有工单重拉一遍。命中且未过期就直接用旧值。
async function loadFfDetails(env, c, ids) {
  const out = new Map();
  if (!ids.length) return out;

  const { results } = await env.DB
    .prepare(`SELECT job_id, phone, email, panel_model AS panelModel, fetched_at FROM ff_jobs
              WHERE job_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const cached = new Map((results ?? []).map((r) => [r.job_id, r]));

  const freshAfter = Date.now() - c.ffDetailTtlH * 3600000;
  const stale = [];
  for (const id of ids) {
    const row = cached.get(id);
    if (row) out.set(id, row);
    if (!row || !(Date.parse(row.fetched_at) >= freshAfter)) stale.push(id);
  }
  if (!stale.length) return out;

  // 组件型号只给了 solar_panel_id,要靠下拉选项表翻译成瓦数。表很小(十几条)且
  // 全组织共用,所以整轮只查一次,而不是每个 job 查一次。
  const panels = await ffPanelWatts(env);

  const fetched = await pooled(stale, 4, async (id) => {
    try {
      return [id, await fetchFfJob(env, id, panels)];
    } catch (e) {
      console.error(`[firefly] detail ${id} failed:`, e.message);
      return null;
    }
  });

  const now = new Date().toISOString();
  const up = env.DB.prepare(
    `INSERT INTO ff_jobs (job_id, phone, email, panel_model, fetched_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(job_id) DO UPDATE SET
       phone=excluded.phone, email=excluded.email,
       panel_model=excluded.panel_model, fetched_at=excluded.fetched_at`
  );
  const batch = [];
  for (const hit of fetched) {
    if (!hit) continue;
    const [id, d] = hit;
    out.set(id, d);
    batch.push(up.bind(id, d.phone, d.email, d.panelModel, now));
  }
  if (batch.length) await env.DB.batch(batch);
  return out;
}

async function fetchFfJob(env, jobId, panels) {
  const data = await ffQuery(
    env,
    "GetJobDetailsTabByJobId",
    "query GetJobDetailsTabByJobId($ff_job_id: Int!) {" +
      " getJobDetailsTabByJobId(ff_job_id: $ff_job_id) {" +
      " customer_phone customer_email solar_panel_id system_size_kw module_quantity } }",
    { ff_job_id: Number(jobId) }
  );
  const d = data.getJobDetailsTabByJobId ?? {};
  return {
    phone: d.customer_phone || null,
    email: d.customer_email || null,
    panelModel: ffPanelModel(d, panels),
  };
}

// 优先查选项表(权威),查不到再用 系统容量÷块数 反推。反推只在两者能整除出一个
// 合理瓦数时才采信 —— system_size_kw 是取整过的,除不尽就说明推不出准确值。
function ffPanelModel(d, panels) {
  const named = panels.get(String(d.solar_panel_id));
  if (named) return `${named}W`;
  const kw = Number(d.system_size_kw), n = Number(d.module_quantity);
  if (!kw || !n) return null;
  const watts = (kw * 1000) / n;
  return Number.isInteger(watts) && watts >= 200 && watts <= 800 ? `${watts}W` : null;
}

// solar_panel_id → 瓦数。选项文案形如 "Solar Panel LONGi 500",取末尾数字。
async function ffPanelWatts(env) {
  const map = new Map();
  try {
    const data = await ffQuery(env, "GetSolarPanelSelectOptions",
      "query GetSolarPanelSelectOptions { getSolarPanelSelectOptions { id value } }", {});
    for (const o of data.getSolarPanelSelectOptions ?? []) {
      const m = String(o.value || "").match(/(\d{3,4})\s*$/);
      if (m) map.set(String(o.id), Number(m[1]));
    }
  } catch (e) {
    console.error("[firefly] panel options failed:", e.message); // 退回反推
  }
  return map;
}

// ---------- 适配器 A2:Firefly 售后服务单(service call)----------
// 独立的 query + 独立的 id 空间(service_issue_id,与 job_id 无关),所以单列一个
// source。混用 "firefly" 会让 service_issue_id 和 job_id 在主键上撞车。
async function fetchFireflyService(env, c, start, end) {
  const data = await ffQuery(
    env,
    "GetInstallerServiceJobsByCrewId",
    "query GetInstallerServiceJobsByCrewId($installer_crew_id: ID!) {" +
      " getInstallerServiceJobsByCrewId(installer_crew_id: $installer_crew_id) {" +
      " service_issue_id issue_summary service_issue_status service_status support_category" +
      " scheduled_fix_date_start job_id job_number customer_name customer_phone" +
      " customer_email project_address service_notes } }",
    { installer_crew_id: c.ffCrewId }
  );

  return (data.getInstallerServiceJobsByCrewId ?? [])
    .map((s) => ({
      source: "firefly_service",
      kind: "service",
      external_id: String(s.service_issue_id),
      ref: s.job_number, // 关联的原始工单号 —— 下游据此对上同一个站点
      customer: s.customer_name,
      address: s.project_address ?? null,
      phone: s.customer_phone ?? null,
      email: s.customer_email ?? null,
      panels: null, // 售后不按板数计件
      panel_model: null,
      description: null,
      note: [s.support_category, s.issue_summary].filter(Boolean).join(": ") || null,
      install_date: (s.scheduled_fix_date_start || "").slice(0, 10) || null,
      status: s.service_issue_status || s.service_status || null,
    }))
    .filter((it) => it.install_date && it.install_date >= start && it.install_date <= end);
}

// ---------- 适配器 B:North Energy(SubcontractorHub 平台,REST,服务端日期,只要 Install 类)----------
async function fetchSch(env, c, start, end) {
  const url =
    `https://api.virtualsaleportal.com/api/${c.schOrgId}/appointments` +
    `?start_date=${start}&end_date=${end}&globalAppointment=true`;

  const res = await fetch(url, { headers: schHeaders(env) });
  if (!res.ok) throw new Error(`sch http ${res.status}`);
  const appts = (await res.json()).data ?? [];

  // 只要"Install - *"类型的预约
  const installs = appts.filter((a) =>
    (a.appointment_type?.name || "").toLowerCase().startsWith("install")
  );

  // 逐个 project 拉详情,拿结构化的姓名/电话/邮箱/地址,取代 description 正则
  const ids = [...new Set(
    installs.map((a) => a.project?.id).filter((v) => v != null).map(String)
  )];
  const details = await loadSchDetails(env, c, ids);

  return installs.map((a) => {
    const pid = a.project?.id != null ? String(a.project.id) : null;
    const d = pid ? details.get(pid) : null;
    const fromDesc = parseDescription(a.description || ""); // 详情拿不到时的兜底
    return {
      source: "north_energy",
      kind: "install", // 已按 "Install - *" 过滤过,这里只会是安装
      external_id: String(a.id),
      ref: pid,
      customer: d?.customer || a.project?.project_name || a.note || null,
      address: d?.address || fromDesc.address,
      phone: d?.phone || fromDesc.phone,
      email: d?.email ?? null,
      // 调度备注(门禁码、狗、停车说明之类)。链接剔掉——它是给他们内部系统用的,
      // 对班组没意义,而且会占满聊天里的一整行。
      description: stripUrls(a.description),
      panels: d?.panels ?? null, // 详情的 no_of_panels;详情挂了就为空
      panel_model: d?.panelModel ?? null, // 详情的 module.panel.watts,拼成 "445W"
      note: null,
      install_date: localDate(a.slot_start_datetime, c.schTz),
      status: a.appointment_type?.name || (a.status ? "done" : "scheduled"),
    };
  });
}

function schHeaders(env) {
  const h = { accept: "application/json", authorization: `Bearer ${must(env.SCH_TOKEN, "SCH_TOKEN")}` };
  if (env.SCH_SID) h["x-sid"] = env.SCH_SID; // 可选:实测不填也能 200,设了才发
  return h;
}

// 详情按 project_id 缓存:cron 每 3 分钟一轮,不做缓存就是每天上万次详情请求。
// 命中且未过期(SCH_DETAIL_TTL_H,默认 24h)直接用旧值,只补缺失/过期的。
async function loadSchDetails(env, c, ids) {
  const out = new Map();
  if (!ids.length) return out;

  const { results } = await env.DB
    .prepare(`SELECT project_id, customer, address, phone, email, panels, panel_model AS panelModel, fetched_at FROM sch_projects
              WHERE project_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const cached = new Map((results ?? []).map((r) => [r.project_id, r]));

  const freshAfter = Date.now() - c.schDetailTtlH * 3600000;
  const stale = [];
  for (const id of ids) {
    const row = cached.get(id);
    if (row) out.set(id, row);
    if (!row || !(Date.parse(row.fetched_at) >= freshAfter)) stale.push(id);
  }
  if (!stale.length) return out;

  // 单个项目失败不影响整轮:该项退回缓存旧值 / description 兜底
  const fetched = await pooled(stale, 4, async (id) => {
    try {
      return [id, await fetchSchProject(env, c, id)];
    } catch (e) {
      console.error(`[north_energy] detail ${id} failed:`, e.message);
      return null;
    }
  });

  const now = new Date().toISOString();
  const up = env.DB.prepare(
    `INSERT INTO sch_projects (project_id, customer, address, phone, email, panels, panel_model, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET
       customer=excluded.customer, address=excluded.address, phone=excluded.phone,
       email=excluded.email, panels=excluded.panels, panel_model=excluded.panel_model,
       fetched_at=excluded.fetched_at`
  );
  const batch = [];
  for (const hit of fetched) {
    if (!hit) continue;
    const [id, d] = hit;
    out.set(id, d);
    batch.push(up.bind(id, d.customer, d.address, d.phone, d.email, d.panels ?? null, d.panelModel ?? null, now));
  }
  if (batch.length) await env.DB.batch(batch);
  return out;
}

// ⚠️ 只挑需要的字段。这个报文里还夹着组织级的第三方集成凭据
// (integrationData.*: financeit access_token/refresh_token、goodleap api_key、
//  各种 basic_auth_password),整包落库或打日志等于把它们抄进 D1/日志。
async function fetchSchProject(env, c, projectId) {
  const res = await fetch(
    `https://api.virtualsaleportal.com/api/${c.schOrgId}/projects/${projectId}`,
    { headers: schHeaders(env) }
  );
  if (!res.ok) throw new Error(`sch detail http ${res.status}`);
  const p = (await res.json()).data ?? {};
  const ct = p.contact ?? {};
  return {
    customer: ct.full_name || [ct.first_name, ct.last_name].filter(Boolean).join(" ") || p.project_name || null,
    // 顶层是安装地址,contact.* 是联系人自己的地址,前者优先
    address: joinAddr(p.street || ct.street, p.city || ct.city, p.state || ct.state, p.postal_code || ct.postal_code),
    phone: ct.phone || null,
    email: ct.email || null,
    // 板数两处都有且实测一致(no_of_panels=14 / designs.total_panels=14)。
    // designs 是对象不是数组。0 是合法值(储能-only 项目),所以用 ?? 不用 ||。
    panels: p.no_of_panels ?? p.designs?.total_panels ?? null,
    // 组件型号在 module.panel.watts(数字)。solarcrew 的 panel_model 是 "445W"
    // 这种瓦数串(它用 parseInt 反解),所以这里就地拼好,下游不用认识两家的格式。
    panelModel: p.module?.panel?.watts ? `${p.module.panel.watts}W` : null,
  };
}

const joinAddr = (...parts) =>
  parts.map((s) => (s || "").trim()).filter(Boolean).join(", ") || null;

// 并发上限 n 的 map,别把对方接口打崩
async function pooled(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

// ---------- 工具 ----------
function futureWindow(days) {
  const now = new Date(); // Worker 里 Date 正常可用
  const end = new Date(now.getTime() + days * 86400000);
  return { start: ymd(now), end: ymd(end) };
}
const ymd = (d) => d.toISOString().slice(0, 10);

// UTC ISO → 指定时区的 YYYY-MM-DD(修正跨日,否则安装日会差一天)
function localDate(iso, tz) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso)); // en-CA → "2026-08-04"
}

// 去掉自由文本里的链接。实测三种分隔风格都存在(" - "、em dash "—"、"---"),
// 而链接前面总挂着一个,所以删完还要收尾——否则备注会以一截孤零零的破折号结束。
function stripUrls(s) {
  if (!s) return null;
  return (
    s
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/[\s\u2013\u2014-]+$/, "")
      .trim() || null
  );
}

// "电话 <分隔> 地址 <分隔> 链接" 自由文本。分隔符不统一(" - " 或 "---"/"------"),
// 按"2+ 连续短横线,或前后带空格的单短横线"切,避免误伤地址内的连字符。启发式,格式大改仍需调整。
function parseDescription(desc) {
  // 链接本身不再入库,但这个匹配仍然必要:它是地址解析的右边界,
  // 去掉的话 URL 会被当成地址的一部分拼进去。
  const m = desc.match(/https?:\/\/\S+/);
  const rest = m ? desc.slice(0, m.index) : desc; // 只取链接之前的部分
  const parts = rest.split(/-{2,}|\s-\s/).map((s) => s.trim()).filter(Boolean);
  let phone = null;
  if (parts.length && /^\+?\d[\d\s()-]{5,}$/.test(parts[0])) phone = parts.shift(); // 抽出开头电话段
  const address = parts.join(" ").replace(/[\s-]+$/, "").trim() || null;
  return { address, phone };
}

// 按 external_id 比对上一次:新增 + 状态/日期变化
function diff(prev, next) {
  const byId = new Map(prev.map((x) => [x.external_id, x]));
  const seen = new Set();
  const out = [];
  for (const it of next) {
    seen.add(it.external_id);
    const old = byId.get(it.external_id);
    if (!old) out.push({ type: "new", item: it });
    else if (old.gone_at) out.push({ type: "returned", item: it }); // 撤销后又排回来
    else if (old.status !== it.status || old.install_date !== it.install_date)
      out.push({ type: "changed", item: it, before: { status: old.status, install_date: old.install_date } });
  }
  // 窗口内的旧行这轮没出现 = 供应商撤了它。只报第一次(gone_at 已置的不再重复),
  // 否则每 3 分钟一轮会把同一条消失记录刷到通知里没完。
  for (const old of prev) {
    if (!seen.has(old.external_id) && !old.gone_at) out.push({ type: "gone", before: old });
  }
  return out;
}

function must(v, name) {
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

// 两个对外路由都要 Bearer READ_TOKEN。返回 Response 表示拒绝,null 表示放行。
//
// fail closed:READ_TOKEN 没配就一律 503,而不是"没配就不校验"。/jobs 返回客户
// 姓名/电话/邮箱/精确地址,secret 打错一个字就全网公开,这个方向不能反。
// 代码里做这件事也顺带覆盖了预览路由(*-install-jobs-sync.*.workers.dev):
// 它和生产共用 secret 与 D1,只在生产上挂 Cloudflare Access 挡不住它。
function authorize(req, env) {
  const path = new URL(req.url).pathname;
  if (path !== "/jobs" && path !== "/run") return null; // 其余走 404

  if (!env.READ_TOKEN)
    return new Response("READ_TOKEN not configured\n", { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${env.READ_TOKEN}`)
    return new Response("unauthorized\n", { status: 401 });
  return null;
}

async function notify(env, source, changes) {
  const lines = changes.map((ch) => {
    switch (ch.type) {
      case "new":
        return `🆕 [${source}] ${ch.item.customer} — ${ch.item.install_date} — ${ch.item.address ?? ""}`;
      case "returned":
        return `↩️ [${source}] ${ch.item.customer} — ${ch.item.install_date} 重新排回窗口`;
      // 只有 id 和日期:消失的记录我们手上没有客户信息(prev 只查了几列)。
      case "gone":
        return `🚫 [${source}] ${ch.before.external_id} — 原定 ${ch.before.install_date},供应商已不再上报(疑似取消)`;
      default:
        return `✏️ [${source}] ${ch.item.customer} — ${ch.before.install_date}→${ch.item.install_date} / ${ch.before.status}→${ch.item.status}`;
    }
  });
  console.log(lines.join("\n"));
  if (env.WEBHOOK_URL) await post(env.WEBHOOK_URL, { text: `*${source}* ${changes.length} 条变化\n` + lines.join("\n") });
}

async function alert(env, msg) {
  console.error("ALERT:", msg);
  if (env.WEBHOOK_URL) await post(env.WEBHOOK_URL, { text: "⚠️ " + msg });
}

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
