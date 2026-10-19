-- X POS Local MariaDB Schema
-- This file runs on first launch and on every app start (idempotent).
-- All tables use CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `sync_meta` (
  `key` VARCHAR(255) NOT NULL PRIMARY KEY,
  `value` TEXT,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `app_settings` (
  `key` VARCHAR(255) NOT NULL PRIMARY KEY,
  `value` TEXT,
  `category` VARCHAR(100) DEFAULT 'general',
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `companies` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `company_name` VARCHAR(255) DEFAULT NULL,
  `abbr` VARCHAR(50) DEFAULT NULL,
  `default_currency` VARCHAR(10) DEFAULT NULL,
  `country` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cost_centers` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `cost_center_name` VARCHAR(255) DEFAULT NULL,
  `parent_cost_center` VARCHAR(255) DEFAULT NULL,
  `is_group` TINYINT(1) DEFAULT 0,
  `company` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_company` (`company`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `countries` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `code` VARCHAR(10) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `currencies` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `currency_name` VARCHAR(255) DEFAULT NULL,
  `symbol` VARCHAR(10) DEFAULT NULL,
  `number_format` VARCHAR(20) DEFAULT NULL,
  `smallest_currency_fraction_value` DECIMAL(18,6) DEFAULT 0,
  `symbol_on_right` TINYINT(1) DEFAULT 0,
  `enabled` TINYINT(1) DEFAULT 1,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `warehouses` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `warehouse_name` VARCHAR(255) DEFAULT NULL,
  `parent_warehouse` VARCHAR(255) DEFAULT NULL,
  `is_group` TINYINT(1) DEFAULT 0,
  `company` VARCHAR(255) DEFAULT NULL,
  `disabled` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_company` (`company`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `accounts` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_name` VARCHAR(255) DEFAULT NULL,
  `account_type` VARCHAR(255) DEFAULT NULL,
  `parent_account` VARCHAR(255) DEFAULT NULL,
  `root_type` VARCHAR(50) DEFAULT NULL,
  `is_group` TINYINT(1) DEFAULT 0,
  `company` VARCHAR(255) DEFAULT NULL,
  `disabled` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_account_type` (`account_type`),
  INDEX `idx_company` (`company`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `price_lists` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `price_list_name` VARCHAR(255) DEFAULT NULL,
  `buying` TINYINT(1) DEFAULT 0,
  `selling` TINYINT(1) DEFAULT 0,
  `currency` VARCHAR(10) DEFAULT NULL,
  `enabled` TINYINT(1) DEFAULT 1,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uom` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `uom_name` VARCHAR(255) DEFAULT NULL,
  `enabled` TINYINT(1) DEFAULT 1,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uom_conversion_details` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `uom` VARCHAR(255) DEFAULT NULL,
  `conversion_factor` DECIMAL(18,6) DEFAULT 1,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `brands` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `brand` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `industries` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `industry` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `items` (
  `item_code` VARCHAR(255) NOT NULL PRIMARY KEY,
  `item_name` VARCHAR(255) NOT NULL,
  `local_item_name` VARCHAR(255) DEFAULT NULL,
  `item_group` VARCHAR(255) DEFAULT NULL,
  `brand` VARCHAR(255) DEFAULT NULL,
  `description` TEXT,
  `stock_uom` VARCHAR(50) DEFAULT NULL,
  `image` TEXT,
  `has_serial_no` TINYINT(1) DEFAULT 0,
  `has_batch_no` TINYINT(1) DEFAULT 0,
  `has_variants` TINYINT(1) DEFAULT 0,
  `variant_of` VARCHAR(255) DEFAULT NULL,
  `is_stock_item` TINYINT(1) DEFAULT 1,
  `disabled` TINYINT(1) DEFAULT 0,
  `standard_rate` DECIMAL(18,6) DEFAULT 0,
  `item_tax_template` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_item_name` (`item_name`),
  INDEX `idx_item_group` (`item_group`),
  INDEX `idx_brand` (`brand`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_barcodes` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `barcode` VARCHAR(255) NOT NULL,
  `barcode_type` VARCHAR(100) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`),
  INDEX `idx_barcode` (`barcode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_groups` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent_item_group` VARCHAR(255) DEFAULT NULL,
  `is_group` TINYINT(1) DEFAULT 0,
  `image` TEXT,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_prices` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `item_code` VARCHAR(255) NOT NULL,
  `item_name` VARCHAR(255) DEFAULT NULL,
  `price_list` VARCHAR(255) NOT NULL,
  `buying` TINYINT(1) DEFAULT 0,
  `selling` TINYINT(1) DEFAULT 0,
  `currency` VARCHAR(10) DEFAULT NULL,
  `price_list_rate` DECIMAL(18,6) DEFAULT 0,
  `uom` VARCHAR(255) DEFAULT NULL,
  `min_qty` DECIMAL(18,6) DEFAULT 0,
  `valid_from` DATE DEFAULT NULL,
  `valid_upto` DATE DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_item_code` (`item_code`),
  INDEX `idx_price_list` (`price_list`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_reorder_levels` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `warehouse` VARCHAR(255) DEFAULT NULL,
  `warehouse_reorder_level` DECIMAL(18,6) DEFAULT 0,
  `warehouse_reorder_qty` DECIMAL(18,6) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`),
  INDEX `idx_warehouse` (`warehouse`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_tax_templates` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `title` VARCHAR(255) DEFAULT NULL,
  `company` VARCHAR(255) DEFAULT NULL,
  `disabled` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_company` (`company`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_tax_template_details` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `tax_type` VARCHAR(255) DEFAULT NULL,
  `tax_rate` DECIMAL(18,6) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_taxes` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `item_tax_template` VARCHAR(255) DEFAULT NULL,
  `tax_category` VARCHAR(255) DEFAULT NULL,
  `valid_from` DATE DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`),
  INDEX `idx_item_tax_template` (`item_tax_template`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_vendors` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `supplier` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`),
  INDEX `idx_supplier` (`supplier`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customers` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `customer_name` VARCHAR(255) NOT NULL,
  `customer_group` VARCHAR(255) DEFAULT NULL,
  `customer_type` VARCHAR(50) DEFAULT NULL,
  `territory` VARCHAR(255) DEFAULT NULL,
  `tax_category` VARCHAR(255) DEFAULT NULL,
  `mobile_no` VARCHAR(50) DEFAULT NULL,
  `email_id` VARCHAR(255) DEFAULT NULL,
  `default_currency` VARCHAR(10) DEFAULT NULL,
  `loyalty_program` VARCHAR(255) DEFAULT NULL,
  `loyalty_points` INT DEFAULT 0,
  `discount` DECIMAL(10,4) DEFAULT 0,
  `default_price_list` VARCHAR(255) DEFAULT NULL,
  `disabled` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `is_local` TINYINT(1) DEFAULT 0,
  `local_id` VARCHAR(100) DEFAULT NULL,
  INDEX `idx_customer_name` (`customer_name`),
  INDEX `idx_mobile_no` (`mobile_no`),
  INDEX `idx_email_id` (`email_id`),
  INDEX `idx_local_id` (`local_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `suppliers` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `supplier_name` VARCHAR(255) NOT NULL,
  `supplier_group` VARCHAR(255) DEFAULT NULL,
  `supplier_type` VARCHAR(255) DEFAULT NULL,
  `default_currency` VARCHAR(10) DEFAULT NULL,
  `mobile_no` VARCHAR(50) DEFAULT NULL,
  `email_id` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_supplier_name` (`supplier_name`),
  INDEX `idx_mobile_no` (`mobile_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `modes_of_payment` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `type` VARCHAR(50) DEFAULT NULL,
  `pos_tender_currency` VARCHAR(10) DEFAULT NULL,
  `enabled` TINYINT(1) DEFAULT 1,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `currency_exchange_rates` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `from_currency` VARCHAR(10) NOT NULL,
  `to_currency` VARCHAR(10) NOT NULL,
  `exchange_rate` DECIMAL(21,9) NOT NULL DEFAULT 0,
  `date` DATE NOT NULL,
  `for_selling` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_rate` (`from_currency`, `to_currency`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `mode_of_payment_accounts` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `company` VARCHAR(255) DEFAULT NULL,
  `default_account` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`),
  INDEX `idx_company` (`company`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_profiles` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `company` VARCHAR(255) DEFAULT NULL,
  `warehouse` VARCHAR(255) DEFAULT NULL,
  `cost_center` VARCHAR(255) DEFAULT NULL,
  `currency` VARCHAR(10) DEFAULT NULL,
  `selling_price_list` VARCHAR(255) DEFAULT NULL,
  `write_off_account` VARCHAR(255) DEFAULT NULL,
  `write_off_cost_center` VARCHAR(255) DEFAULT NULL,
  `customer` VARCHAR(255) DEFAULT NULL,
  `income_account` VARCHAR(255) DEFAULT NULL,
  `expense_account` VARCHAR(255) DEFAULT NULL,
  `taxes_and_charges` VARCHAR(255) DEFAULT NULL,
  `tax_category` VARCHAR(255) DEFAULT NULL,
  `apply_discount_on` VARCHAR(50) DEFAULT NULL,
  `disabled` TINYINT(1) DEFAULT 0,
  `allow_rate_change` TINYINT(1) DEFAULT 0,
  `allow_change_posting_date` TINYINT(1) DEFAULT 0,
  `hide_images` TINYINT(1) DEFAULT 0,
  `hide_unavailable_items` TINYINT(1) DEFAULT 0,
  `block_sale_beyond_available_qty` TINYINT(1) DEFAULT 0,
  `cash_mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `apply_customer_discount` TINYINT(1) DEFAULT 0,
  `allow_print_draft_invoices` TINYINT(1) DEFAULT 0,
  `use_offline_mode` TINYINT(1) DEFAULT 0,
  `force_price_from_customer_price_list` TINYINT(1) DEFAULT 0,
  `allow_zero_rated_items` TINYINT(1) DEFAULT 0,
  `use_delivery_charges` TINYINT(1) DEFAULT 0,
  `auto_set_delivery_charges` TINYINT(1) DEFAULT 0,
  `max_discount_percentage_allowed` DECIMAL(10,4) DEFAULT 0,
  `hide_expected_amount` TINYINT(1) DEFAULT 0,
  `use_customer_credit` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_company` (`company`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_payment_methods` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `default` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bins` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `item_code` VARCHAR(255) NOT NULL,
  `warehouse` VARCHAR(255) NOT NULL,
  `actual_qty` DECIMAL(18,6) DEFAULT 0,
  `projected_qty` DECIMAL(18,6) DEFAULT 0,
  `reserved_qty` DECIMAL(18,6) DEFAULT 0,
  `ordered_qty` DECIMAL(18,6) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_item_code` (`item_code`),
  INDEX `idx_warehouse` (`warehouse`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_taxes_templates` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `title` VARCHAR(255) DEFAULT NULL,
  `company` VARCHAR(255) DEFAULT NULL,
  `tax_category` VARCHAR(255) DEFAULT NULL,
  `disabled` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_company` (`company`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_taxes_charges` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `charge_type` VARCHAR(255) DEFAULT NULL,
  `account_head` VARCHAR(255) DEFAULT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `rate` DECIMAL(18,6) DEFAULT 0,
  `tax_amount` DECIMAL(18,6) DEFAULT 0,
  `included_in_print_rate` TINYINT(1) DEFAULT 0,
  `idx` INT DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent` (`parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pricing_rules` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `title` VARCHAR(255) DEFAULT NULL,
  `apply_on` VARCHAR(50) DEFAULT NULL,
  `price_or_product_discount` VARCHAR(50) DEFAULT NULL,
  `rate_or_discount` VARCHAR(50) DEFAULT NULL,
  `selling` TINYINT(1) DEFAULT 0,
  `buying` TINYINT(1) DEFAULT 0,
  `applicable_for` VARCHAR(50) DEFAULT NULL,
  `company` VARCHAR(255) DEFAULT NULL,
  `customer` VARCHAR(255) DEFAULT NULL,
  `customer_group` VARCHAR(255) DEFAULT NULL,
  `territory` VARCHAR(255) DEFAULT NULL,
  `sales_partner` VARCHAR(255) DEFAULT NULL,
  `campaign` VARCHAR(255) DEFAULT NULL,
  `for_price_list` VARCHAR(255) DEFAULT NULL,
  `warehouse` VARCHAR(255) DEFAULT NULL,
  `min_qty` DECIMAL(18,6) DEFAULT 0,
  `max_qty` DECIMAL(18,6) DEFAULT 0,
  `min_amt` DECIMAL(18,6) DEFAULT 0,
  `max_amt` DECIMAL(18,6) DEFAULT 0,
  `valid_from` DATE DEFAULT NULL,
  `valid_upto` DATE DEFAULT NULL,
  `discount_percentage` DECIMAL(18,6) DEFAULT 0,
  `discount_amount` DECIMAL(18,6) DEFAULT 0,
  `rate` DECIMAL(18,6) DEFAULT 0,
  `margin_type` VARCHAR(50) DEFAULT NULL,
  `margin_rate_or_amount` DECIMAL(18,6) DEFAULT 0,
  `priority` INT DEFAULT 0,
  `disable` TINYINT(1) DEFAULT 0,
  `is_cumulative` TINYINT(1) DEFAULT 0,
  `mixed_conditions` TINYINT(1) DEFAULT 0,
  `coupon_code_based` TINYINT(1) DEFAULT 0,
  `same_item` TINYINT(1) DEFAULT 0,
  `free_item` VARCHAR(255) DEFAULT NULL,
  `free_qty` DECIMAL(18,6) DEFAULT 0,
  `free_item_rate` DECIMAL(18,6) DEFAULT 0,
  `free_item_uom` VARCHAR(50) DEFAULT NULL,
  `round_free_qty` TINYINT(1) DEFAULT 0,
  `is_recursive` TINYINT(1) DEFAULT 0,
  `recurse_for` DECIMAL(18,6) DEFAULT 0,
  `apply_recursion_over` DECIMAL(18,6) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_company` (`company`),
  INDEX `idx_apply_on` (`apply_on`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pricing_rule_item_codes` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `item_code` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  INDEX `idx_parent` (`parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pricing_rule_item_groups` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `item_group` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  INDEX `idx_parent` (`parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pricing_rule_brands` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `parent` VARCHAR(255) NOT NULL,
  `brand` VARCHAR(255) DEFAULT NULL,
  `modified` DATETIME DEFAULT NULL,
  INDEX `idx_parent` (`parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_users` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `username` VARCHAR(255) NOT NULL,
  `full_name` VARCHAR(255) DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `password_salt` VARCHAR(64) DEFAULT NULL,
  `role` VARCHAR(100) DEFAULT 'Cashier',
  `pos_profile` VARCHAR(255) DEFAULT NULL,
  `warehouse` VARCHAR(255) DEFAULT NULL,
  `company` VARCHAR(255) DEFAULT NULL,
  `theme` VARCHAR(50) DEFAULT 'Default',
  `enabled` TINYINT(1) DEFAULT 1,
  `discount_limit` DECIMAL(18,6) DEFAULT 100,
  `close_bill` TINYINT(1) DEFAULT 1,
  `close_shift` TINYINT(1) DEFAULT 0,
  `allow_reprint_invoice` TINYINT(1) DEFAULT 0,
  `shift_report` TINYINT(1) DEFAULT 0,
  `view_expected_amount` TINYINT(1) DEFAULT 0,
  `allow_cancel_invoice` TINYINT(1) DEFAULT 0,
  `unsettled_invoices` TINYINT(1) DEFAULT 0,
  `apply_additional_discount` TINYINT(1) DEFAULT 0,
  `apply_standard_discount` TINYINT(1) DEFAULT 0,
  `show_edit_discount_field` TINYINT(1) DEFAULT 0,
  `edit_tax_template` TINYINT(1) DEFAULT 0,
  `allow_change_price` TINYINT(1) DEFAULT 0,
  `quotation` TINYINT(1) DEFAULT 0,
  `sale_return` TINYINT(1) DEFAULT 0,
  `local_purchase` TINYINT(1) DEFAULT 0,
  `purchase_order` TINYINT(1) DEFAULT 0,
  `purchase_invoice` TINYINT(1) DEFAULT 0,
  `stock_adjustment` TINYINT(1) DEFAULT 0,
  `stock_entry` TINYINT(1) DEFAULT 0,
  `near_expiry_items` TINYINT(1) DEFAULT 0,
  `expense` TINYINT(1) DEFAULT 0,
  `bank_drop` TINYINT(1) DEFAULT 0,
  `list_of_invoices` TINYINT(1) DEFAULT 1,
  `list_of_cancelled_invoices` TINYINT(1) DEFAULT 0,
  `list_of_errors` TINYINT(1) DEFAULT 0,
  `list_of_purchase_invoices` TINYINT(1) DEFAULT 0,
  `list_of_quotations` TINYINT(1) DEFAULT 0,
  `list_of_stock_entries` TINYINT(1) DEFAULT 0,
  `list_of_local_purchases` TINYINT(1) DEFAULT 0,
  `list_of_stock_adjustments` TINYINT(1) DEFAULT 0,
  `list_of_expense` TINYINT(1) DEFAULT 0,
  `list_of_bank_drops` TINYINT(1) DEFAULT 0,
  `invoice_settlement_report` TINYINT(1) DEFAULT 0,
  `sales_report_by_time` TINYINT(1) DEFAULT 0,
  `sales_summary_by_hour` TINYINT(1) DEFAULT 0,
  `current_stock_by_brand` TINYINT(1) DEFAULT 0,
  `stock_register` TINYINT(1) DEFAULT 0,
  `current_stock_report` TINYINT(1) DEFAULT 0,
  `modified` DATETIME DEFAULT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX `idx_username` (`username`),
  INDEX `idx_modified` (`modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_opening_shifts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) DEFAULT NULL,
  `period_start_date` DATETIME DEFAULT NULL,
  `posting_date` DATE DEFAULT NULL,
  `status` VARCHAR(20) DEFAULT 'Open',
  `company` VARCHAR(255) DEFAULT NULL,
  `pos_profile` VARCHAR(255) DEFAULT NULL,
  `user` VARCHAR(255) DEFAULT NULL,
  `pos_closing_shift` VARCHAR(100) DEFAULT NULL,
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  INDEX `idx_user` (`user`),
  INDEX `idx_status` (`status`),
  INDEX `idx_sync_status` (`sync_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_opening_entry_details` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,
  `mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `opening_amount` DECIMAL(18,6) DEFAULT 0,
  INDEX `idx_parent_id` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_closing_entries` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) DEFAULT NULL,
  `period_start_date` DATETIME DEFAULT NULL,
  `period_end_date` DATE DEFAULT NULL,
  `posting_date` DATE DEFAULT NULL,
  `posting_time` TIME DEFAULT NULL,
  `pos_opening_entry_id` INT DEFAULT NULL,
  `company` VARCHAR(255) DEFAULT NULL,
  `pos_profile` VARCHAR(255) DEFAULT NULL,
  `user` VARCHAR(255) DEFAULT NULL,
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  INDEX `idx_user` (`user`),
  INDEX `idx_pos_opening_entry_id` (`pos_opening_entry_id`),
  INDEX `idx_sync_status` (`sync_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_closing_entry_details` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,
  `mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `opening_amount` DECIMAL(18,6) DEFAULT 0,
  `expected_amount` DECIMAL(18,6) DEFAULT 0,
  `closing_amount` DECIMAL(18,6) DEFAULT 0,
  `difference` DECIMAL(18,6) DEFAULT 0,
  INDEX `idx_parent_id` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_invoices` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) DEFAULT NULL,
  `local_id` VARCHAR(100) DEFAULT NULL,
  `customer` VARCHAR(255) DEFAULT NULL,
  `customer_name` VARCHAR(255) DEFAULT NULL,
  `posting_date` DATE DEFAULT NULL,
  `posting_time` TIME DEFAULT NULL,
  `grand_total` DECIMAL(18,6) DEFAULT 0,
  `rounded_total` DECIMAL(18,6) DEFAULT 0,
  `net_total` DECIMAL(18,6) DEFAULT 0,
  `total_taxes_and_charges` DECIMAL(18,6) DEFAULT 0,
  `discount_amount` DECIMAL(18,6) DEFAULT 0,
  `additional_discount_percentage` DECIMAL(18,6) DEFAULT 0,
  `is_return` TINYINT(1) DEFAULT 0,
  `return_against` VARCHAR(255) DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'Draft',
  `pos_profile` VARCHAR(255) DEFAULT NULL,
  `pos_opening_entry_id` INT DEFAULT NULL,
  `fbr_no` VARCHAR(255) DEFAULT NULL,
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  UNIQUE INDEX `idx_local_id` (`local_id`),
  INDEX `idx_customer` (`customer`),
  INDEX `idx_posting_date` (`posting_date`),
  INDEX `idx_status` (`status`),
  INDEX `idx_sync_status` (`sync_status`),
  INDEX `idx_pos_opening_entry_id` (`pos_opening_entry_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_invoice_items` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,
  `item_code` VARCHAR(255) DEFAULT NULL,
  `item_name` VARCHAR(255) DEFAULT NULL,
  `qty` DECIMAL(18,6) DEFAULT 0,
  `rate` DECIMAL(18,6) DEFAULT 0,
  `amount` DECIMAL(18,6) DEFAULT 0,
  `discount_percentage` DECIMAL(18,6) DEFAULT 0,
  `discount_amount` DECIMAL(18,6) DEFAULT 0,
  `net_rate` DECIMAL(18,6) DEFAULT 0,
  `net_amount` DECIMAL(18,6) DEFAULT 0,
  `uom` VARCHAR(255) DEFAULT NULL,
  `item_tax_template` VARCHAR(255) DEFAULT NULL,
  `item_group` VARCHAR(255) DEFAULT NULL,
  `brand` VARCHAR(255) DEFAULT NULL,
  INDEX `idx_parent_id` (`parent_id`),
  INDEX `idx_item_code` (`item_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_invoice_payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,
  `mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `amount` DECIMAL(18,6) DEFAULT 0,
  `account` VARCHAR(255) DEFAULT NULL,
  `pos_tender_currency` VARCHAR(10) DEFAULT NULL,
  `pos_tender_amount` DECIMAL(18,6) DEFAULT NULL,
  `pos_exchange_rate` DECIMAL(21,9) DEFAULT NULL,
  INDEX `idx_parent_id` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_invoice_change_legs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,
  `mode_of_payment` VARCHAR(255) DEFAULT NULL,
  `currency` VARCHAR(10) DEFAULT NULL,
  `amount` DECIMAL(18,6) DEFAULT 0,
  `base_amount` DECIMAL(18,6) DEFAULT 0,
  `exchange_rate` DECIMAL(21,9) DEFAULT NULL,
  INDEX `idx_parent_id` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `expenses` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) DEFAULT NULL,
  `to_account` VARCHAR(255) NOT NULL,
  `posting_date` DATE NOT NULL,
  `amount` DECIMAL(18,6) NOT NULL DEFAULT 0,
  `remarks` TEXT,
  `owner` VARCHAR(255) DEFAULT NULL,
  `pos_opening_entry_id` INT DEFAULT NULL,
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  INDEX `idx_posting_date` (`posting_date`),
  INDEX `idx_sync_status` (`sync_status`),
  INDEX `idx_owner` (`owner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bank_drops` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) DEFAULT NULL,
  `to_account` VARCHAR(255) NOT NULL,
  `posting_date` DATE NOT NULL,
  `amount` DECIMAL(18,6) NOT NULL DEFAULT 0,
  `remarks` TEXT,
  `reference_no` VARCHAR(255) DEFAULT NULL,
  `reference_date` DATE DEFAULT NULL,
  `owner` VARCHAR(255) DEFAULT NULL,
  `pos_opening_entry_id` INT DEFAULT NULL,
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  INDEX `idx_posting_date` (`posting_date`),
  INDEX `idx_sync_status` (`sync_status`),
  INDEX `idx_owner` (`owner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_adjustments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) DEFAULT NULL,
  `item_code` VARCHAR(255) NOT NULL,
  `warehouse` VARCHAR(255) NOT NULL,
  `qty` DECIMAL(18,6) NOT NULL DEFAULT 0,
  `reason` TEXT,
  `owner` VARCHAR(255) DEFAULT NULL,
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  INDEX `idx_item_code` (`item_code`),
  INDEX `idx_warehouse` (`warehouse`),
  INDEX `idx_sync_status` (`sync_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `quotations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) DEFAULT NULL,
  `local_id` VARCHAR(100) DEFAULT NULL,
  `customer` VARCHAR(255) DEFAULT NULL,
  `customer_name` VARCHAR(255) DEFAULT NULL,
  `posting_date` DATE DEFAULT NULL,
  `grand_total` DECIMAL(18,6) DEFAULT 0,
  `data` LONGTEXT NOT NULL,
  `status` VARCHAR(50) DEFAULT 'Draft',
  `erp_id` VARCHAR(255) DEFAULT NULL,
  `sync_status` ENUM('pending','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  UNIQUE INDEX `idx_local_id` (`local_id`),
  INDEX `idx_customer` (`customer`),
  INDEX `idx_sync_status` (`sync_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_cache` (
  `cache_key` VARCHAR(510) NOT NULL PRIMARY KEY,
  `warehouse` VARCHAR(255) NOT NULL,
  `item_code` VARCHAR(255) NOT NULL,
  `actual_qty` DECIMAL(18,6) DEFAULT 0,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_warehouse` (`warehouse`),
  INDEX `idx_item_code` (`item_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pending_invoices` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `local_id` VARCHAR(100) NOT NULL,
  `data` LONGTEXT NOT NULL,
  `status` ENUM('pending','syncing','synced','failed','dead_letter') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  `error` TEXT,
  `retry_count` INT DEFAULT 0,
  `customer_name` VARCHAR(255) DEFAULT NULL,
  `grand_total` DECIMAL(18,6) DEFAULT 0,
  `server_name` VARCHAR(255) DEFAULT NULL,
  UNIQUE INDEX `idx_local_id` (`local_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pending_purchases` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `local_id` VARCHAR(100) NOT NULL,
  `type` ENUM('purchase_order','purchase_receipt','purchase_invoice') NOT NULL,
  `data` LONGTEXT NOT NULL,
  `status` ENUM('pending','syncing','synced','failed') DEFAULT 'pending',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `synced_at` DATETIME DEFAULT NULL,
  `error` TEXT,
  `retry_count` INT DEFAULT 0,
  `supplier_name` VARCHAR(255) DEFAULT NULL,
  `grand_total` DECIMAL(18,6) DEFAULT 0,
  `server_name` VARCHAR(255) DEFAULT NULL,
  UNIQUE INDEX `idx_local_id` (`local_id`),
  INDEX `idx_type` (`type`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sync_id_map` (
  `local_id` VARCHAR(100) NOT NULL PRIMARY KEY,
  `server_name` VARCHAR(255) NOT NULL,
  `doctype` VARCHAR(255) NOT NULL,
  `synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_server_name` (`server_name`),
  INDEX `idx_doctype` (`doctype`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pos_profile_cache` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `data` LONGTEXT NOT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `item_tax_cache` (
  `cache_key` VARCHAR(510) NOT NULL PRIMARY KEY,
  `item_code` VARCHAR(255) NOT NULL,
  `company` VARCHAR(255) NOT NULL,
  `item_tax_template` VARCHAR(255) DEFAULT NULL,
  `item_tax_map` TEXT DEFAULT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_item_code` (`item_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `deletion_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `table_name` VARCHAR(100) NOT NULL,
  `record_key` VARCHAR(255) NOT NULL,
  `doctype` VARCHAR(255) DEFAULT NULL,
  `deleted_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_table_name` (`table_name`),
  INDEX `idx_deleted_at` (`deleted_at`),
  UNIQUE INDEX `idx_table_record` (`table_name`, `record_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
