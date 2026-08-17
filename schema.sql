-- 统一"未来安装"表:两家归一化后落在这里,(source, external_id) 唯一
-- 注:Worker 启动时会自动 CREATE TABLE IF NOT EXISTS + 补列,此文件仅作参考文档。
CREATE TABLE IF NOT EXISTS items (
  source        TEXT NOT NULL,   -- "firefly" | "firefly_service" | "north_energy"
  external_id   TEXT NOT NULL,   -- 各来源内稳定 id(FF=job_id / FF服务=service_issue_id / SCH=appointment_id)
  kind          TEXT,            -- "install" | "service" —— 下游据此派活,不必认识每个 source
  ref           TEXT,            -- Firefly=job_number / SCH=project_id
  customer      TEXT,
  address       TEXT,            -- SCH=项目详情的 street/city/state/postal;Firefly=project_address
  phone         TEXT,            -- SCH=contact.phone(详情挂了退回 description 解析);Firefly 暂无 → null
  email         TEXT,            -- SCH=contact.email / Firefly服务单=customer_email;Firefly 安装单无 → null
  panels        INTEGER,         -- FF安装单=module_quantity / SCH=详情 no_of_panels;服务单 → null
  note          TEXT,            -- 服务单的 "支持分类: 问题摘要";安装单 → null
  install_date  TEXT,            -- YYYY-MM-DD(本地日);服务单存 scheduled_fix_date_start
  status        TEXT,
  url           TEXT,
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
