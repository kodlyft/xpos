import frappe


def row_value(row: dict | object, key: str, default=None):
	if isinstance(row, dict):
		return row.get(key, default)
	return getattr(row, key, default)


def read_latest_on_lock() -> None:
	"""Let this transaction's row locks wait for, and read, the latest committed row.

	MariaDB 11.6+ turns ``innodb_snapshot_isolation`` on by default: locking a row that another
	transaction committed after this one's snapshot fails with error 1020 instead of returning
	the newer row. Coupon, gift card, credit and stock locks need that newer row to refuse a
	second spend with a clear message, so they switch it off until the transaction ends.
	"""
	if frappe.db.db_type != "mariadb":
		return
	setting = frappe.db.sql("SHOW SESSION VARIABLES LIKE 'innodb_snapshot_isolation'")
	if not setting or setting[0][1] != "ON":
		return  # older MariaDB, or already switched off in this transaction

	frappe.db.sql("SET SESSION innodb_snapshot_isolation = OFF")

	def restore():
		frappe.db.sql("SET SESSION innodb_snapshot_isolation = ON")

	frappe.db.after_commit.add(restore)
	frappe.db.after_rollback.add(restore)
