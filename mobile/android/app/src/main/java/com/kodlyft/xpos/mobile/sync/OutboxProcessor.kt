package com.kodlyft.xpos.mobile.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import com.kodlyft.xpos.mobile.db.Outbox
import com.kodlyft.xpos.mobile.db.XposDb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * The single queue processor. The foreground path and SyncWorker both call claimNext(), whose compare-and-set
 * update guarantees one winner per command. SAMPLE commands are never returned (and the database CHECK
 * constraint forbids them from being pending), so a prototype sale cannot reach ERPNext.
 *
 * NOT IMPLEMENTED in this milestone: there is no transport to post commands, so nothing here may report a
 * command as done. The posting contract (idempotent create_invoice(local_id), server permission re-check,
 * rejection -> needs_review, never dropping a captured sale) is in docs/mobile/architecture.md.
 */
class OutboxProcessor(private val db: XposDb, private val now: () -> Long = System::currentTimeMillis) {
    suspend fun claimNext(leaseMs: Long = 120_000, token: String = UUID.randomUUID().toString()): Outbox? = withContext(Dispatchers.IO) {
        db.write {
            val dao = db.txn()
            val candidate = dao.nextClaimable(now()) ?: return@write null
            val won = dao.claim(candidate.commandId, token, now() + leaseMs, candidate.state) == 1
            if (won) candidate.copy(state = "claimed", claimToken = token) else null
        }
    }
}

/** Placeholder for WorkManager. Never scheduled by the app yet, and it always fails honestly instead of faking success. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result =
        Result.failure(Data.Builder().putString("reason", "Server synchronisation is not implemented in the foundation milestone.").build())
}
