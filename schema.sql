-- 统一"未来安装"表:两家归一化后落在这里,(source, external_id) 唯一
-- 注:Worker 启动时会自动 CREATE TABLE IF NOT EXISTS + 补列,此文件仅作参考文档。
CREATE TABLE IF NOT EXISTS items (
  source        TEXT NOT NULL,   -- "firefly" | "firefly_service" | "north_energy"
  external_id   TEXT NOT NULL,   -- 各来源内稳定 id(FF=job_id / FF服务=service_issue_id / SCH=appointment_id)
  kind          TEXT,            -- "install" | "service" —— 下游据此派活,不必认识每个 source
  ref           TEXT,            -- Firefly=job_number / SCH=project_id
  customer      TEXT,
  address       TEXT,            -- SCH=项目详情的 street/city/state/postal;Firefly=project_address
  phone         TEXT,            -- 三个源都有:SCH=详情 contact.phone(挂了退回 description 解析)
                                 -- / FF安装单=详情 customer_phone / FF服务单=列表 customer_phone
  email         TEXT,            -- 同上,对应各自的 email 字段
  panels        INTEGER,         -- FF安装单=module_quantity / SCH=详情 no_of_panels;服务单 → null
  panel_model   TEXT,            -- 组件瓦数,形如 "500W"(solarcrew 用 parseInt 反解)。
                                 -- FF=solar_panel_id 查选项表 / SCH=module.panel.watts
  note          TEXT,            -- 服务单的 "支持分类: 问题摘要";安装单 → null
  description   TEXT,            -- SCH 预约的原始自由文本(调度备注);其余来源 → null
  install_date  TEXT,            -- YYYY-MM-DD(本地日);服务单存 scheduled_fix_date_start
  status        TEXT,
  gone_at       TEXT,            -- 供应商不再上报它的时刻(疑似取消)。非空 = /jobs 不再返回;
                                 -- 工单重新排回来时清空,行本身永不删除(审计线索 + 保住 first_seen)
  first_seen    TEXT NOT NULL,   -- 首次抓到
  last_seen     TEXT NOT NULL,   -- 最近一次抓到(每轮都刷新)
  updated_at    TEXT NOT NULL,   -- 状态/日期真正变化时才刷新
  PRIMARY KEY (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_items_install_date ON items (install_date);
CREATE INDEX IF NOT EXISTS idx_items_source       ON items (source);

-- SubcontractorHub 项目详情缓存:cron 每几分钟一轮,详情按 project 粒度缓存(默认 24h)后再复用。
-- 只存这几列 —— 详情报文里还夹着组织级第三方集成凭据,不能整包落库。
CREATE TABLE IF NOT EXISTS sch_projects (
  project_id  TEXT PRIMARY KEY,  -- SCH project.id
  customer    TEXT,              -- contact.full_name
  address      TEXT,             -- street, city, state, postal_code
  phone       TEXT,              -- contact.phone(+1##########)
  email       TEXT,              -- contact.email
  panels      INTEGER,           -- no_of_panels(与 designs.total_panels 一致)
  fetched_at  TEXT NOT NULL      -- 上次拉详情的时间,过期才重拉
);

-- Firefly 工单详情缓存。列表接口不带联系方式和组件型号,详情要按 job 一个个查
-- (getJobDetailsTabByJobId),不缓存的话每轮 cron 会把窗口内所有工单重拉一遍。
CREATE TABLE IF NOT EXISTS ff_jobs (
  job_id      TEXT PRIMARY KEY,  -- Firefly job_id
  phone       TEXT,              -- customer_phone
  email       TEXT,              -- customer_email
  panel_model TEXT,              -- solar_panel_id 经选项表翻译成的 "500W"
  fetched_at  TEXT NOT NULL      -- 上次拉详情的时间,过期才重拉
);

-- ==================== 供应商预约门户 ====================
-- 供应商在 /(public/index.html)看施工日历、book 安装。同样由 ensureSchema 自动建表。

-- 供应商发起的安装预约,预约即创建 job 信息(地址/板数/组件瓦数 + R2 附件)。
CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,               -- 预约的安装日 YYYY-MM-DD(本地日)
  supplier    TEXT NOT NULL,               -- 供应商/公司名
  contact     TEXT NOT NULL DEFAULT '',    -- 联系人
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL,               -- 安装地址
  panels      INTEGER NOT NULL,            -- 板数
  panel_model TEXT NOT NULL DEFAULT '',    -- 组件瓦数,形如 "500W"(与 items.panel_model 同格式)
  notes       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / confirmed / cancelled
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (date, status);

-- 预约附件(site survey / SLD 单线图):文件体在 R2(FILES 桶),这里只存元数据。
CREATE TABLE IF NOT EXISTS booking_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id   INTEGER NOT NULL REFERENCES bookings(id),
  kind         TEXT NOT NULL,              -- site_survey / sld / other
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  r2_key       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_files_booking ON booking_files (booking_id);

-- 管理员封锁的日期(放假/满班),供应商不可约。
CREATE TABLE IF NOT EXISTS blocked_days (
  date    TEXT PRIMARY KEY,                -- YYYY-MM-DD
  reason  TEXT NOT NULL DEFAULT ''
);
