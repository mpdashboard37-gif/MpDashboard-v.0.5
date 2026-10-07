CREATE DATABASE IF NOT EXISTS `inpace_crm` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `inpace_crm`;

CREATE TABLE IF NOT EXISTS `staff` (
    `id` VARCHAR(255) NOT NULL,
    `employee_id` VARCHAR(255) NOT NULL UNIQUE,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NULL UNIQUE,
    `phone` VARCHAR(255) NULL,
    `department` VARCHAR(255) NULL,
    `designation` VARCHAR(255) NULL,
    `login_id` VARCHAR(255) NOT NULL UNIQUE,
    `password_hash` TEXT NOT NULL,
    `role` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Active',
    `account_status` VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
    `manager_id` VARCHAR(255) NULL,
    `failed_login_attempts` INT NOT NULL DEFAULT 0,
    `deactivated_at` DATETIME NULL,
    `deactivation_reason` TEXT NULL,
    `blocked_until` DATETIME NULL,
    `reactivated_at` DATETIME NULL,
    `reactivated_by` VARCHAR(255) NULL,
    `last_login_at` DATETIME NULL,
    `last_logout_at` DATETIME NULL,
    `auth_method` VARCHAR(255) NULL,
    `google_email` VARCHAR(255) NULL UNIQUE,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    CONSTRAINT `fk_staff_manager` FOREIGN KEY (`manager_id`) REFERENCES `staff`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `access_requests` (
    `id` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(255) NULL,
    `request_data` TEXT NOT NULL DEFAULT '{}',
    `password_hash` TEXT NOT NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Pending',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `approved_at` DATETIME NULL,
    `approved_by` VARCHAR(255) NULL,
    `rejected_at` DATETIME NULL,
    `rejected_by` VARCHAR(255) NULL,
    `rejection_reason` TEXT NULL,
    `eligible_again_at` DATETIME NULL,
    PRIMARY KEY (`id`),
    KEY `idx_access_requests_email_created` (`email`, `created_at`),
    KEY `idx_access_requests_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
    `token_hash` VARCHAR(255) NOT NULL,
    `staff_id` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME NOT NULL,
    `used_at` DATETIME NULL,
    PRIMARY KEY (`token_hash`),
    KEY `idx_password_reset_tokens_staff_id` (`staff_id`),
    CONSTRAINT `fk_password_reset_tokens_staff` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sessions` (
    `token_hash` VARCHAR(255) NOT NULL,
    `staff_id` VARCHAR(255) NOT NULL,
    `user_json` TEXT NOT NULL,
    `expires_at` DATETIME NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`token_hash`),
    KEY `idx_sessions_staff_id` (`staff_id`),
    CONSTRAINT `fk_sessions_staff` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `leads` (
    `id` VARCHAR(255) NOT NULL,
    `lead_number` VARCHAR(50) NULL UNIQUE,
    `customer_name` VARCHAR(255) NOT NULL,
    `mobile_number` VARCHAR(255) NOT NULL UNIQUE,
    `email` VARCHAR(255) NULL,
    `lead_date` DATE NOT NULL,
    `lead_source` VARCHAR(255) NOT NULL,
    `assigned_to` VARCHAR(255) NULL,
    `stage` VARCHAR(255) NOT NULL,
    `priority` VARCHAR(255) NULL,
    `location` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Active',
    `details_json` TEXT NULL,
    `created_by` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_leads_assigned_to` (`assigned_to`),
    KEY `idx_leads_stage` (`stage`),
    KEY `idx_leads_created_at` (`created_at`),
    CONSTRAINT `fk_leads_staff_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `staff`(`id`) ON DELETE SET NULL,
    CONSTRAINT `fk_leads_created_by` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `follow_ups` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `due_at` DATETIME NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `assigned_to` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Pending',
    `task_status` VARCHAR(255) NOT NULL DEFAULT 'PENDING',
    `task_title` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `outcome` TEXT NULL,
    `missed_reason` TEXT NULL,
    `completed_at` DATETIME NULL,
    `completed_by` VARCHAR(255) NULL,
    `task_completed_at` DATETIME NULL,
    `task_completed_by` VARCHAR(255) NULL,
    `task_related_type` VARCHAR(255) NULL,
    `task_related_id` VARCHAR(255) NULL,
    `created_by` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_follow_ups_lead_due` (`lead_id`, `due_at`),
    KEY `idx_follow_ups_due_at` (`due_at`),
    KEY `idx_follow_ups_status` (`status`, `task_status`),
    CONSTRAINT `fk_follow_ups_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_follow_ups_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `staff`(`id`) ON DELETE RESTRICT,
    CONSTRAINT `fk_follow_ups_created_by` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `lead_stage_history` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `stage` VARCHAR(255) NOT NULL,
    `started_at` DATETIME NOT NULL,
    `completed_at` DATETIME NULL,
    `completed_by` VARCHAR(255) NULL,
    `duration_seconds` INT NULL,
    `remarks` TEXT NULL,
    PRIMARY KEY (`id`),
    KEY `idx_stage_history_lead_started` (`lead_id`, `started_at`),
    CONSTRAINT `fk_stage_history_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_stage_history_completed_by` FOREIGN KEY (`completed_by`) REFERENCES `staff`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `lead_activities` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `activity_type` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `user_id` VARCHAR(255) NULL,
    `related_record_type` VARCHAR(255) NULL,
    `related_record_id` VARCHAR(255) NULL,
    `previous_value` TEXT NULL,
    `new_value` TEXT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_lead_activities_lead_created` (`lead_id`, `created_at`),
    CONSTRAINT `fk_lead_activities_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_lead_activities_user` FOREIGN KEY (`user_id`) REFERENCES `staff`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `opportunities` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL UNIQUE,
    `customer_name` VARCHAR(255) NOT NULL,
    `system_capacity` VARCHAR(255) NULL,
    `estimated_value` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `assigned_to` VARCHAR(255) NULL,
    `expected_close_date` DATE NULL,
    `probability` DECIMAL(5,2) NOT NULL DEFAULT 0,
    `stage` VARCHAR(255) NOT NULL DEFAULT 'Qualified',
    `lost_reason` TEXT NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Active',
    `closing_date` DATE NULL,
    `closing_value` DECIMAL(18,2) NULL,
    `closing_remarks` TEXT NULL,
    `source` VARCHAR(255) NULL,
    `priority` VARCHAR(255) NOT NULL DEFAULT 'Medium',
    `notes` TEXT NULL,
    `created_by` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    CONSTRAINT `fk_opportunities_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_opportunities_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `staff`(`id`) ON DELETE SET NULL,
    CONSTRAINT `fk_opportunities_created_by` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `proposals` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `survey_id` VARCHAR(255) NULL,
    `amount` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `discount` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Draft',
    `created_by` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_proposals_lead_id` (`lead_id`),
    CONSTRAINT `fk_proposals_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_proposals_created_by` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `surveys` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL UNIQUE,
    `survey_date` DATETIME NOT NULL,
    `assigned_to` VARCHAR(255) NOT NULL,
    `customer` VARCHAR(255) NOT NULL,
    `address` TEXT NOT NULL,
    `sanctioned_load` TEXT NOT NULL,
    `electricity_details` TEXT NOT NULL,
    `roof_information` TEXT NOT NULL,
    `feasibility` TEXT NULL,
    `recommended_capacity` VARCHAR(255) NOT NULL,
    `remarks` TEXT NULL,
    `survey_type` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Scheduled',
    `completed_at` DATETIME NULL,
    `latitude` VARCHAR(255) NULL,
    `longitude` VARCHAR(255) NULL,
    `location_accuracy` VARCHAR(255) NULL,
    `location_captured_at` DATETIME NULL,
    `completion_data_json` TEXT NULL,
    PRIMARY KEY (`id`),
    KEY `idx_surveys_status_date` (`status`, `survey_date`),
    CONSTRAINT `fk_surveys_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_surveys_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `survey_files` (
    `id` VARCHAR(255) NOT NULL,
    `survey_id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `category` VARCHAR(255) NOT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `original_file_name` VARCHAR(255) NULL,
    `mime_type` VARCHAR(255) NOT NULL,
    `file_size` INT NOT NULL DEFAULT 0,
    `file_data` LONGTEXT NULL,
    `uploaded_by` VARCHAR(255) NOT NULL,
    `uploaded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `latitude` VARCHAR(255) NULL,
    `longitude` VARCHAR(255) NULL,
    `storage_path` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'UPLOADED',
    PRIMARY KEY (`id`),
    KEY `idx_survey_files_survey_id` (`survey_id`),
    CONSTRAINT `fk_survey_files_survey` FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_survey_files_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_survey_files_uploader` FOREIGN KEY (`uploaded_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `notifications` (
    `id` VARCHAR(255) NOT NULL,
    `user_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NULL,
    `message` TEXT NOT NULL,
    `record_type` VARCHAR(255) NULL,
    `record_id` VARCHAR(255) NULL,
    `read_at` DATETIME NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_notifications_user_created` (`user_id`, `created_at`),
    CONSTRAINT `fk_notifications_user` FOREIGN KEY (`user_id`) REFERENCES `staff`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `inventory` (
    `id` VARCHAR(255) NOT NULL,
    `product` VARCHAR(255) NOT NULL UNIQUE,
    `sku` VARCHAR(255) NULL UNIQUE,
    `category` VARCHAR(255) NULL,
    `subcategory` VARCHAR(255) NULL,
    `brand` VARCHAR(255) NULL,
    `model` VARCHAR(255) NULL,
    `specification` TEXT NULL,
    `unit` VARCHAR(255) NOT NULL DEFAULT 'unit',
    `purchase_price` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `selling_price` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `opening_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `total_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `available_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `reserved_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `issued_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `damaged_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `returned_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `minimum_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `maximum_stock` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `reorder_level` DECIMAL(18,2) NOT NULL DEFAULT 0,
    `warehouse` VARCHAR(255) NULL,
    `rack_bin` VARCHAR(255) NULL,
    `supplier` VARCHAR(255) NULL,
    `warranty_information` TEXT NULL,
    `requires_serial` BOOLEAN NOT NULL DEFAULT FALSE,
    `requires_batch` BOOLEAN NOT NULL DEFAULT FALSE,
    `status` VARCHAR(255) NOT NULL DEFAULT 'Active',
    `created_by` VARCHAR(255) NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    CONSTRAINT `fk_inventory_created_by` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `inventory_movements` (
    `id` VARCHAR(255) NOT NULL,
    `inventory_id` VARCHAR(255) NOT NULL,
    `action` VARCHAR(255) NOT NULL,
    `quantity` DECIMAL(18,2) NOT NULL,
    `previous_stock` DECIMAL(18,2) NOT NULL,
    `new_stock` DECIMAL(18,2) NOT NULL,
    `user_id` VARCHAR(255) NOT NULL,
    `reference_id` VARCHAR(255) NULL,
    `project_id` VARCHAR(255) NULL,
    `lead_id` VARCHAR(255) NULL,
    `batch_number` VARCHAR(255) NULL,
    `serial_numbers` TEXT NULL,
    `warehouse` VARCHAR(255) NULL,
    `remarks` TEXT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_inventory_movements_inventory` (`inventory_id`, `created_at`),
    CONSTRAINT `fk_inventory_movements_inventory` FOREIGN KEY (`inventory_id`) REFERENCES `inventory`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_inventory_movements_user` FOREIGN KEY (`user_id`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `audit_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` VARCHAR(255) NOT NULL,
    `action` VARCHAR(255) NOT NULL,
    `record_type` VARCHAR(255) NOT NULL,
    `record_id` VARCHAR(255) NOT NULL,
    `details` TEXT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_audit_logs_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `lead_documents` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `document_type` VARCHAR(255) NOT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `original_file_name` VARCHAR(255) NULL,
    `mime_type` VARCHAR(255) NULL,
    `file_size` INT NOT NULL DEFAULT 0,
    `uploaded_by` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `storage_path` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'UPLOADED',
    PRIMARY KEY (`id`),
    KEY `idx_lead_documents_lead` (`lead_id`, `created_at`),
    CONSTRAINT `fk_lead_documents_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_lead_documents_uploader` FOREIGN KEY (`uploaded_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `lead_communications` (
    `id` VARCHAR(255) NOT NULL,
    `lead_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `recipient` VARCHAR(255) NULL,
    `subject` VARCHAR(255) NULL,
    `message` TEXT NULL,
    `status` VARCHAR(255) NOT NULL,
    `created_by` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_lead_communications_lead` (`lead_id`, `created_at`),
    CONSTRAINT `fk_lead_communications_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_lead_communications_creator` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `lead_followers` (
    `lead_id` VARCHAR(255) NOT NULL,
    `staff_id` VARCHAR(255) NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`lead_id`, `staff_id`),
    CONSTRAINT `fk_lead_followers_lead` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_lead_followers_staff` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
