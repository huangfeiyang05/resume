-- 简历有方：MySQL 8.0.16+ 生产数据模型设计稿。
-- 尚未作为迁移执行；当前应用仍使用 .data/ 本地 JSON，不使用这些表。
-- UUID 由服务端生成；JSON 结构和状态迁移仍需应用层验证。
-- 时间统一存 UTC，连接设置 time_zone = '+00:00'。
-- 金额如后续加入 billing 使用整数分；本设计只覆盖最小业务地基。
-- CHECK 约束依赖 MySQL 8.0.16+ 的实际执行能力，迁移须单独验收。
-- 不包含 DROP/TRUNCATE，不在运行时自动建库或创建用户。

SET NAMES utf8mb4;

CREATE TABLE `user` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  wx_openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('active', 'disabled', 'deleting', 'deleted') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_wx_openid (wx_openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE resume (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(160) NOT NULL,
  target_role VARCHAR(160) NOT NULL DEFAULT '',
  current_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_resume_owner (id, user_id),
  KEY ix_resume_owner_updated (user_id, deleted_at, updated_at),
  CONSTRAINT fk_resume_user FOREIGN KEY (user_id) REFERENCES `user` (id),
  CONSTRAINT ck_resume_revision CHECK (current_revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE resume_version (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  content_json JSON NOT NULL,
  content_hash BINARY(32) NOT NULL COMMENT 'SHA-256 of canonical UTF-8 content; encode with UNHEX at boundary',
  source ENUM('create', 'edit', 'import', 'suggestion', 'restore') NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_version_revision (resume_id, revision),
  UNIQUE KEY uk_version_context (id, resume_id, user_id),
  UNIQUE KEY uk_version_request (user_id, idempotency_key),
  CONSTRAINT fk_version_resume FOREIGN KEY (resume_id, user_id) REFERENCES resume (id, user_id),
  CONSTRAINT ck_version_revision CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE analysis_task (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mode ENUM('diagnose', 'optimize', 'job_match') NOT NULL,
  status ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
  input_json JSON NOT NULL COMMENT 'Immutable version snapshot, target role, JD and authorized knowledge scope',
  input_hash BINARY(32) NOT NULL COMMENT 'Canonical input plus workflow, prompt, model and corpus versions',
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(64) NOT NULL COMMENT 'rules or actual server-side model adapter',
  workflow_version VARCHAR(64) NOT NULL,
  prompt_version VARCHAR(64) NULL,
  model_name VARCHAR(128) NULL,
  knowledge_version VARCHAR(128) NULL,
  output_json JSON NULL,
  usage_json JSON NULL COMMENT 'Provider token/latency/cost telemetry, without private raw prompts',
  error_code VARCHAR(64) NULL,
  retry_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_analysis_request (user_id, idempotency_key),
  UNIQUE KEY uk_analysis_context (id, resume_version_id, resume_id, user_id),
  UNIQUE KEY uk_analysis_owner (id, user_id),
  KEY ix_analysis_owner_created (user_id, created_at),
  KEY ix_analysis_input (user_id, input_hash),
  KEY ix_analysis_queue (status, created_at),
  CONSTRAINT fk_analysis_version FOREIGN KEY (resume_version_id, resume_id, user_id)
    REFERENCES resume_version (id, resume_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE optimization_suggestion (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  analysis_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  field_path VARCHAR(512) NOT NULL COMMENT 'Validated allowlisted field path or text span locator',
  original_text MEDIUMTEXT NOT NULL,
  suggested_text MEDIUMTEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json JSON NULL COMMENT 'Input span and optional authorized retrieval citations',
  requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_state ENUM('not_required', 'pending', 'confirmed') NOT NULL DEFAULT 'not_required',
  confirmed_text MEDIUMTEXT NULL COMMENT 'User-reviewed text with factual placeholders resolved',
  confirmation_json JSON NULL COMMENT 'Confirmed missing facts and provenance; no fabricated default values',
  confirmed_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  confirmed_at DATETIME(3) NULL,
  status ENUM('pending', 'applied', 'dismissed', 'stale') NOT NULL DEFAULT 'pending',
  applied_resume_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  apply_idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  applied_at DATETIME(3) NULL,
  lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_suggestion_apply_request (user_id, apply_idempotency_key),
  KEY ix_suggestion_task (analysis_task_id, status),
  CONSTRAINT fk_suggestion_analysis FOREIGN KEY (analysis_task_id, resume_version_id, resume_id, user_id)
    REFERENCES analysis_task (id, resume_version_id, resume_id, user_id),
  CONSTRAINT fk_suggestion_applied_version FOREIGN KEY (applied_resume_version_id, resume_id, user_id)
    REFERENCES resume_version (id, resume_id, user_id),
  CONSTRAINT fk_suggestion_confirmed_user FOREIGN KEY (confirmed_by_user_id) REFERENCES `user` (id),
  CONSTRAINT ck_suggestion_confirmation CHECK (
    (requires_confirmation = FALSE AND confirmation_state = 'not_required') OR
    (requires_confirmation = TRUE AND confirmation_state IN ('pending', 'confirmed'))
  ),
  CONSTRAINT ck_suggestion_confirmed_actor CHECK (
    (confirmation_state <> 'confirmed' AND confirmed_by_user_id IS NULL AND confirmed_at IS NULL) OR
    (confirmation_state = 'confirmed' AND confirmed_by_user_id IS NOT NULL AND confirmed_by_user_id = user_id
      AND confirmed_at IS NOT NULL AND confirmed_text IS NOT NULL)
  ),
  CONSTRAINT ck_suggestion_applied CHECK (
    (status <> 'applied' AND applied_resume_version_id IS NULL AND applied_at IS NULL) OR
    (status = 'applied' AND applied_resume_version_id IS NOT NULL AND applied_at IS NOT NULL
      AND apply_idempotency_key IS NOT NULL AND confirmation_state <> 'pending')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE entitlement_ledger (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entitlement_type ENUM('ai_call', 'export') NOT NULL,
  scope_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Explicit grant bucket; e.g. plan UUID or resume UUID',
  operation ENUM('grant', 'reserve', 'consume', 'release', 'revoke') NOT NULL,
  available_delta BIGINT NOT NULL,
  reserved_delta BIGINT NOT NULL DEFAULT 0,
  available_balance_after BIGINT NOT NULL,
  reserved_balance_after BIGINT NOT NULL,
  source_type VARCHAR(32) NOT NULL COMMENT 'Future verified order, ad reward, trial, or task',
  source_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  analysis_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reservation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'reserve row for consume/release',
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_hash BINARY(32) NOT NULL COMMENT 'Reject reuse of same key with a different business operation',
  expires_at DATETIME(3) NULL COMMENT 'Same fixed expiry for every row in a grant bucket; NULL means no expiry',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_ledger_request (user_id, idempotency_key),
  UNIQUE KEY uk_ledger_context (id, user_id, entitlement_type, scope_key),
  KEY ix_ledger_balance (user_id, entitlement_type, scope_key, created_at),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES `user` (id),
  CONSTRAINT fk_ledger_task FOREIGN KEY (analysis_task_id, user_id) REFERENCES analysis_task (id, user_id),
  CONSTRAINT fk_ledger_reservation FOREIGN KEY (reservation_id, user_id, entitlement_type, scope_key)
    REFERENCES entitlement_ledger (id, user_id, entitlement_type, scope_key),
  CONSTRAINT ck_ledger_balance CHECK (available_balance_after >= 0 AND reserved_balance_after >= 0),
  CONSTRAINT ck_ledger_deltas CHECK (
    (operation = 'grant' AND available_delta > 0 AND reserved_delta = 0 AND reservation_id IS NULL) OR
    (operation = 'reserve' AND available_delta < 0 AND reserved_delta = -available_delta AND reservation_id IS NULL) OR
    (operation = 'consume' AND available_delta = 0 AND reserved_delta < 0 AND reservation_id IS NOT NULL) OR
    (operation = 'release' AND available_delta > 0 AND reserved_delta = -available_delta AND reservation_id IS NOT NULL) OR
    (operation = 'revoke' AND available_delta < 0 AND reserved_delta = 0 AND reservation_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE export_task (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resume_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  template_key VARCHAR(64) NOT NULL,
  renderer_version VARCHAR(64) NOT NULL,
  status ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
  input_hash BINARY(32) NOT NULL COMMENT 'Fixed resume content, template and renderer versions',
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entitlement_scope_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Private object key; never public URL or signed URL',
  file_hash BINARY(32) NULL,
  error_code VARCHAR(64) NULL,
  retry_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_export_request (user_id, idempotency_key),
  KEY ix_export_owner_created (user_id, created_at),
  KEY ix_export_queue (status, created_at),
  CONSTRAINT fk_export_version FOREIGN KEY (resume_version_id, resume_id, user_id)
    REFERENCES resume_version (id, resume_id, user_id),
  CONSTRAINT ck_export_file CHECK (status <> 'succeeded' OR (object_key IS NOT NULL AND file_hash IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 应用层与迁移验收必须落实以下事务不变量：
-- 1. user_id 来自服务端可信会话。复合外键避免关联到其他用户资源，
--    但不能代替所有 SELECT/UPDATE/DELETE 的归属条件；MySQL 不自动提供本产品的行级权限。
-- 2. resume_version 内容不可修改；编辑/应用/恢复均 INSERT 新版本。
--    在同一事务内校验 expected current_revision / lock_version，写新版本并更新 resume 指针。
--    current_revision 的目标行存在性由该事务保证，不能只更新数字。
-- 3. 建议应用时锁定 suggestion 与 resume，验证 task succeeded、原始版本/原文仍一致，
--    未解决事实占位不能应用。保存 confirmed_text、确认人、确认时间与新版本，提交后再返回成功。
--    重试查已应用记录返回已有结果；相同幂等键但输入 hash 不同返回冲突。
-- 4. analysis_task.input_json/input_hash 与模型/提示/工作流/知识库版本在执行前固定。
--    input_hash 用于校验和可选复用，不设全局唯一键；合法重新分析可以产生新任务。
-- 5. ledger 是只追加账本，不 UPDATE/DELETE 旧流水。最小实现先 SELECT user FOR UPDATE，
--    再按 user + entitlement_type + scope_key 计算并锁定余额，校验可用额和过期时间后追加流水。
--    scope_key 使用单一有效期授予桶；桶内所有流水沿用同一 expires_at，
--    按桶汇总可用余额后排除过期桶，不能只过滤某些流水或混合不同到期时间。
--    consume/release 必须引用该桶的 reserve，锁定预占记录，确保累计结算不超过原预占；
--    过期桶不再预占，已有预占的结算/释放按固定业务规则处理，不凭客户端额度结算。
--    task 状态与结算在同一事务；失败释放，成功 consume；消费和释放不能同时全额完成。
-- 6. export 的同版本重试复用已授予资格。每次下载都鉴权与检查归属、资格有效期，
--    临时生成短期签名 URL，不将公开下载地址写入数据库；文件生成失败不重复扣额度。
-- 7. 当前最小表集未包含订单、支付、广告凭证、完整会员、模板管理、身份会话与审计表。
--    接入这些领域时新增正式迁移及外键，不将 source_id 字符串当作支付已验证的证据。
-- 8. 删除策略由隐私保留期限决定：用户进入 deleting 后停止任务/新调用，
--    删除私有对象与个人数据，再按依赖顺序清理或匿名化；外键默认限制级联删除，避免无意损失证据。
