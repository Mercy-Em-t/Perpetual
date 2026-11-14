package cloud.missperpetual.tillforwarder;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

/**
 * HeartbeatReceiver.java
 * ======================
 * Self-rescheduling AlarmManager sentinel that fires every 10 minutes even during
 * deep Android Doze mode or when the screen is locked overnight.
 */
public class HeartbeatReceiver extends BroadcastReceiver {
    public static final String ACTION_PULSE = "cloud.missperpetual.tillforwarder.ACTION_HEARTBEAT";
    private static final String TAG = "SavannahHeartbeat";
    private static final long INTERVAL_MS = 10 * 60 * 1000L; // 10 minutes

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.i(TAG, "Heartbeat alarm triggered! Firing async pulse & flushing offline queue...");
        SmsReceiver.sendHeartbeatAsync(context);
        SmsReceiver.flushQueueAsync(context);
        scheduleNext(context);
    }

    public static void scheduleNext(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;

            Intent intent = new Intent(context, HeartbeatReceiver.class);
            intent.setAction(ACTION_PULSE);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(context, 808, intent, flags);

            long triggerAt = SystemClock.elapsedRealtime() + INTERVAL_MS;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
            Log.i(TAG, "Scheduled next heartbeat in 10 minutes via AlarmManager.");
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule AlarmManager heartbeat: " + e.getMessage());
        }
    }
}
