package cloud.missperpetual.tillforwarder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.util.Log;

/**
 * QuickRetryReceiver.java
 * =======================
 * Internal non-exported receiver for AlarmManager quick-retry pulses.
 * Flushes the queue with a Partial WakeLock so that the OS does not freeze
 * the background thread even if the device is in deep Doze mode.
 */
public class QuickRetryReceiver extends BroadcastReceiver {
    private static final String TAG = "SavannahQuickRetry";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        Log.i(TAG, "Autonomous QuickRetry triggered by AlarmManager!");

        final PendingResult pendingResult = goAsync();
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        final PowerManager.WakeLock wakeLock = (pm != null)
                ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SavannahTillRelay:QuickRetryWakeLock")
                : null;
        if (wakeLock != null) {
            try {
                wakeLock.acquire(30000);
            } catch (Exception ignored) {}
        }

        SmsReceiver.flushQueueAsync(context, () -> {
            try {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
            } catch (Exception ignored) {}
            try {
                pendingResult.finish();
            } catch (Exception ignored) {}
        });
    }
}
